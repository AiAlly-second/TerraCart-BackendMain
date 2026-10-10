const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createRedisManager } = require('../services/redisAppClient');
const { createShutdownCoordinator } = require('../services/shutdownService');
const { createGetResponseCache, getRequestIp } = require('../middleware/reliabilityMiddleware');
const security = require('../middleware/securityMiddleware');
const { safeRoute } = require('../services/runtimeDiagnostics');
const origin = require('../utils/orderOrigin');
const { buildSingleMessage, buildMulticastMessage } = require('../services/pushNotificationService');
after(() => security.stopRateLimitCleanup());

async function serve(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('signed user quotas are independent behind one IP; forged forwarding and JWT cannot change identity', async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const limiter = security.createRateLimiter({ name: 'reliability-users', max: 2 });
  process.env.NODE_ENV = env;
  const app = express(); app.set('trust proxy', false); app.use(limiter);
  app.get('/api/orders', (req, res) => res.json({ ip: getRequestIp(req) }));
  const token = id => jwt.sign({ id }, process.env.JWT_SECRET || 'ci-isolated-test-only', { expiresIn: '1h' });
  process.env.JWT_SECRET ||= 'ci-isolated-test-only';
  await serve(app, async url => {
    const a = { authorization: `Bearer ${token('aaaaaaaaaaaaaaaaaaaaaaaa')}` };
    const b = { authorization: `Bearer ${token('bbbbbbbbbbbbbbbbbbbbbbbb')}` };
    assert.equal((await fetch(`${url}/api/orders`, { headers: a })).status, 200);
    assert.equal((await fetch(`${url}/api/orders`, { headers: a })).status, 200);
    const blocked = await fetch(`${url}/api/orders`, { headers: a });
    assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await blocked.json()).code, 'RATE_LIMITED');
    assert.equal((await fetch(`${url}/api/orders`, { headers: b })).status, 200);
    const forged = { authorization: 'Bearer forged', 'x-forwarded-for': '203.0.113.4' };
    const result = await fetch(`${url}/api/orders`, { headers: forged });
    assert.equal((await result.json()).ip, '127.0.0.1');
    assert.equal((await fetch(`${url}/api/orders`, { headers: { ...forged, 'x-forwarded-for': '203.0.113.5' } })).status, 200);
    assert.equal((await fetch(`${url}/api/orders`, { headers: { ...forged, 'x-forwarded-for': '203.0.113.6' } })).status, 429);
  });
});

test('public response cache replays JSON objects and bounds both bytes and entries', async () => {
  const cache = createGetResponseCache({ maxEntries: 3, maxBytes: 240, maxEntryBytes: 200, matcher: () => true });
  const app = express(); app.use(cache); let reads = 0;
  app.get('/data', (req, res) => { reads++; res.json({ value: req.query.id || 'a', text: 'x'.repeat(Number(req.query.size) || 50) }); });
  try {
    await serve(app, async url => {
      const first = await (await fetch(`${url}/data`)).json();
      const second = await (await fetch(`${url}/data`)).json();
      assert.deepEqual(second, first); assert.equal(typeof second, 'object'); assert.equal(reads, 1);
      for (let i = 0; i < 12; i++) await fetch(`${url}/data?id=${i}`);
      assert.ok(cache.stats().entries <= 3); assert.ok(cache.stats().bytes <= 240);
      await fetch(`${url}/data?id=large&size=400`);
      const before = reads; await fetch(`${url}/data?id=large&size=400`);
      assert.equal(reads, before + 1, 'oversized response must not be retained');
    });
  } finally { cache.dispose(); assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 }); }
});

function fakeClock() {
  const timers = [];
  return { timers, setTimer(fn, ms) { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cleared = true; } };
}
test('optional Redis has one in-flight connection, one recovery timer and increasing backoff', async () => {
  const clock = fakeClock(); const clients = [];
  const manager = createRedisManager({ env: { REDIS_URL: 'redis://127.0.0.1:1' }, random: () => 0, ...clock,
    log() {}, factory(options) {
      const client = new EventEmitter(); client.isReady = false;
      client.connect = async () => { throw new Error('unavailable'); };
      client.destroy = () => { client.emit('end'); };
      clients.push({ client, options }); return client;
    } });
  const first = manager.ensureConnection(); assert.equal(manager.ensureConnection(), first);
  for (let i = 0; i < 100; i++) assert.equal(manager.getClient(), null);
  await first; assert.equal(clients.length, 1);
  assert.equal(clients[0].options.disableOfflineQueue, true);
  assert.equal(clients[0].options.socket.reconnectStrategy, false);
  let pending = clock.timers.filter(t => !t.cleared); assert.equal(pending.length, 1); assert.equal(pending[0].ms, 15000);
  pending[0].cleared = true; pending[0].fn(); await manager.ensureConnection();
  pending = clock.timers.filter(t => !t.cleared); assert.equal(pending.length, 1); assert.equal(pending[0].ms, 30000);
  assert.equal(manager.status().attempts, 2);
  await manager.quit(); assert.equal(clock.timers.filter(t => !t.cleared).length, 0);
  assert.equal(manager.getClient(), null); assert.equal(await manager.ensureConnection(), null);
});

