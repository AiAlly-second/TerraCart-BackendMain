const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
process.env.NODE_ENV = 'test';
const Task = require('../../models/taskModel');
const Occurrence = require('../../models/taskOccurrenceModel');
const User = require('../../models/userModel');
const Employee = require('../../models/employeeModel');
const Schedule = require('../../models/employeeScheduleModel');
const service = require('../../services/taskOccurrenceService');
const controller = require('../../controllers/taskController');
const time = require('../../utils/businessTime');
let mongo, task, cart, employee, user;
before(async () => {
  mongo = await startIsolatedMongo(); await Occurrence.init();
  cart = new mongoose.Types.ObjectId(); employee = new mongoose.Types.ObjectId(); user = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: user, cartId: cart, role: 'manager', isActive: true });
  await Employee.collection.insertOne({ _id: employee, userId: user, cartId: cart, isActive: true });
  task = await Task.create({ title: 'Check Inventory', cartId: cart, assignedTo: employee,
    dueDate: new Date('2026-10-05T05:30:00Z'), frequency: service.DAYS.slice(0, 6), ...service.normalizeRecurrence({
      dueDate: new Date('2026-10-05T05:30:00Z'), frequency: service.DAYS.slice(0, 6), reminderLeadMinutes: 5 }) });
});
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
test('11:00 IST Monday–Saturday generates 10:55 reminders and excludes Sunday', async () => {
  for (let day = 5; day <= 10; day++) {
    const dateKey = `2026-10-${String(day).padStart(2, '0')}`;
    const row = await service.ensureOccurrence(task, dateKey);
    assert.equal(row.dueAt.toISOString(), `${dateKey}T05:30:00.000Z`);
    assert.equal(row.reminderAt.toISOString(), `${dateKey}T05:25:00.000Z`);
  }
  assert.equal(await service.ensureOccurrence(task, '2026-10-11'), null);
  assert.equal(await service.ensureOccurrence(task, '2026-10-04'), null);
  assert.throws(() => service.normalizeRecurrence({ frequency: 'monday' }), RangeError);
  assert.throws(() => service.normalizeRecurrence({ weekdaysISO: [0, 8] }), RangeError);
});
test('concurrent/restarted generation is unique; Tuesday completion leaves Wednesday pending', async () => {
  await Promise.all(Array.from({ length: 30 }, () => service.ensureOccurrence(task, '2026-10-06')));
  assert.equal(await Occurrence.countDocuments({ taskId: task._id, dateKey: '2026-10-06' }), 1);
  const tuesday = new Date('2026-10-06T06:00:00Z');
  const completed = await service.completeOccurrence(task, '2026-10-06', employee, tuesday);
  assert.equal(completed.status, 'completed'); assert.ok(completed.completedAt);
  assert.equal((await Task.findById(task._id)).status, 'pending');
  assert.equal((await service.ensureOccurrence(await Task.findById(task._id), '2026-10-07')).status, 'pending');
  assert.equal((await service.completeOccurrence(task, '2026-10-06', employee, tuesday)).status, 'completed');
  await assert.rejects(service.completeOccurrence(task, '2026-10-07', employee, tuesday), RangeError);
  const view = service.viewOccurrence(task.toObject(), await service.ensureOccurrence(task, '2026-10-07'), new Date('2026-10-07T06:00:00Z'));
  assert.equal(view.status, 'late'); assert.equal(view.occurrenceDate, '2026-10-07');
});
test('reminder claim is durable, duplicate workers send once, failure retries are bounded', async () => {
  const now = new Date('2026-10-05T05:25:00Z'); let calls = 0;
  const send = async (recipient, payload) => { calls++; assert.equal(String(recipient._id), String(user));
    assert.equal(payload.data.eventId, `task:${task._id}:2026-10-05`);
    assert.equal(payload.data.recipientUserId, String(user)); return { success: true }; };
  await Promise.all([service.runTaskReminders({ now, send }), service.runTaskReminders({ now, send })]);
  assert.equal(calls, 1); await service.runTaskReminders({ now, send }); assert.equal(calls, 1);
  assert.ok((await Occurrence.findOne({ taskId: task._id, dateKey: '2026-10-05' })).reminderSentAt);
  const failing = await Task.create({ title: 'Failure probe', cartId: cart, assignedTo: employee,
    dueDate: new Date('2026-10-05T05:30:00Z'), ...service.normalizeRecurrence({ dueDate: new Date('2026-10-05T05:30:00Z') }) });
  await service.ensureOccurrence(failing, '2026-10-05'); let failedCalls = 0;
  const fail = async () => { failedCalls++; return { success: false }; };
  await service.runTaskReminders({ now, send: fail }); await service.runTaskReminders({ now, send: fail }); assert.equal(failedCalls, 1);
  for (let minute = 1; minute <= 30; minute++) await service.runTaskReminders({ now: new Date(now.getTime() + minute * 60000), send: fail });
  assert.equal(failedCalls, 5);
});
test('tenant mismatch and off-day cannot deliver reminders', async () => {
  const foreign = await Task.create({ title: 'Other tenant', cartId: new mongoose.Types.ObjectId(), assignedTo: employee,
    dueDate: new Date('2026-10-07T05:30:00Z') });
  await service.ensureOccurrence(foreign, '2026-10-07');
  await Schedule.create({ employeeId: employee, cartId: cart,
    weeklySchedule: [{ day: 'wednesday', startTime: '09:00', endTime: '17:00', isWorking: false }] });
  let calls = 0; await service.runTaskReminders({ now: new Date('2026-10-07T05:25:00Z'), send: async () => { calls++; return { success: true }; } });
  assert.equal(calls, 0);
});
test('a completed one-time task cannot send a previously pending reminder', async () => {
  const oneTime = await Task.create({ title: 'One-time check', cartId: cart, assignedTo: employee,
    dueDate: new Date('2026-10-08T05:30:00Z') });
  const row = await service.ensureOccurrence(oneTime, '2026-10-08');
  assert.equal(row.status, 'pending');
  await Task.updateOne({ _id: oneTime._id }, { $set: { status: 'completed', completedAt: new Date('2026-10-08T05:20:00Z') } });
  let calls = 0;
  await service.runTaskReminders({ now: new Date('2026-10-08T05:25:00Z'), send: async (_, payload) => {
    if (payload.data.taskId === String(oneTime._id)) calls++;
    return { success: true };
  } });
  assert.equal(calls, 0);
  assert.equal(service.occurrenceTimes(await Task.findById(oneTime._id), '2026-10-08'), null);
});
test('controller creation, per-day completion and filtered lists preserve cart scope', async () => {
  const own = { _id: user, role: 'manager', employeeId: employee, cartId: cart };
  async function call(handler, body = {}, params = {}, query = {}, actor = own) {
    let status = 200, result;
    const res = { status(code) { status = code; return this; }, json(value) { result = value; return this; } };
    await handler({ user: actor, body, params, query, app: { get() { return null; } } }, res);
    return { status, result };
  }
  const foreignEmployee = new mongoose.Types.ObjectId();
  await Employee.collection.insertOne({ _id: foreignEmployee, cartId: new mongoose.Types.ObjectId() });
  assert.equal((await call(controller.createTask, { title: 'Foreign', assignedTo: foreignEmployee, dueDate: new Date() })).status, 403);
  await Schedule.updateOne({ employeeId: employee }, { $set: { weeklySchedule: [] } });
  const dueDate = time.businessDateTime(time.getBusinessDateKey(), '11:00');
  const created = await call(controller.createTask, { title: 'Controller recurrence', dueDate,
    frequency: [time.getBusinessDayName(dueDate)], assignedTo: employee });
  assert.equal(created.status, 201, JSON.stringify(created.result));
  const id = created.result._id;
  const completed = await call(controller.completeTask, { occurrenceDate: time.getBusinessDateKey() }, { id });
  assert.equal(completed.status, 200, JSON.stringify(completed.result)); assert.equal(completed.result.status, 'completed');
  const list = await call(controller.getMyTasks, {}, {}, { status: 'completed' });
  assert.ok(list.result.some(row => String(row._id) === String(id)));
  assert.equal((await Task.findById(id)).status, 'pending');
  const admin = { _id: cart, role: 'admin' };
  const web = await call(controller.getAllTasks, {}, {}, { status: 'completed' }, admin);
  assert.ok(web.result.some(row => String(row._id) === String(id)));
  const reopened = await call(controller.updateTask, { status: 'pending', completedAt: null }, { id }, {}, admin);
  assert.equal(reopened.status, 200);
  assert.equal((await Occurrence.findOne({ taskId: id, dateKey: time.getBusinessDateKey() })).status, 'pending');
  const sunday = await service.withOccurrences([task.toObject()], { dateKey: '2026-10-11', includeNonApplicable: true });
  assert.equal(sunday.length, 1, 'admin template management retains off-day templates');
  const foreignTask = await Task.create({ title: 'Old tenant assignment', cartId: new mongoose.Types.ObjectId(), assignedTo: employee, dueDate });
  assert.equal((await call(controller.updateTask, { title: 'Unauthorized' }, { id: foreignTask._id })).status, 404);
});
test('switching token ownership removes old fallback; self-originated order cannot trigger even a legacy OS alert', async () => {
  const { upsertDeviceToken, sendNewOrderNotificationToCartStaff } = require('../../services/pushNotificationService');
  const other = new mongoose.Types.ObjectId(), token = 'test-only-device-registration';
  await User.updateOne({ _id: user }, { $set: { fcmToken: token } });
  await User.collection.insertOne({ _id: other, email: 'token-switch@test.invalid', role: 'manager', cartId: cart, isActive: true, fcmToken: token });
  await upsertDeviceToken({ userId: other, cartId: cart, token, platform: 'android', source: 'app' });
  assert.equal((await User.findById(user)).fcmToken, null);
  assert.equal((await User.findById(other)).fcmToken, token);
  const result = await sendNewOrderNotificationToCartStaff({ _id: new mongoose.Types.ObjectId(), cartId: cart,
    origin: { source: 'staff_mobile', createdByUserId: other } });
  assert.equal(result.tokenCount, 0); assert.equal(result.reason, 'TOKEN_MISSING');
});
