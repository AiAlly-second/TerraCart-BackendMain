const crypto = require('node:crypto');
const { Settings, Occurrence, Delivery, Gate, WebhookEvent } = require('../../models/dailyReportModel');
const User = require('../../models/userModel');
const { nextRun, period } = require('./time');
const { generate } = require('./report');
const { render } = require('./template');
const { build: buildOrdersWorkbook, attach: attachOrdersWorkbook } = require('./ordersWorkbook');
const { transaction, hash } = require('./settings');
const provider = require('./provider');
const LEASE_MS = 60000;
const RETRY_WINDOW_MS = 23 * 3600000; // Never retry ambiguous sends after provider dedupe expires.
async function materialize(now = new Date()) {
  const due = await Settings.find({ enabled: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).limit(20).lean();
  for (const snapshot of due) {
    await transaction(async session => {
      const row = await Settings.findOneAndUpdate({ _id: snapshot._id, enabled: true,
        version: snapshot.version, nextRunAt: snapshot.nextRunAt },
      { $set: { nextRunAt: nextRun(snapshot.scheduledTime, now) } }, { new: true, session });
      if (!row) return; // Another replica or editor owns this occurrence.
      const cutoff = new Date(snapshot.nextRunAt), window = period(cutoff);
      // Recover the latest persisted due occurrence, not one job for each missed day.
      // More than 24h late is recorded skipped rather than flooding recipients.
      const expired = now - cutoff > 86400000;
      const [occurrence] = await Occurrence.create([{ settingsId: row._id, cartId: row.cartId,
        franchiseId: row.franchiseId, settingsVersion: snapshot.version,
        scheduledOccurrence: cutoff, reportPeriodStart: window.start, reportPeriodEnd: window.end,
        status: expired ? 'skipped_downtime' : 'pending' }], { session });
      if (expired) return;
      const recipients = row.recipients.filter(r => r.enabled && r.verificationStatus !== 'suppressed');
      if (!recipients.length) { occurrence.status = 'no_recipients'; await occurrence.save({ session }); return; }
      // Freeze report and provider payload once; retries keep identical content and cutoff.
      occurrence.report = await generate(row, window.start, window.end, now);
      const content = attachOrdersWorkbook(render(occurrence.report, row.reportOptions),
        await buildOrdersWorkbook({ cartId: row.cartId, franchiseId: row.franchiseId, start: window.start, end: window.end, generatedAt: now }));
      await occurrence.save({ session });
      await Delivery.create(recipients.map(recipient => ({ settingsId: row._id, cartId: row.cartId,
        franchiseId: row.franchiseId, recipientId: recipient._id, email: recipient.email,
        occurrenceId: occurrence._id, scheduledOccurrence: cutoff,
        reportPeriodStart: window.start, reportPeriodEnd: window.end,
        idempotencyKey: `daily/${row.franchiseId}/${row.cartId}/${hash(recipient.email)}/${cutoff.toISOString()}`,
        status: 'queued', scheduledAt: cutoff, nextAttemptAt: now,
        payload: { from: provider.sender(), to: [recipient.email], ...content },
      })), { session });
    });
  }
}
async function dispatch(now = new Date(), send = provider.send) {
  // One shared global slot/second, across all PM2 workers and all mail kinds.
  try {
    const slot = await Gate.findOneAndUpdate({ _id: 'resend-global', $or: [{ nextAt: { $lte: now } }, { nextAt: null }] },
      { $set: { nextAt: new Date(now.getTime() + 1000) } }, { upsert: true, new: true });
    if (!slot) return;
  } catch (e) { if (e.code === 11000) return; throw e; }
  const claimToken = crypto.randomUUID();
  const item = await Delivery.findOneAndUpdate({ $or: [
    { status: { $in: ['queued', 'retry'] }, nextAttemptAt: { $lte: now } },
    { status: 'sending', leaseUntil: { $lte: now } },
  ] }, { $set: { status: 'sending', claimToken, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
  { new: true, sort: { nextAttemptAt: 1 } }).lean();
  if (!item) return;
  const claim = { _id: item._id, claimToken, status: 'sending' };
  const row = await Settings.findById(item.settingsId).lean();
  const recipient = row?.recipients.find(r => String(r._id) === String(item.recipientId));
  const [cart, franchise] = await Promise.all([User.findById(item.cartId).select('franchiseId isActive role').lean(),
    User.findById(item.franchiseId).select('isActive role').lean()]);
  const authorized = recipient?.enabled && recipient.email === item.email && recipient.verificationStatus !== 'suppressed' &&
    item.kind !== 'verification' &&
    cart?.role === 'admin' && cart.isActive !== false && franchise?.role === 'franchise_admin' && franchise.isActive !== false &&
    String(cart.franchiseId) === String(item.franchiseId) &&
    (item.kind !== 'scheduled' || row.enabled);
  if (!authorized) { await Delivery.updateOne(claim, { $set: { status: 'cancelled', lastError: 'CONFIGURATION_OR_RECIPIENT_DISABLED' }, $unset: { payload: 1 } }); return; }
  if (item.firstAttemptAt && now - new Date(item.firstAttemptAt) >= RETRY_WINDOW_MS) {
    await Delivery.updateOne(claim, { $set: { status: 'needs_review', lastError: 'IDEMPOTENCY_WINDOW_EXPIRED_NO_RESEND' }, $unset: { payload: 1 } }); return;
  }
  const started = await Delivery.findOneAndUpdate(claim, { $inc: { attempts: 1 },
    $set: { attemptedAt: now, firstAttemptAt: item.firstAttemptAt || now } }, { new: true }).lean();
  if (!started) return;
  try {
    const messageId = await send(item.payload, item.idempotencyKey);
    // Webhooks can arrive first; don't overwrite a final state here.
    await Delivery.updateOne(claim, { $set: { status: 'accepted', providerMessageId: messageId,
      lastError: null }, $unset: { payload: 1, leaseUntil: 1 } });
  } catch (e) {
    const retry = e.retryable !== false && started.attempts < 8;
    const delay = Math.max(Number(e.retryAfterMs || 0), Math.min(3600000, 30000 * 2 ** (started.attempts - 1)));
    await Delivery.updateOne(claim, { $set: { status: retry ? 'retry' : 'needs_review',
      lastError: /^[A-Z_a-z0-9]+$/.test(e.code || '') ? e.code : 'TEMPORARY_PROVIDER_FAILURE',
      nextAttemptAt: new Date(now.getTime() + delay) }, $unset: { leaseUntil: 1, ...(!retry ? { payload: 1 } : {}) } });
  }
}
const EVENT_RANK = { 'email.sent': 1, 'email.delivery_delayed': 2, 'email.delivered': 3,
  'email.failed': 4, 'email.bounced': 5, 'email.complained': 6 };
const EVENT_STATUS = { 'email.sent': 'sent', 'email.delivery_delayed': 'delayed',
  'email.delivered': 'delivered', 'email.failed': 'failed', 'email.bounced': 'bounced', 'email.complained': 'complained' };
async function receiveEvent(event, eventId) {
  if (!EVENT_RANK[event.type]) return;
  if (!eventId || typeof event.data?.email_id !== 'string' || !Number.isFinite(new Date(event.created_at).getTime())) throw new Error('INVALID_WEBHOOK_EVENT');
  try { await WebhookEvent.updateOne({ eventId }, { $setOnInsert: {
    eventId, providerMessageId: event.data.email_id, type: event.type, eventAt: new Date(event.created_at),
  } }, { upsert: true }); } catch (e) { if (e.code !== 11000) throw e; }
  await reconcileEvents();
}
async function reconcileEvents() {
  await WebhookEvent.updateMany({ processedAt: null, createdAt: { $lt: new Date(Date.now() - 86400000) } },
    { $set: { processedAt: new Date() } });
  const events = await WebhookEvent.find({ processedAt: null }).limit(100).lean();
  for (const event of events) {
    await transaction(async session => {
      const delivery = await Delivery.findOne({ providerMessageId: event.providerMessageId }).session(session);
      if (!await WebhookEvent.exists({ _id: event._id, processedAt: null }).session(session)) return;
      if (!delivery) return; // API acceptance may not yet be stored; reconcile on next worker tick.
      const rank = EVENT_RANK[event.type];
      if (rank > delivery.webhookRank) {
        delivery.status = EVENT_STATUS[event.type]; delivery.webhookRank = rank; delivery.webhookAt = event.eventAt;
        if (event.type === 'email.delivered') delivery.deliveredAt = event.eventAt;
        if (rank >= 4) delivery.lastError = event.type.toUpperCase().replace('.', '_');
        await delivery.save({ session });
      }
      if (['email.bounced', 'email.complained'].includes(event.type)) {
        await Settings.updateOne({ _id: delivery.settingsId, 'recipients._id': delivery.recipientId },
          { $set: { 'recipients.$.verificationStatus': 'suppressed' }, $inc: { version: 1 } }, { session });
      }
      await WebhookEvent.updateOne({ _id: event._id, processedAt: null }, { $set: { processedAt: new Date() } }, { session });
    });
  }
}
let timer, running;
async function tick() {
  if (running || !provider.configured()) return;
  running = (async () => { await materialize(); await dispatch(); await reconcileEvents(); })();
  try { await running; } catch (e) {
    console.error('[DAILY_REPORT_WORKER]', { code: e.code || 'WORKER_ERROR', name: e.name });
  } finally { running = null; }
}
async function start() {
  if (timer || !provider.configured()) return;
  // Do not run without durable unique indexes. Creates only these additive collections/indexes.
  for (const [model, index] of [[Settings, { cartId: 1 }], [Occurrence, { settingsId: 1, scheduledOccurrence: 1 }],
    [Delivery, { idempotencyKey: 1 }], [WebhookEvent, { eventId: 1 }]]) {
    const indexes = await model.collection.indexes();
    if (!indexes.some(row => row.unique && JSON.stringify(row.key) === JSON.stringify(index))) {
      throw new Error('DAILY_REPORT_UNIQUE_INDEX_MIGRATION_REQUIRED');
    }
  }
  timer = setInterval(tick, 1000); timer.unref(); void tick();
}
async function stop() { clearInterval(timer); timer = null; if (running) await running.catch(() => {}); }
module.exports = { materialize, dispatch, receiveEvent, reconcileEvents, start, stop, RETRY_WINDOW_MS };
