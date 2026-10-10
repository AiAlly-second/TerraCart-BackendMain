const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Employee = require('../../models/employeeModel');
const { resolveOperationalScope } = require('../../utils/costing-v2/inventoryScope');
const { Settings, Delivery, Audit, Gate } = require('../../models/dailyReportModel');
const { nextRun, validTime, period } = require('./time');
const { generate } = require('./report');
const { render } = require('./template');
const provider = require('./provider');
const error = (message, status = 400, code = 'INVALID_REPORT_SETTINGS') => Object.assign(new Error(message), { statusCode: status, code });
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function email(value) {
  if (typeof value !== 'string') throw error('Valid email required');
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('.') || normalized.includes('..') || normalized.includes('.@')) throw error('Valid email required');
  if (normalized.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(normalized)) throw error('Valid email required');
  return normalized;
}
async function scope(user, requestedCartId) {
  if (user?.isActive === false) throw error('Account is inactive', 403, 'REPORT_ACCESS_DENIED');
  const role = user?.role === 'cart_admin' ? 'admin' : user?.role;
  let effectiveRole = role;
  if (role === 'employee') {
    const employee = await Employee.findOne({ userId: user._id }).select('employeeRole').lean();
    effectiveRole = employee?.employeeRole;
  }
  if (!['admin', 'manager', 'franchise_admin', 'super_admin'].includes(effectiveRole)) throw error('Daily reports are restricted to cart administrators and managers', 403, 'REPORT_ACCESS_DENIED');
  if (['franchise_admin', 'super_admin'].includes(effectiveRole) && !requestedCartId) throw error('An explicit authorized cart is required', 400);
  // Other roles cannot select a different cart; the existing resolver verifies ownership.
  return resolveOperationalScope({ _id: user._id, employeeId: user.employeeId,
    cartId: user.cartId, cafeId: user.cafeId, role: effectiveRole },
  { cartId: requestedCartId || null, operation: 'daily-report-settings' });
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
async function ensure(context) {
  await Settings.init();
  const indexes = await Settings.collection.indexes();
  if (!indexes.some(index => index.unique && index.key.cartId === 1 && Object.keys(index.key).length === 1)) {
    throw error('Daily report database indexes require migration', 503, 'REPORT_SCHEMA_NOT_READY');
  }
  try {
    return await Settings.findOneAndUpdate({ cartId: context.cartId, franchiseId: context.franchiseId },
      { $setOnInsert: { cartId: context.cartId, franchiseId: context.franchiseId, nextRunAt: nextRun('18:00') } },
      { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await Settings.findOne({ cartId: context.cartId, franchiseId: context.franchiseId }).lean();
    if (!existing) throw error('Cart assignment changed; review report settings', 409);
    return existing;
  }
}
function publicSettings(row) {
  return { id: String(row._id), enabled: row.enabled, scheduledTime: row.scheduledTime,
    timezone: row.timezone, reportPeriodMode: row.reportPeriodMode, reportOptions: row.reportOptions,
    version: row.version, nextRunAt: row.enabled ? row.nextRunAt : null,
    providerConfigured: provider.configured(), recipients: row.recipients.filter(r => r.enabled).map(r => ({
      id: String(r._id), email: r.email, enabled: r.enabled, verificationStatus: r.verificationStatus,
    })) };
}
async function get(context) {
  const row = await ensure(context);
  const filter = { settingsId: row._id, kind: { $ne: 'verification' } };
  const [latest, lastDelivered, lastAttempt] = await Promise.all([
    Delivery.findOne(filter).sort({ createdAt: -1 }).lean(),
    Delivery.findOne({ ...filter, deliveredAt: { $ne: null } }).sort({ deliveredAt: -1 }).lean(),
    Delivery.findOne({ ...filter, attemptedAt: { $ne: null } }).sort({ attemptedAt: -1 }).lean(),
  ]);
  return { ...publicSettings(row), lastAttemptAt: lastAttempt?.attemptedAt || null,
    lastSuccessfulDelivery: lastDelivered?.deliveredAt || null, deliveryStatus: latest?.status || 'not_sent',
    lastError: latest?.lastError || null };
}
function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['version', 'enabled', 'scheduledTime', 'reportOptions'].includes(k))) throw error('Unknown settings field');
  if (!Number.isInteger(body.version) || body.version < 0) throw error('Settings version required');
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw error('Enabled must be boolean');
  if ('scheduledTime' in body && !validTime(body.scheduledTime)) throw error('Time must be HH:mm in IST');
  if ('reportOptions' in body && (!Array.isArray(body.reportOptions) || !body.reportOptions.length ||
    new Set(body.reportOptions).size !== body.reportOptions.length || body.reportOptions.some(v => !['orders', 'sales', 'payments', 'profit'].includes(v)))) throw error('Invalid report contents');
}
async function mutate(context, actor, version, action, change) {
  if (!Number.isInteger(version) || version < 0) throw error('Settings version required');
  const initial = await ensure(context);
  await transaction(async session => {
    const row = await Settings.findOne({ _id: initial._id, franchiseId: context.franchiseId, version }).session(session);
    if (!row) throw error('Settings changed elsewhere. Refresh before saving.', 409, 'REPORT_VERSION_CONFLICT');
    const previous = publicSettings(row);
    await change(row, session);
    row.version++; row.updatedBy = actor;
    await row.save({ session });
    const next = publicSettings(row);
    // Audit metadata excludes addresses, verification tokens and provider secrets.
    const metadata = value => ({ enabled: value.enabled, scheduledTime: value.scheduledTime,
      version: value.version, reportOptions: value.reportOptions, recipientCount: value.recipients.length });
    await Audit.create([{ settingsId: row._id, actor, action, previous: metadata(previous), next: metadata(next) }], { session });
  });
  return get(context);
}
async function update(context, actor, body, now = new Date()) {
  validatePatch(body);
  return mutate(context, actor, body.version, 'settings.update', async (row, session) => {
    if (body.enabled === false || ('scheduledTime' in body && body.scheduledTime !== row.scheduledTime)) {
      await Delivery.updateMany({ settingsId: row._id, kind: 'scheduled', status: { $in: ['queued', 'retry'] } },
        { $set: { status: 'cancelled', lastError: 'SCHEDULE_CHANGED' }, $unset: { payload: 1 } }, { session });
    }
    if (('enabled' in body && body.enabled !== row.enabled) || ('scheduledTime' in body && body.scheduledTime !== row.scheduledTime)) {
      row.nextRunAt = nextRun(body.scheduledTime || row.scheduledTime, now);
    }
    for (const key of ['enabled', 'scheduledTime', 'reportOptions']) if (key in body) row[key] = body[key];
  });
}
async function add(context, actor, body) {
  const address = email(body.email);
  return mutate(context, actor, body.version, 'recipient.add', row => {
    if (row.recipients.filter(r => r.enabled).length >= 10) throw error('Maximum 10 recipients');
    if (row.recipients.some(r => r.email === address && r.enabled)) throw error('Recipient already exists', 409, 'DUPLICATE_RECIPIENT');
    // Restore the same tombstone to retain suppression and identity across remove/re-add.
    const old = row.recipients.find(r => r.email === address);
    if (old?.verificationStatus === 'suppressed') throw error('Recipient suppressed after bounce or complaint', 409);
    // Saved directly for authorized Admin/Manager. Bounce suppression is separate from sender-domain DNS.
    if (old) { old.enabled = true; old.verificationStatus = 'verified'; old.verifiedAt = new Date(); old.tokenHash = undefined; }
    else row.recipients.push({ email: address, verificationStatus: 'verified', verifiedAt: new Date() });
  });
}
async function remove(context, actor, id, version) {
  return mutate(context, actor, version, 'recipient.remove', async (row, session) => {
    const recipient = row.recipients.id(id);
    if (!recipient || !recipient.enabled) throw error('Recipient not found', 404);
    recipient.enabled = false; recipient.tokenHash = undefined;
    await Delivery.updateMany({ settingsId: row._id, recipientId: recipient._id, status: { $in: ['queued', 'retry'] } },
      { $set: { status: 'cancelled', lastError: 'RECIPIENT_REMOVED' }, $unset: { payload: 1 } }, { session });
  });
}
async function throttle(key, milliseconds, session, now = new Date()) {
  try { await Gate.updateOne({ _id: key, $or: [{ nextAt: { $lte: now } }, { nextAt: null }] },
    { $set: { nextAt: new Date(now.getTime() + milliseconds) } }, { upsert: true, session }); }
  catch (e) { if (e.code === 11000) throw error('Please wait before sending again', 429, 'REPORT_RATE_LIMIT'); throw e; }
}
async function preview(context, now = new Date()) {
  const row = await ensure(context);
  const { start, end } = period(now);
  const report = await generate(context, start, end, now);
  return { report, ...render(report, row.reportOptions) };
}
async function test(context, actor, body) {
  if (!provider.configured()) throw error('Email provider is not configured', 503);
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw error('A unique test requestId is required');
  const row = await ensure(context);
  const sample = await preview(context);
  await transaction(async session => {
    const current = await Settings.findOne({ _id: row._id, version: body.version }).session(session);
    if (!current) throw error('Settings changed elsewhere. Refresh.', 409, 'REPORT_VERSION_CONFLICT');
    const recipients = current.recipients.filter(r => r.enabled && r.verificationStatus !== 'suppressed');
    if (!recipients.length) throw error('Add at least one recipient first');
    if (await Delivery.exists({ settingsId: row._id, idempotencyKey: `test/${row._id}/${body.requestId}/${hash(recipients[0].email)}` }).session(session)) return;
    await throttle(`test:${row._id}`, 60000, session);
    await Delivery.create(recipients.map(recipient => ({ settingsId: row._id, cartId: row.cartId,
      franchiseId: row.franchiseId, recipientId: recipient._id, email: recipient.email, kind: 'test',
      idempotencyKey: `test/${row._id}/${body.requestId}/${hash(recipient.email)}`,
      scheduledOccurrence: new Date(), reportPeriodStart: sample.report.periodStart, reportPeriodEnd: sample.report.periodEnd,
      status: 'queued', nextAttemptAt: new Date(), payload: { from: provider.sender(),
        to: [recipient.email], subject: `[TEST] ${sample.subject}`, html: sample.html, text: sample.text } })), { session });
    await Audit.create([{ settingsId: row._id, actor, action: 'test.queued', next: { recipientCount: recipients.length } }], { session });
  });
  return { message: 'Test report queued. Delivery is confirmed only by provider webhook.' };
}
async function history(context) {
  const row = await ensure(context);
  return Delivery.find({ settingsId: row._id }).select('email kind status attempts lastError scheduledOccurrence reportPeriodStart reportPeriodEnd attemptedAt deliveredAt providerMessageId createdAt').sort({ createdAt: -1 }).limit(50).lean();
}
module.exports = { error, hash, email, scope, transaction, ensure, get, update, add, remove,
  preview, test, history, throttle, validatePatch };