test('Redis commands have a deadline and shutdown cannot reconnect a pending client', async () => {
  const clock = fakeClock(); let resolveConnect; let destroyed = 0; let commandOptions;
  const client = new EventEmitter(); client.isReady = false;
  client.connect = () => new Promise(resolve => { resolveConnect = resolve; });
  client.destroy = () => { destroyed++; client.emit('end'); };
  client.withCommandOptions = options => { commandOptions = options; return { bounded: true }; };
  const manager = createRedisManager({ env: { REDIS_URL: 'redis://127.0.0.1:1' }, ...clock, factory: () => client, log() {} });
  const connecting = manager.ensureConnection(); await Promise.resolve();
  client.isReady = true; resolveConnect(); await connecting;
  assert.deepEqual(manager.getClient(), { bounded: true }); assert.equal(commandOptions.timeout, 500);
  await manager.quit(); assert.ok(destroyed > 0); assert.equal(manager.status().recoveryScheduled, false);
});
test('brief Redis READY flaps retain backoff; a stable minute resets the outage', async () => {
  const clock = fakeClock(); let at = 0, current;
  const manager = createRedisManager({ env: { REDIS_URL: 'redis://127.0.0.1:1' }, random: () => 0,
    now: () => at, ...clock, log() {}, factory() {
      current = new EventEmitter(); current.isReady = false;
      current.connect = async () => { current.isReady = true; }; current.destroy = () => {};
      return current;
    } });
  await manager.ensureConnection(); current.isReady = false; current.emit('error', new Error('flap'));
  let timer = clock.timers.find(row => !row.cleared); assert.equal(timer.ms, 15000);
  timer.cleared = true; timer.fn(); await manager.ensureConnection();
  current.isReady = false; current.emit('error', new Error('flap'));
  timer = clock.timers.find(row => !row.cleared); assert.equal(timer.ms, 30000);
  timer.cleared = true; timer.fn(); await manager.ensureConnection(); at += 60001;
  current.isReady = false; current.emit('error', new Error('stable then down'));
  timer = clock.timers.find(row => !row.cleared); assert.equal(timer.ms, 15000); await manager.quit();
});

test('shutdown closes HTTP and upgraded sockets once and includes hung jobs in its deadline', async () => {
  let marks = 0, httpCloses = 0, socketCloses = 0, forced = 0;
  const shutdown = createShutdownCoordinator({ timeoutMs: 25, markStopping: () => marks++,
    server: { listening: true, close(callback) { httpCloses++; callback(); }, closeAllConnections() { forced++; } },
    io: { close(callback) { socketCloses++; callback(); }, disconnectSockets() {} },
    stopJobs: [() => new Promise(() => {})] });
  const a = shutdown(), b = shutdown(); assert.equal(a, b);
  const result = await a; assert.equal(result.clean, false);
  assert.equal(marks, 1); assert.equal(httpCloses, 1); assert.equal(socketCloses, 1); assert.equal(forced, 1);
});
test('shutdown drains real HTTP and Socket.IO connections before the deadline', async () => {
  const http = require('node:http');
  const { Server } = require('socket.io'); const { io: connect } = require('socket.io-client');
  const server = http.createServer(); const io = new Server(server);
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const client = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], reconnection: false });
  try {
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const shutdown = createShutdownCoordinator({ server, io, timeoutMs: 1000 });
    assert.equal((await shutdown()).clean, true); assert.equal(server.listening, false); assert.equal(io.engine.clientsCount, 0);
  } finally { client.disconnect(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});

test('normal navigation stays under a signed user quota without sharing other users quota', async () => {
  const env = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const limiter = security.createRateLimiter({ name: 'normal-navigation', max: 500 }); process.env.NODE_ENV = env;
  const app = express(); app.use((req, res, next) => { req.user = { _id: 'device-user', cartId: 'cart' }; next(); });
  app.use(limiter); app.get('/api/:screen', (req, res) => res.json({ ok: true }));
  await serve(app, async url => {
    for (let cycle = 0; cycle < 30; cycle++) {
      for (const screen of ['dashboard', 'orders', 'attendance', 'tasks', 'settings', 'dashboard']) {
        assert.equal((await fetch(`${url}/api/${screen}`)).status, 200);
      }
    }
  });
});

test('origin comes from authentication; old orders remain compatible; Android data-only avoids OS duplicate', () => {
  assert.equal(origin.orderOriginFromRequest({ headers: { 'x-request-source': 'terra-admin-app' } }).source, 'customer');
  const trusted = origin.orderOriginFromRequest({ user: { _id: 'a', role: 'manager' }, headers: { 'x-request-source': 'terra-admin-app' } });
  assert.equal(trusted.source, 'staff_mobile'); assert.equal(origin.isSelfOriginatedOrder({ origin: trusted }, 'a'), true);
  assert.equal(origin.isSelfOriginatedOrder({ origin: trusted }, 'b'), false);
  assert.equal(origin.isSelfOriginatedOrder({ _id: 'historical' }, 'a'), false);
  const data = origin.orderCreationAlertMetadata({ _id: 'order', origin: trusted });
  assert.equal(data.eventId, 'order-created:order');
  assert.equal(buildSingleMessage('fixture-token', { title: 'Task', dataOnly: true }).notification, undefined);
  assert.equal(buildMulticastMessage(['fixture-token'], { title: 'Task' }).notification.title, 'Task');
  assert.equal(safeRoute({ method: 'GET', path: '/private-email@example.test', query: { token: 'secret' } }), 'GET /<unmatched>');
});
