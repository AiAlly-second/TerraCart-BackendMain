/* Explicit local-only ten-minute soak; never part of normal CI test duration. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
const { createRedisManager } = require('../../services/redisAppClient');
const { createRuntimeDiagnostics } = require('../../services/runtimeDiagnostics');
const security = require('../../middleware/securityMiddleware');
const taskService = require('../../services/taskOccurrenceService');
const time = require('../../utils/businessTime');
const User = require('../../models/userModel');
const Employee = require('../../models/employeeModel');
const Task = require('../../models/taskModel');
const Occurrence = require('../../models/taskOccurrenceModel');
const Order = require('../../models/orderModel');
const { protect } = require('../../middleware/authMiddleware');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.equal(process.env.NODE_ENV, 'test', 'LOCAL_TEST_ONLY');
  assert.ok(process.env.SOAK_REPORT_DIR, 'SOAK_REPORT_DIR_REQUIRED');
  const reportDir = path.resolve(process.env.SOAK_REPORT_DIR);
  fs.mkdirSync(reportDir, { recursive: true });
  const samples = [], errors = [], latencies = [], counts = new Map();
  const redis = createRedisManager({ env: { REDIS_URL: 'redis://127.0.0.1:1' }, log() {} });
  const diagnostics = createRuntimeDiagnostics({ redisStatus: redis.status,
    dbState: () => mongoose.connection.readyState, intervalMs: 3600000 });
  let mongo, server, reminders = 0, normal429 = 0, abuse429 = 0, completed = false;
  try {
    mongo = await startIsolatedMongo();
    diagnostics.start();
    const cart = new mongoose.Types.ObjectId(), franchise = new mongoose.Types.ObjectId();
    const employee = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId(), abusive = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
      { _id: cart, role: 'admin', franchiseId: franchise, isActive: true, name: 'Fixture Cart' },
      { _id: user, role: 'manager', cartId: cart, cafeId: cart, employeeId: employee, isActive: true, email: 'normal@fixture.invalid' },
      { _id: abusive, role: 'manager', cartId: cart, cafeId: cart, employeeId: employee, isActive: true, email: 'abuse@fixture.invalid' },
    ]);
    await Employee.collection.insertOne({ _id: employee, cartId: cart, userId: user, isActive: true, employeeRole: 'manager', email: 'normal@fixture.invalid' });
    await Order.collection.insertMany(Array.from({ length: 500 }, (_, i) => ({
      cartId: cart, cafeId: cart, franchiseId: franchise, status: i < 40 ? 'NEW' : 'COMPLETED',
      paymentStatus: i < 40 ? 'PENDING' : 'PAID', paidAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      orderType: 'TAKEAWAY', serviceType: 'TAKEAWAY', items: [], kotLines: [{ totalAmount: 100, items: [] }],
    })));
    const dueDate = new Date(Date.now() + 120000); dueDate.setUTCSeconds(0, 0);
    const task = await Task.create({ title: 'Near future inventory fixture', cartId: cart, assignedTo: employee, dueDate,
      ...taskService.normalizeRecurrence({ dueDate, frequency: taskService.DAYS, reminderLeadMinutes: 1 }) });
    await Occurrence.init();
    const app = express(); app.use(express.json()); app.use(diagnostics.middleware);
    const previousEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    const limiter = security.createRateLimiter({ name: 'soak-read', max: 500 }); process.env.NODE_ENV = previousEnv;
    app.use(limiter); app.use(protect);
    app.get('/api/users/me', require('../../controllers/userController').getMe);
    app.get('/api/orders', require('../../controllers/orderController').getOrders);
    app.get('/api/attendance/today', require('../../controllers/attendanceController').getTodayAttendance);
    app.get('/api/dashboard/stats', require('../../controllers/dashboardController').getDashboardStats);
    app.get('/api/dashboard/activity', require('../../controllers/dashboardController').getRecentActivity);
    app.get('/api/customer-requests/pending', require('../../controllers/customerRequestController').getPendingRequests);
    app.get('/api/tasks/today', require('../../controllers/taskController').getTodayTasks);
    app.post('/api/tasks/:id/complete', require('../../controllers/taskController').completeTask);
    app.get('/api/features', require('../../controllers/featureController').getMyFeatures);
    app.get('/api/test/quota', (req, res) => res.json({ success: true }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const token = id => jwt.sign({ id: String(id) }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const normalToken = token(user), abuseToken = token(abusive);
    async function request(route, auth = normalToken, method = 'GET') {
      const at = performance.now();
      const response = await fetch(url + route, { method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ occurrenceDate: time.getBusinessDateKey() }) } : {}) });
      await response.json(); latencies.push(performance.now() - at);
      counts.set(route, (counts.get(route) || 0) + 1);
      if (response.status === 429) { if (auth === normalToken) normal429++; else abuse429++; }
      else if (response.status >= 400) errors.push({ route, status: response.status });
      return response.status;
    }
    const send = async () => { reminders++; return { success: true }; };
    taskService.startTaskReminderScheduler({ send }); taskService.startTaskReminderScheduler({ send });
    void redis.ensureConnection();
    const started = Date.now(); let iteration = 0, abuseDone = false;
    while (Date.now() - started < 600000) {
      const elapsed = Date.now() - started;
      const routes = elapsed < 120000
        ? ['/api/dashboard/stats', '/api/customer-requests/pending']
        : ['/api/dashboard/stats', '/api/orders?page=1&limit=30', '/api/attendance/today', '/api/tasks/today', '/api/features', '/api/dashboard/activity'];
      if (iteration === 0) routes.unshift('/api/users/me');
      for (const route of routes) await request(route);
      if (elapsed > 180000 && !abuseDone) {
        for (let n = 0; n < 520; n++) await request('/api/test/quota', abuseToken);
        abuseDone = true;
      }
      if (reminders && !completed) {
        assert.equal(await request(`/api/tasks/${task._id}/complete`, normalToken, 'POST'), 200);
        assert.equal((await Occurrence.findOne({ taskId: task._id, dateKey: time.getBusinessDateKey() })).status, 'completed');
        assert.equal((await taskService.ensureOccurrence(task, time.dateKeyOffset(1))).status, 'pending'); completed = true;
      }
      const sample = { ...diagnostics.snapshot(), elapsedSec: Math.round(elapsed / 1000),
        timers: process.getActiveResourcesInfo().filter(type => type === 'Timeout').length,
        quotaEntries: security.getRateLimitStoreSize(), mongooseConnections: mongoose.connections.length };
      samples.push(sample); fs.appendFileSync(path.join(reportDir, 'soak-samples.jsonl'), JSON.stringify(sample) + '\n');
      iteration++; await sleep(Math.min(elapsed < 120000 ? 60000 : 20000, Math.max(0, 600000 - (Date.now() - started))));
    }
    latencies.sort((a, b) => a - b);
    const result = { durationSec: Math.round((Date.now() - started) / 1000), isolatedDatabase: mongoose.connection.name,
      environment: 'local Mac / isolated Mongo / real HTTP controllers / simulated device cadence',
      normal429, abuse429, reminders, completed, errors, requests: Object.fromEntries(counts),
      p50ms: latencies[Math.floor(latencies.length * .5)], p95ms: latencies[Math.floor(latencies.length * .95)],
      samples: samples.length, redis: redis.status(), deviceFCMDelivery: 'not exercised' };
    fs.writeFileSync(path.join(reportDir, 'soak-result.json'), JSON.stringify(result, null, 2) + '\n');
    assert.equal(normal429, 0); assert.ok(abuse429 > 0); assert.equal(errors.length, 0);
    assert.equal(reminders, 1); assert.equal(completed, true); assert.ok(redis.status().attempts <= 7);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await taskService.stopTaskReminderScheduler(); await redis.quit(); diagnostics.stop(); security.stopRateLimitCleanup();
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect(); if (mongo) await mongo.stop();
  }
}
main().catch(error => { process.stderr.write(`LOCAL_SOAK_FAILED ${error.code || error.name}: ${error.message}\n`); process.exitCode = 1; });
