const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
const models = require('../../models/dailyReportModel');
const User = require('../../models/userModel');
const Employee = require('../../models/employeeModel');
const Order = require('../../models/orderModel');
const InventoryTransaction = require('../../models/costing-v2/inventoryTransactionModel');
const { Payment } = require('../../models/paymentModel');
const service = require('../../services/dailyReports/settings');
const worker = require('../../services/dailyReports/worker');
const provider = require('../../services/dailyReports/provider');
const { calculate, generate } = require('../../services/dailyReports/report');
const { render } = require('../../services/dailyReports/template');
const { calculateOrderRevenue } = require('../../utils/orderRevenue');
const { nextRun, period } = require('../../services/dailyReports/time');
const ExcelJS = require('exceljs');
const { build: buildOrdersWorkbook, HEADERS } = require('../../services/dailyReports/ordersWorkbook');
let mongo, server, origin, context, actor, manager, other, settings;
const cutoff = new Date('2026-10-09T12:30:00Z');
const objectId = () => new mongoose.Types.ObjectId();
const auth = user => ({ Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' });
before(async () => {
  process.env.JWT_SECRET = 'daily-report-isolated-tests-only';
  mongo = await startIsolatedMongo();
  await Promise.all(Object.values(models).map(m => m.init()));
  const app = express();
  app.use('/webhook', require('../../routes/resendWebhookRoutes'));
  app.use(express.json()); app.use('/reports', require('../../routes/dailyReportRoutes'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await worker.stop(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User, Employee, Order, Payment, InventoryTransaction, ...Object.values(models)].map(m => m.deleteMany({})));
  process.env.DAILY_REPORT_EMAIL_ENABLED = 'true'; process.env.RESEND_API_KEY = 'mock-only'; process.env.RESEND_FROM_EMAIL = 'TerraCart <report@example.test>';
  const franchiseId = objectId(), cartId = objectId(), managerId = objectId(), employeeId = objectId();
  await User.collection.insertMany([
    { _id: franchiseId, role: 'franchise_admin', email: 'franchise@example.test', name: 'Franchise', isActive: true },
    { _id: cartId, role: 'admin', email: 'admin@example.test', franchiseId, name: '<Cart & Co>', isApproved: true, isActive: true },
    { _id: managerId, role: 'manager', email: 'manager@example.test', cafeId: cartId, employeeId, isActive: true },
  ]);
  await Employee.collection.insertOne({ _id: employeeId, userId: managerId, cartId, employeeRole: 'manager' });
  context = { cartId, franchiseId }; actor = await User.findById(cartId); manager = await User.findById(managerId);
  other = { cartId: objectId(), franchiseId: objectId() };
  settings = await service.ensure(context);
});
test('IST next occurrence: midnight, noon, leap day, month/year boundaries and non-retroactive edits', () => {
  for (const [time, now, expected] of [
    ['18:00', '2026-10-09T12:30:01Z', '2026-10-10T12:30:00.000Z'],
    ['00:00', '2026-10-09T18:29:00Z', '2026-10-09T18:30:00.000Z'],
    ['12:00', '2026-10-09T06:00:00Z', '2026-10-09T06:30:00.000Z'],
    ['18:00', '2028-02-28T13:00:00Z', '2028-02-29T12:30:00.000Z'],
    ['18:00', '2026-12-31T13:00:00Z', '2027-01-01T12:30:00.000Z'],
  ]) assert.equal(nextRun(time, new Date(now)).toISOString(), expected);
  assert.equal(period(cutoff).start.toISOString(), '2026-10-08T18:30:00.000Z');
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(nextRun('18:00', new Date('2026-10-09T11:00:00Z')).toISOString(), '2026-10-09T12:30:00.000Z');
  } finally { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; }
});
test('strict payload/time/email validation and normalized duplicates', async () => {
  for (const address of ['', 'no-email', 'a@b', 'a\n@evil.com']) assert.throws(() => service.email(address));
  assert.equal(service.email(' A+reports@Example.COM '), 'a+reports@example.com');
  for (const body of [{ version: 0, scheduledTime: '24:00' }, { enabled: true }, { version: 0, franchiseId: other.franchiseId }, { version: 0, enabled: 'true' }]) await assert.rejects(service.update(context, actor._id, body));
  const saved = await service.add(context, actor._id, { email: 'A@example.com', version: 0 });
  assert.equal(saved.recipients[0].verificationStatus, 'verified');
  await assert.rejects(service.add(context, actor._id, { email: 'a@EXAMPLE.com', version: saved.version }), e => e.code === 'DUPLICATE_RECIPIENT');
});
test('Admin/Manager share one config; authorized second manager sees same; tenants and other roles isolated', async () => {
  const managerContext = await service.scope(manager);
  assert.equal(String(managerContext.cartId), String(context.cartId));
  const saved = await service.add(managerContext, manager._id, { email: 'owner@example.com', version: 0 });
  assert.equal((await service.get(await service.scope(actor))).recipients[0].email, 'owner@example.com');
  const second = { _id: objectId(), role: 'manager', cartId: context.cartId };
  assert.equal((await service.get(await service.scope(second))).version, saved.version);
  assert.equal((await service.get(other)).recipients.length, 0);
  await assert.rejects(service.scope(manager, other.cartId));
  await assert.rejects(service.scope({ _id: actor._id, role: 'cook' }));
  await assert.rejects(service.scope({ _id: objectId(), role: 'super_admin' }));
});
test('API authenticates RBAC and conflicts, ignores arbitrary franchiseId, shares updates', async () => {
  let response = await fetch(`${origin}/reports`, { headers: auth(actor) });
  assert.equal(response.status, 200);
  response = await fetch(`${origin}/reports`, { method: 'PUT', headers: auth(manager), body: JSON.stringify({ version: 0, scheduledTime: '20:00' }) });
  assert.equal(response.status, 200);
  assert.equal((await (await fetch(`${origin}/reports`, { headers: auth(actor) })).json()).data.scheduledTime, '20:00');
  response = await fetch(`${origin}/reports`, { method: 'PUT', headers: auth(actor), body: JSON.stringify({ version: 0, enabled: true }) });
  assert.equal(response.status, 409);
  response = await fetch(`${origin}/reports?cartId=${other.cartId}`, { headers: auth(manager) }); assert.equal(response.status, 403);
  response = await fetch(`${origin}/reports`); assert.equal(response.status, 401);
});
test('simultaneous settings edits: one winner, one conflict, one schedule', async () => {
  const results = await Promise.allSettled([service.update(context, actor._id, { version: 0, scheduledTime: '20:00' }), service.update(context, manager._id, { version: 0, enabled: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409);
  assert.equal(await models.Settings.countDocuments({ cartId: context.cartId }), 1);
});
async function verifiedDue() {
  const value = await service.add(context, actor._id, { email: 'owner@example.com', version: 0 });
  await models.Settings.updateOne({ _id: settings._id }, { $set: { enabled: true, nextRunAt: cutoff, 'recipients.0.verificationStatus': 'verified' } });
  return value.recipients[0];
}
test('saved recipients send without an OTP, and test sends stay rate limited', async () => {
  const value = await service.add(context, actor._id, { email: 'owner@example.com', version: 0 });
  assert.equal(value.recipients[0].verificationStatus, 'verified');
  assert.equal(await models.Delivery.countDocuments({ kind: 'verification' }), 0);
  const requestId = crypto.randomUUID(); await service.test(context, actor._id, { version: value.version, requestId });
  await service.test(context, actor._id, { version: value.version, requestId });
  assert.equal(await models.Delivery.countDocuments({ kind: 'test' }), 1);
  const queued = await models.Delivery.findOne({ kind: 'test' }).lean();
  assert.equal(queued.payload.from, 'TerraCart <report@example.test>');
  await assert.rejects(service.test(context, actor._id, { version: value.version, requestId: crypto.randomUUID() }), e => e.statusCode === 429);
});
test('parallel scheduler execution and workers send once, API acceptance is not delivery', async () => {
  await verifiedDue(); await Promise.all([worker.materialize(cutoff), worker.materialize(cutoff)]);
  assert.equal(await models.Occurrence.countDocuments({}), 1); assert.equal(await models.Delivery.countDocuments({}), 1);
  let sends = 0; const send = async () => { sends++; return 'provider-1'; };
  await Promise.all([worker.dispatch(cutoff, send), worker.dispatch(cutoff, send)]);
  assert.equal(sends, 1); assert.equal((await models.Delivery.findOne()).status, 'accepted');
  await worker.dispatch(new Date(cutoff.getTime() + 2000), send); assert.equal(sends, 1);
  assert.equal((await service.get(context)).lastSuccessfulDelivery, null);
});
test('temporary failure/restart retries frozen payload, cutoff and stable idempotency', async () => {
  await verifiedDue(); await worker.materialize(cutoff);
  let first;
  await worker.dispatch(cutoff, async (payload, key) => { first = { payload, key }; throw Object.assign(new Error('temporary'), { retryable: true, code: 'TEMPORARY' }); });
  const item = await models.Delivery.findOne().lean(); assert.equal(item.status, 'retry');
  await worker.dispatch(new Date(cutoff.getTime() + 60000), async (payload, key) => { assert.deepEqual(payload, first.payload); assert.equal(key, first.key); return 'retry-id'; });
  assert.equal((await models.Delivery.findOne()).status, 'accepted'); assert.equal(item.reportPeriodEnd.toISOString(), cutoff.toISOString());
});
test('crashed lease recovery is bounded by idempotency retention, never resends after 23h', async () => {
  await verifiedDue(); await worker.materialize(cutoff);
  await models.Delivery.updateOne({}, { $set: { status: 'sending', firstAttemptAt: cutoff, leaseUntil: cutoff } });
  let sends = 0; await worker.dispatch(new Date(cutoff.getTime() + 24 * 3600000), async () => { sends++; });
  assert.equal(sends, 0); assert.equal((await models.Delivery.findOne()).status, 'needs_review');
});
test('disable and recipient deletion stop queued sends; stale edits cannot overwrite', async () => {
  const recipient = await verifiedDue(); await worker.materialize(cutoff);
  await service.update(context, actor._id, { version: 1, enabled: false });
  let sends = 0; await worker.dispatch(cutoff, async () => { sends++; }); assert.equal(sends, 0);
  const latest = await service.get(context); await service.remove(context, manager._id, recipient.id, latest.version);
  assert.equal((await service.get(context)).recipients.length, 0);
  await assert.rejects(service.update(context, actor._id, { version: latest.version, enabled: true }), e => e.statusCode === 409);
});
test('outage recovery does not change cutoff; old missed occurrences are skipped', async () => {
  await verifiedDue(); await worker.materialize(new Date(cutoff.getTime() + 2 * 86400000));
  assert.equal((await models.Occurrence.findOne()).status, 'skipped_downtime'); assert.equal(await models.Delivery.countDocuments({}), 0);
});
test('webhooks dedupe, survive out-of-order delivery/sent and suppress bounced recipients', async () => {
  await verifiedDue(); await worker.materialize(cutoff); await worker.dispatch(cutoff, async () => 'webhook-id');
  const event = type => ({ type, created_at: cutoff.toISOString(), data: { email_id: 'webhook-id' } });
  await worker.receiveEvent(event('email.delivered'), 'event-1'); await worker.receiveEvent(event('email.delivered'), 'event-1');
  await worker.receiveEvent(event('email.sent'), 'event-2'); assert.equal((await models.Delivery.findOne()).status, 'delivered');
  assert.equal(await models.WebhookEvent.countDocuments({}), 2);
  assert.ok((await service.get(context)).lastSuccessfulDelivery);
  await worker.receiveEvent(event('email.complained'), 'event-3');
  assert.equal((await models.Settings.findOne()).recipients[0].verificationStatus, 'suppressed');
});
test('webhook raw-body signature verification rejects forged requests and accepts valid signed payload', async () => {
  const secret = crypto.randomBytes(32); process.env.RESEND_WEBHOOK_SECRET = `whsec_${secret.toString('base64')}`;
  const payload = JSON.stringify({ type: 'email.sent', created_at: cutoff.toISOString(), data: { email_id: 'unknown-id' } });
  const id = 'event-signature', timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${payload}`).digest('base64');
  const response = await fetch(`${origin}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, body: payload });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${origin}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })).status, 400);
  assert.throws(() => provider.verify(Buffer.from(`${payload} `), { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }));
});
test('actual database report matches shared dashboard calculation, excludes failed/cancelled, boundaries and missing costs', async () => {
  const start = period(cutoff).start;
  const orders = [
    { _id: 'paid-order', cartId: context.cartId, franchiseId: context.franchiseId, status: 'COMPLETED', paymentStatus: 'PAID', paymentMode: 'CASH', createdAt: start, paidAt: start,
      kotLines: [{ subtotal: 100, gst: 5, totalAmount: 105 }], selectedAddons: [{ price: 10, quantity: 2 }], officeDeliveryCharge: 7 },
    { _id: 'failed-order', cartId: context.cartId, franchiseId: context.franchiseId, status: 'NEW', paymentStatus: 'FAILED', createdAt: start, kotLines: [{ subtotal: 50, gst: 0, totalAmount: 50 }] },
    { _id: 'boundary-order', cartId: context.cartId, franchiseId: context.franchiseId, status: 'COMPLETED', paymentStatus: 'PAID', createdAt: cutoff, paidAt: cutoff, kotLines: [{ totalAmount: 999 }] },
    { _id: 'other-tenant', cartId: other.cartId, franchiseId: other.franchiseId, status: 'COMPLETED', paymentStatus: 'PAID', createdAt: start, paidAt: start, kotLines: [{ totalAmount: 999 }] },
  ];
  await Order.collection.insertMany(orders);
  await Payment.collection.insertMany([{ orderId: 'paid-order', status: 'PAID', method: 'CASH', amount: 132, paidAt: start }, { orderId: 'failed-order', status: 'FAILED', method: 'ONLINE', amount: 50, paidAt: start }]);
  const report = await generate(context, start, cutoff, cutoff);
  assert.equal(report.sales, calculateOrderRevenue(orders[0])); assert.equal(report.collected, 132);
  assert.equal(report.orders.total, 2); assert.equal(report.cogs, null); assert.equal(report.grossProfit, null);
  assert.equal(report.refunds, null); assert.equal(report.payments.Cash, 132);
  const returned = calculate([{ ...orders[0], returnedAt: start }], [], start, cutoff); assert.equal(returned.sales, 0); assert.equal(returned.orders.returned, 1);
});
test('daily email attaches the Orders Excel for that cart and period', async () => {
  const start = period(cutoff).start;
  await Order.collection.insertMany([
    { _id: 'sheet-order', cartId: context.cartId, franchiseId: context.franchiseId, status: 'COMPLETED', serviceType: 'DINE_IN',
      tableNumber: '4', customerName: 'Asha', customerMobile: '9999999999', createdAt: start, updatedAt: start,
      kotLines: [{ items: [{ name: 'Tea', quantity: 2, price: 15000, returned: false }, { name: 'Returned', quantity: 1, price: 5000, returned: true }], subtotal: 1, gst: 0, totalAmount: 1 }],
      selectedAddons: [{ name: 'Extra', price: 20, quantity: 1 }] },
    { _id: 'other-sheet', cartId: other.cartId, franchiseId: other.franchiseId, status: 'NEW', createdAt: start,
      kotLines: [{ items: [{ name: 'X', quantity: 1, price: 100, returned: false }], subtotal: 1, gst: 0, totalAmount: 1 }] },
    { _id: 'late-sheet', cartId: context.cartId, franchiseId: context.franchiseId, status: 'NEW', createdAt: cutoff,
      kotLines: [{ items: [{ name: 'Late', quantity: 1, price: 100, returned: false }], subtotal: 1, gst: 0, totalAmount: 1 }] },
  ]);
  const file = await buildOrdersWorkbook({ cartId: context.cartId, franchiseId: context.franchiseId, start, end: cutoff, generatedAt: cutoff });
  assert.equal(file.filename, 'orders-report-2026-10-09.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(file.content, 'base64'));
  const sheet = workbook.getWorksheet('Orders');
  let headerRow = 0;
  sheet.eachRow((row, number) => { if (row.getCell(1).value === 'Order ID') headerRow = number; });
  assert.deepEqual(sheet.getRow(headerRow).values.slice(1), HEADERS);
  const data = sheet.getRow(headerRow + 1).values.slice(1);
  assert.equal(data[0], 'sheet-order');
  assert.equal(data[1], `INV-${new Date(start).toISOString().slice(0, 10).replace(/-/g, '')}-${'sheet-order'.slice(-6).toUpperCase()}`);
  assert.equal(data[4], 'COMPLETED');
  assert.equal(data[5], 'Dine-In');
  assert.equal(data[7], '4');
  assert.equal(data[9], 'Asha');
  assert.equal(data[10], '9999999999');
  assert.equal(data[11], 2);
  assert.equal(Number(data[12]), 320);
  assert.equal(sheet.getRow(headerRow + 2).getCell(1).value, null);
  await verifiedDue();
  await worker.materialize(cutoff);
  const queued = await models.Delivery.findOne({ kind: 'scheduled' }).lean();
  assert.equal(queued.payload.attachments[0].filename, file.filename);
  assert.equal(queued.payload.attachments[0].contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(queued.payload.text, /Orders spreadsheet attached: orders-report-2026-10-09\.xlsx/);
  const attached = new ExcelJS.Workbook();
  await attached.xlsx.load(Buffer.from(queued.payload.attachments[0].content, 'base64'));
  assert.equal(attached.getWorksheet('Orders').getRow(headerRow + 1).getCell(1).value, 'sheet-order');
});
test('empty days render zero sales, unavailable profit, escaped branded HTML and plain text', () => {
  const report = { ...calculate([], [], period(cutoff).start, cutoff), cartName: '<script>&evil', periodEnd: cutoff, generatedAt: cutoff };
  const content = render(report); assert.equal(report.sales, 0); assert.equal(report.grossProfit, null);
  assert.ok(content.html.includes('&lt;script&gt;&amp;evil')); assert.ok(!content.html.includes('<script>'));
  assert.match(content.text, /Snapshot/); assert.match(content.text, /Profit unavailable/); assert.match(content.text, /₹0.00/);
});
test('recipient limit, suppression and remove/re-add keep one identity without an OTP', async () => {
  let value = await service.get(context);
  for (let i = 0; i < 10; i++) value = await service.add(context, actor._id, { version: value.version, email: `recipient${i}@example.test` });
  await assert.rejects(service.add(context, actor._id, { version: value.version, email: 'eleven@example.test' }), /Maximum/);
  const suppressedId = value.recipients[0].id;
  const otherId = value.recipients[1].id;
  await models.Settings.updateOne({ _id: settings._id }, { $set: { 'recipients.0.verificationStatus': 'suppressed' } });
  value = await service.remove(context, actor._id, suppressedId, value.version);
  await assert.rejects(service.add(context, actor._id, { version: value.version, email: 'recipient0@example.test' }), /suppressed/);
  value = await service.remove(context, actor._id, otherId, value.version);
  value = await service.add(context, actor._id, { version: value.version, email: 'recipient1@example.test' });
  assert.equal(value.recipients.find(r => r.email === 'recipient1@example.test').verificationStatus, 'verified');
  assert.equal(await models.Delivery.countDocuments({ kind: 'verification' }), 0);
});
test('schedule edits cancel unclaimed old jobs; an in-flight accepted send is never duplicated', async () => {
  await verifiedDue(); await worker.materialize(cutoff);
  let resume; const started = new Promise(resolve => { resume = resolve; }); let sends = 0;
  const sending = worker.dispatch(cutoff, async () => { sends++; await started; return 'in-flight'; });
  while (!(await models.Delivery.findOne()).attempts) await new Promise(resolve => setTimeout(resolve, 5));
  await service.update(context, actor._id, { version: 1, scheduledTime: '20:00' }, cutoff);
  resume(); await sending;
  await worker.dispatch(new Date(cutoff.getTime() + 5000), async () => { sends++; });
  assert.equal(sends, 1); assert.equal((await models.Delivery.findOne()).providerMessageId, 'in-flight');
});
test('429 Retry-After respected, permanent rejection is not retried', async () => {
  await verifiedDue(); await worker.materialize(cutoff);
  await worker.dispatch(cutoff, async () => { throw Object.assign(new Error('rate'), { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 120000 }); });
  const value = await models.Delivery.findOne(); assert.equal(value.nextAttemptAt.toISOString(), '2026-10-09T12:32:00.000Z');
  await worker.dispatch(new Date(cutoff.getTime() + 120000), async () => { throw Object.assign(new Error('sender'), { code: 'INVALID_SENDER', retryable: false }); });
  assert.equal((await models.Delivery.findOne()).status, 'needs_review');
});
test('partial/split collections on earlier orders are counted once; item cost changes do not rewrite historical consumption', async () => {
  const start = period(cutoff).start;
  await Order.collection.insertOne({ _id: 'older-partial', cartId: context.cartId, franchiseId: context.franchiseId,
    status: 'COMPLETED', paymentStatus: 'PENDING', createdAt: new Date(start.getTime() - 86400000), kotLines: [{ totalAmount: 100 }] });
  await Payment.collection.insertMany([
    { orderId: 'older-partial', status: 'PAID', method: 'CASH', amount: 25, paidAt: start },
    { orderId: 'older-partial', status: 'PAID', method: 'ONLINE', amount: 15, paidAt: start },
    { orderId: 'older-partial', status: 'FAILED', method: 'ONLINE', amount: 60, paidAt: start },
  ]);
  let report = await generate(context, start, cutoff, cutoff);
  assert.equal(report.collected, 40); assert.equal(report.sales, 0); assert.equal(report.orders.total, 0);
  await Order.collection.updateOne({ _id: 'older-partial' }, { $set: { paymentStatus: 'PAID', paidAt: start } });
  await InventoryTransaction.collection.insertOne({ cartId: context.cartId, refType: 'order', refId: 'older-partial', type: 'OUT', date: start, costAllocated: 30 });
  report = await generate(context, start, cutoff, cutoff);
  assert.equal(report.recordedIngredientCost, 30); assert.equal(report.grossProfit, null);
});
test('migration dry-run makes no writes; repeat apply is additive and DB rejects duplicate embedded addresses', async () => {
  const { migrate } = require('../../scripts/migrate-daily-reports');
  assert.equal((await migrate()).dryRun, true);
  await migrate({ apply: true }); await migrate({ apply: true });
  await service.add(context, actor._id, { email: 'owner@example.test', version: 0 });
  await assert.rejects(models.Settings.collection.updateOne({ _id: settings._id }, {
    $push: { recipients: { _id: objectId(), email: 'OWNER@example.test', enabled: true } },
  }), e => e.code === 121);
});
test('maintained Resend SDK passes idempotency/timeout and classifies rate limits without network delivery', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.equal(String(url), 'https://api.resend.com/emails');
      assert.equal(new Headers(options.headers).get('Idempotency-Key'), 'sdk-test-identity');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body).to, ['verified@example.test']);
      return new Response(JSON.stringify({ id: 'sdk-accepted' }), { status: 200 });
    };
    process.env.RESEND_FROM_EMAIL = 'noreply@terracart.in'; process.env.RESEND_FROM_NAME = 'TerraCart';
    assert.equal(provider.sender(), 'TerraCart <noreply@terracart.in>');
    const payload = { from: provider.sender(), to: ['verified@example.test'], subject: 'Test only', text: 'No financial data', html: '<p>No financial data</p>' };
    assert.equal(await provider.send(payload, 'sdk-test-identity'), 'sdk-accepted');
    global.fetch = async () => new Response(JSON.stringify({ name: 'rate_limit_exceeded', statusCode: 429, message: 'Rate limited' }), { status: 429, headers: { 'retry-after': '3' } });
    await assert.rejects(provider.send(payload, 'sdk-test-identity'), e => e.retryable && e.retryAfterMs === 3000);
    provider.setReadinessError('REPORT_SCHEDULER_NOT_READY');
    assert.equal(provider.configured(), false);
    await assert.rejects(provider.send(payload, 'sdk-test-identity'), e => e.code === 'PROVIDER_NOT_CONFIGURED');
  } finally { global.fetch = originalFetch; provider.setReadinessError(null); }
});
