const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const compression = require('compression');
const proxyaddr = require('proxy-addr');
const { isWithinDeliveryRange } = require('../utils/distanceCalculator');
const { createStaffSessionToken } = require('../utils/customerSessionTokens');

test('staff-created table bearer has server CSPRNG entropy rather than only public context/time', () => {
  const tokens = Array.from({ length: 1000 }, () => createStaffSessionToken('507f1f77bcf86cd799439011'));
  assert.ok(tokens.every(token => /^STAFF_507f1f77bcf86cd799439011_\d+_[a-f\d]{48}$/.test(token)));
  assert.equal(new Set(tokens).size, tokens.length);
});

test('delivery eligibility accepts zero coordinates and rejects invalid/missing coordinates without changing distance/charges', () => {
  assert.equal(isWithinDeliveryRange(0, 0, 0, 0, 5).isWithinRange, true);
  assert.equal(isWithinDeliveryRange(18.52, 73.85, 18.52, 73.85, 5).distance, 0);
  assert.equal(isWithinDeliveryRange(18.52, 73.85, 19.52, 73.85, 5).isWithinRange, false);
  for (const invalid of [null, undefined, NaN, Infinity, 91]) assert.equal(isWithinDeliveryRange(invalid, 73.85, 18.52, 73.85, 5).isWithinRange, false);
});

test('patched proxy subnet matcher refuses forged forwarded identity and preserves correctly scoped trust', () => {
  assert.equal(require('proxy-addr/package.json').version, '2.0.8');
  const req = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-for': '198.51.100.7' } };
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    const trust = proxyaddr.compile([subnet]);
    assert.equal(trust('203.0.113.9'), false);
    assert.equal(proxyaddr(req, trust), '203.0.113.9');
  }
  const valid = proxyaddr.compile(['::ffff:10.0.0.0/104']);
  assert.equal(valid('10.20.30.40'), true); assert.equal(valid('203.0.113.9'), false);
});

test('patched compression preserves Unicode HTTP response and gzip encoding on loopback', async t => {
  assert.equal(require('compression/package.json').version, '1.8.2');
  const app = express(); app.use(compression());
  const text = 'मराठी हिंदी English '.repeat(5000);
  app.get('/', (_req, res) => res.json({ text }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), 'gzip'); assert.equal((await response.json()).text, text);
});
