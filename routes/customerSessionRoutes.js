const express = require('express');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const Session = require('../models/customerCheckoutSessionModel');
const Cart = require('../models/cartModel');

const SESSION_MS = 60 * 60 * 1000;
const COOKIE = '__Host-terra_checkout';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const validCart = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const validCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Test factories use the same router with isolated Mongo, never production env.
function createCustomerSessionRouter({ origins, sameSite = 'lax', secure = true, now = Date.now } = {}) {
  const router = express.Router();
  const allowed = origins || String(process.env.CUSTOMER_SESSION_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (origins === undefined) sameSite = String(process.env.CUSTOMER_SESSION_SAME_SITE || 'lax').toLowerCase();
  const configured = allowed.length > 0 && allowed.every(value => {
    try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:')); } catch { return false; }
  }) && ['lax', 'strict', 'none'].includes(sameSite) && (secure || process.env.NODE_ENV === 'test');
  const cookieOptions = { httpOnly: true, secure, sameSite, path: '/', maxAge: SESSION_MS };
  const cookieName = secure ? COOKIE : 'terra_checkout_test_only';

  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Origin');
    if (!configured) return res.status(503).json({ message: 'Protected checkout session origins are not configured.' });
    if (process.env.NODE_ENV === 'production' && !req.secure) return res.status(400).json({ message: 'HTTPS is required for protected checkout sessions.' });
    if (!allowed.includes(req.get('origin'))) return res.status(403).json({ message: 'Checkout origin is not allowed.' });
    // No wildcard, reflection, body/query token, legacy ID or referer fallback.
    res.set('Access-Control-Allow-Origin', req.get('origin'));
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Checkout-CSRF');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ message: 'JSON is required.' });
    try {
      const matches = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName}=`));
      const token = matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
      req.checkoutSession = /^[A-Za-z0-9_-]{43}$/.test(token)
        ? await Session.findOne({ tokenHash: hash(token), expiresAt: { $gt: new Date(now()) } }) : null;
      if (req.path === '/' && req.method === 'POST') {
        // Bootstrap neither changes an existing session nor adopts legacy IDs.
        return next();
      }
      if (!req.checkoutSession) return res.status(401).json({ message: 'Checkout session expired or cookies are unavailable. Please select your location again.' });
      if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.get('x-checkout-csrf'), req.checkoutSession.csrfToken)) return res.status(403).json({ message: 'Invalid checkout CSRF token.' });
      next();
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      let session = req.checkoutSession;
      if (!session) {
        const token = random();
        session = await Session.create({ tokenHash: hash(token), csrfToken: random(), expiresAt: new Date(now() + SESSION_MS) });
        res.cookie(cookieName, token, cookieOptions);
      }
      res.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch (error) { next(error); }
  });

  router.get('/location', (req, res) => {
    const reference = req.query.reference;
    if (reference !== undefined && (typeof reference !== 'string' || !/^[a-f\d]{32}$/.test(reference))) return res.status(400).json({ message: 'Invalid location reference.' });
    const location = reference ? req.checkoutSession.locationVersions?.find(entry => entry.reference === reference) : req.checkoutSession.location;
    if (!validCart(req.query.cartId)) return res.status(400).json({ message: 'A valid cart is required.' });
    if (!location?.cartId || String(location.cartId) !== req.query.cartId || !(location.expiresAt > new Date(now()))) return res.status(404).json({ message: 'No current location for this cart. Please select your location again.' });
    res.json({ location: { latitude: location.latitude, longitude: location.longitude, address: location.address }, locationReference: location.reference, expiresAt: location.expiresAt });
  });

  router.post('/location', async (req, res, next) => {
    const { cartId, location } = req.body || {};
    if (!validCart(cartId) || !validCoordinate(location?.latitude, 90) || !validCoordinate(location?.longitude, 180) || typeof location?.address !== 'string' || !location.address.trim() || location.address.length > 1000) return res.status(400).json({ message: 'A cart, valid coordinates and delivery address are required.' });
    try {
      if (!await Cart.exists({ _id: cartId, isActive: true })) return res.status(404).json({ message: 'Store is unavailable.' });
      const saved = { reference: randomBytes(16).toString('hex'), cartId, latitude: location.latitude, longitude: location.longitude, address: location.address.trim(), expiresAt: req.checkoutSession.expiresAt };
      // Conditional atomic write prevents stale tabs from resurrecting logout/expiry.
      const updated = await Session.updateOne({ _id: req.checkoutSession._id, expiresAt: { $gt: new Date(now()) } }, { $set: { location: saved }, $push: { locationVersions: { $each: [saved], $slice: -8 } } });
      if (!updated.matchedCount) return res.status(401).json({ message: 'Checkout session expired. Please select your location again.' });
      res.json({ location: { latitude: saved.latitude, longitude: saved.longitude, address: saved.address }, locationReference: saved.reference, expiresAt: saved.expiresAt });
    } catch (error) { next(error); }
  });

  router.delete('/location', async (req, res, next) => {
    try {
      await Session.updateOne({ _id: req.checkoutSession._id }, { $unset: { location: 1, locationVersions: 1 } });
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.delete('/', async (req, res, next) => {
    try {
      // Explicit revocation applies only to this protected checkout session.
      await Session.deleteOne({ _id: req.checkoutSession._id });
      res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createCustomerSessionRouter, validCoordinate, SESSION_MS };
