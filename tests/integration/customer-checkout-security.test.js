process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
const { createCustomerSessionRouter, SESSION_MS } = require('../../routes/customerSessionRoutes');
const Session = require('../../models/customerCheckoutSessionModel');
const Cart = require('../../models/cartModel');
const Order = require('../../models/orderModel');
const { orderRequestBinding, verifyOrderReplay, readIdempotencyKey, REPLAY_MS } = require('../../utils/orderIdempotency');
const { appendKotIdempotently, verifyKotReplay } = require('../../services/kotIdempotencyService');

const origin = 'https://customer.example.invalid';
const location = { latitude: 18.52, longitude: 73.85, address: 'मराठी हिंदी Test address' };

test('protected checkout HTTP/Mongo isolation and order retry concurrency', async t => {
  const db = await startIsolatedMongo();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  await Promise.all([Session.init(), Order.init()]);
  const cart = await Cart.create({ name: 'Isolated test store', franchiseId: new mongoose.Types.ObjectId(), cartAdminId: new mongoose.Types.ObjectId(), deliveryEnabled: true });
  const cartId = String(cart._id), otherCart = String(new mongoose.Types.ObjectId());
  let now = Date.now();
  const app = express(); app.use(express.json());
  app.use('/api/customer/session', createCustomerSessionRouter({ origins: [origin], secure: false, now: () => now }));
  app.use('/secure', createCustomerSessionRouter({ origins: [origin], now: () => now }));
  app.use('/unconfigured', createCustomerSessionRouter({ origins: [], now: () => now }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, method = 'GET', body, { cookie, csrf, requestOrigin = origin, contentType = 'application/json' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { Origin: requestOrigin, 'Content-Type': contentType, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Checkout-CSRF': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bootstrap = async (path = '/api/customer/session') => {
    const res = await request(path, 'POST', { anonymousSessionId: 'untrusted-legacy' });
    assert.equal(res.status, 200);
    const body = await res.json(), cookie = res.headers.get('set-cookie');
    assert.deepEqual(Object.keys(body).sort(), ['csrfToken', 'expiresAt']);
    return { cookie: cookie.split(';')[0], csrf: body.csrfToken, rawCookie: cookie };
  };
  const a = await bootstrap(), b = await bootstrap();
  await t.test('cookie is opaque, hashed at rest, HttpOnly/Secure/host-only; read/write origins and CSRF fail closed', async () => {
    const secure = await bootstrap('/secure');
    assert.match(secure.rawCookie, /^__Host-terra_checkout=[A-Za-z0-9_-]{43};/);
    for (const attribute of ['HttpOnly', 'Secure', 'Path=/','SameSite=Lax']) assert.ok(secure.rawCookie.includes(attribute));
    assert.ok(!secure.rawCookie.includes('Domain='));
    const record = await Session.findOne();
    assert.ok(!record.tokenHash.includes(a.cookie.split('=')[1]));
    for (const requestOrigin of ['https://customer.example.invalid.evil', '', 'null']) assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, { ...a, requestOrigin })).status, 403);
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location }, { ...a, csrf: 'bad' })).status, 403);
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location })).status, 401);
    assert.equal((await request('/api/customer/session', 'POST', {}, { contentType: 'text/plain' })).status, 415);
    assert.equal((await request('/unconfigured', 'POST', {})).status, 503);
  });
  await t.test('selection/refresh/two tabs preserve exact coordinates; another customer/cart cannot restore', async () => {
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location }, a)).status, 200);
    for (let i = 0; i < 2; i++) {
      const res = await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, a);
      assert.equal(res.status, 200); assert.deepEqual((await res.json()).location, location); assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, b)).status, 404);
    assert.equal((await request('/api/customer/session/location?cartId=' + otherCart, 'GET', undefined, a)).status, 404);
    const res = await request('/api/customer/session', 'POST', {}, a); assert.equal(res.headers.get('set-cookie'), null); assert.equal((await res.json()).csrfToken, a.csrf);
  });
  await t.test('payment location reference remains immutable across changed selection and is not an ownership credential', async () => {
    const first = await request('/api/customer/session/location', 'POST', { cartId, location }, a);
    const { locationReference } = await first.json();
    assert.match(locationReference, /^[a-f\d]{32}$/);
    await request('/api/customer/session/location', 'POST', { cartId, location: { ...location, latitude: 19 } }, a);
    const query = '/api/customer/session/location?cartId=' + cartId + '&reference=' + locationReference;
    assert.deepEqual((await (await request(query, 'GET', undefined, a)).json()).location, location);
    assert.equal((await request(query, 'GET', undefined, b)).status, 404);
    for (let i = 0; i < 9; i++) await request('/api/customer/session/location', 'POST', { cartId, location }, a);
    assert.equal((await request(query, 'GET', undefined, a)).status, 404);
    const record = await Session.findOne({ csrfToken: a.csrf }); assert.equal(record.locationVersions.length, 8);
  });
  await t.test('invalid/missing/out-of-range coordinates rejected; zero allowed; replace/remove/revoke are scoped', async () => {
    for (const invalid of [null, { ...location, latitude: null }, { ...location, latitude: '18' }, { ...location, latitude: 91 }, { ...location, longitude: -181 }, { ...location, address: '' }]) assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location: invalid }, a)).status, 400);
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location: { ...location, latitude: 0, longitude: 0 } }, a)).status, 200);
    assert.equal((await request('/api/customer/session/location', 'DELETE', {}, a)).status, 204);
    assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, a)).status, 404);
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location }, b)).status, 200);
    assert.equal((await request('/api/customer/session', 'DELETE', {}, a)).status, 204);
    assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, a)).status, 401);
    assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, b)).status, 200);
  });
  await t.test('logical expiry is enforced before asynchronous Mongo TTL cleanup', async () => {
    now += SESSION_MS + 1;
    assert.equal((await request('/api/customer/session/location?cartId=' + cartId, 'GET', undefined, b)).status, 401);
    assert.equal((await request('/api/customer/session/location', 'POST', { cartId, location }, b)).status, 401);
  });
  const req = { body: { cartId, serviceType: 'TAKEAWAY', orderType: 'takeaway', orderTypeInput: 'takeaway', items: [{ name: 'Dosa', price: 80, quantity: 1 }], idempotencyKey: 'ord-isolated-test', sessionToken: 'test-session', anonymousSessionId: 'test-guest' }, headers: {} };
  const binding = orderRequestBinding(req, 'test-guest', 'test-session');
  const data = { _id: 'ORD-ISOLATED', serviceType: 'TAKEAWAY', cartId: cart._id, sessionToken: 'test-session', anonymousSessionId: 'test-guest', idempotencyKey: req.body.idempotencyKey, idempotencyBinding: binding };
  await t.test('concurrent create has one persisted winner; same body replays, different customer/tenant/payload/operation/expiry fails', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => Order.create({ ...data, _id: `ORD-ISOLATED-${i}` })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 11000));
    const saved = await Order.findOne({ idempotencyKey: req.body.idempotencyKey });
    assert.ok(verifyOrderReplay(saved, binding).ok);
    assert.equal(verifyOrderReplay(saved, orderRequestBinding(req, 'other-guest', 'test-session')).status, 403);
    for (const body of [{ ...req.body, cartId: otherCart }, { ...req.body, items: [{ name: 'Dosa', price: 80, quantity: 2 }] }]) assert.equal(verifyOrderReplay(saved, orderRequestBinding({ ...req, body }, 'test-guest', 'test-session')).status, 409);
    assert.equal(verifyOrderReplay(saved, orderRequestBinding(req, 'test-guest', 'test-session', Date.now(), 'add-kot')).status, 409);
    assert.equal(verifyOrderReplay(saved, binding, Date.now() + REPLAY_MS + 1).status, 409);
    assert.equal(verifyOrderReplay({}, binding).status, 409);
    assert.throws(() => readIdempotencyKey({ body: { idempotencyKey: { $ne: null } }, headers: {} }));
    assert.throws(() => readIdempotencyKey({ body: { idempotencyKey: 'a' }, headers: { 'x-idempotency-key': 'b' } }));
  });
  await t.test('atomic KOT retry admits one append/winner with no duplicate print/inventory continuation', async () => {
    const saved = await Order.findOne({ idempotencyKey: req.body.idempotencyKey });
    const snapshots = await Promise.all(Array.from({ length: 8 }, () => Order.findById(saved._id)));
    const kot = { kotNumber: 1, items: req.body.items, subtotal: 80, gst: 0, totalAmount: 80 };
    const key = 'kot-isolated-test', kotBinding = orderRequestBinding(req, 'test-guest', 'test-session', Date.now(), `add-kot:${saved._id}`);
    const results = await Promise.all(snapshots.map(snapshot => appendKotIdempotently(snapshot, key, kotBinding, kot)));
    assert.equal(results.filter(result => result.replayed === false).length, 1);
    assert.equal(results.filter(result => result.replayed === true).length, 7);
    const current = await Order.findById(saved._id);
    assert.equal(current.kotLines.length, 1); assert.equal(current.kotRequestKeys.length, 1);
    assert.equal(verifyKotReplay(current, key, orderRequestBinding({ ...req, body: { ...req.body, totalAmount: 99 } }, 'test-guest', 'test-session', Date.now(), `add-kot:${saved._id}`)).status, 409);
    assert.equal(verifyKotReplay(current, key, orderRequestBinding(req, 'other-guest', 'test-session')).status, 403);
  });
  await t.test('actual order controller HTTP replay checks ownership, changed payload, expiry and historical keys', async () => {
    const { createOrder } = require('../../controllers/orderController');
    const { validateOrderType } = require('../../middleware/orderValidationMiddleware');
    app.post('/api/orders', validateOrderType, createOrder);
    assert.equal((await request('/api/orders', 'POST', req.body)).status, 200);
    assert.equal((await request('/api/orders', 'POST', { ...req.body, anonymousSessionId: 'other-guest' })).status, 403);
    assert.equal((await request('/api/orders', 'POST', { ...req.body, cartId: otherCart })).status, 409);
    assert.equal((await request('/api/orders', 'POST', { ...req.body, totalAmount: 99 })).status, 409);
    await Order.updateOne({ idempotencyKey: req.body.idempotencyKey }, { $set: { 'idempotencyBinding.expiresAt': new Date(0) } });
    assert.equal((await request('/api/orders', 'POST', req.body)).status, 409);
    await Order.updateOne({ idempotencyKey: req.body.idempotencyKey }, { $unset: { idempotencyBinding: 1 } });
    assert.equal((await request('/api/orders', 'POST', req.body)).status, 409);
    assert.equal((await request('/api/orders', 'POST', { ...req.body, idempotencyKey: {} })).status, 400);
  });
  await t.test('public payment routes require the actual owner before intent creation, read, cancellation or provider verification', async () => {
    const { Payment } = require('../../models/paymentModel');
    const { hasPrivilegedOrderAccess } = require('../../controllers/orderController');
    const saved = await Order.findOne({ idempotencyKey: req.body.idempotencyKey });
    const payment = await Payment.create({ orderId: saved._id, amount: 80, method: 'CASH', status: 'CASH_PENDING' });
    app.use('/api/payments', require('../../routes/paymentRoutes'));
    const authorized = { cookie: undefined };
    const ownerHeaders = { Origin: origin, 'x-anonymous-session-id': 'test-guest', 'x-session-token': 'test-session' };
    const url = `http://127.0.0.1:${server.address().port}/api/payments`;
    assert.equal((await request('/api/payments/create', 'POST', { orderId: saved._id })).status, 401);
    assert.equal((await request('/api/payments/order/' + saved._id + '/latest')).status, 401);
    for (const endpoint of ['cancel', 'verify-razorpay']) assert.equal((await request(`/api/payments/${payment._id}/${endpoint}`, 'POST', {})).status, 401);
    const res = await fetch(`${url}/order/${saved._id}/latest`, { headers: ownerHeaders }); assert.equal(res.status, 200);
    const foreign = await fetch(`${url}/${payment._id}/cancel`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json', 'x-anonymous-session-id': 'other-guest' }, body: '{}' }); assert.equal(foreign.status, 403);
    assert.equal((await Payment.findById(payment._id)).status, 'CASH_PENDING');
    assert.equal(await Payment.countDocuments({ orderId: saved._id }), 1);
    assert.equal(await hasPrivilegedOrderAccess({ _id: saved.cartId, role: 'admin' }, saved), true);
    assert.equal(await hasPrivilegedOrderAccess({ _id: new mongoose.Types.ObjectId(), role: 'admin' }, saved), false);
    assert.equal((await request('/api/payments/create', 'POST', { orderId: { $ne: null } }, authorized)).status, 400);
  });
});
