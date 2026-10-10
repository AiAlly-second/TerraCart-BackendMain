const mongoose = require('mongoose');
const { Schema } = mongoose;
const recipient = new Schema({
  email: { type: String, required: true }, enabled: { type: Boolean, default: true },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'suppressed'], default: 'pending' },
  tokenHash: String, tokenExpiresAt: Date, verifiedAt: Date, verificationQueuedAt: Date,
}, { timestamps: true });
const settings = new Schema({
  cartId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  franchiseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  enabled: { type: Boolean, default: false }, scheduledTime: { type: String, default: '18:00' },
  timezone: { type: String, enum: ['Asia/Kolkata'], default: 'Asia/Kolkata' },
  reportPeriodMode: { type: String, enum: ['today_snapshot'], default: 'today_snapshot' },
  reportOptions: { type: [String], default: ['orders', 'sales', 'payments', 'profit'] },
  recipients: { type: [recipient], default: [], validate: {
    validator: rows => new Set(rows.map(row => row.email)).size === rows.length,
    message: 'Recipient addresses must be unique',
  } }, version: { type: Number, default: 0 },
  nextRunAt: Date, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
settings.index({ enabled: 1, nextRunAt: 1 });
const occurrence = new Schema({
  settingsId: { type: Schema.Types.ObjectId, required: true }, cartId: Schema.Types.ObjectId,
  franchiseId: Schema.Types.ObjectId, scheduledOccurrence: { type: Date, required: true },
  reportPeriodStart: Date, reportPeriodEnd: Date, settingsVersion: Number,
  status: { type: String, default: 'pending' }, report: Schema.Types.Mixed,
}, { timestamps: true });
occurrence.index({ settingsId: 1, scheduledOccurrence: 1 }, { unique: true });
const delivery = new Schema({
  settingsId: { type: Schema.Types.ObjectId, required: true }, cartId: Schema.Types.ObjectId,
  franchiseId: Schema.Types.ObjectId, recipientId: Schema.Types.ObjectId, email: String,
  occurrenceId: Schema.Types.ObjectId, scheduledOccurrence: Date, reportPeriodStart: Date, reportPeriodEnd: Date,
  kind: { type: String, enum: ['scheduled', 'test', 'verification'], default: 'scheduled' },
  idempotencyKey: { type: String, required: true, unique: true },
  status: { type: String, default: 'queued' }, providerMessageId: String,
  attempts: { type: Number, default: 0 }, lastError: String, scheduledAt: Date,
  attemptedAt: Date, firstAttemptAt: Date, deliveredAt: Date, nextAttemptAt: Date,
  claimToken: String, leaseUntil: Date, payload: Schema.Types.Mixed,
  webhookAt: Date, webhookRank: { type: Number, default: 0 },
}, { timestamps: true });
delivery.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
delivery.index({ providerMessageId: 1 }, { unique: true, sparse: true });
delivery.index({ cartId: 1, createdAt: -1 });
const audit = new Schema({ settingsId: Schema.Types.ObjectId, actor: Schema.Types.ObjectId,
  action: String, previous: Schema.Types.Mixed, next: Schema.Types.Mixed }, { timestamps: true });
const webhook = new Schema({ eventId: { type: String, required: true, unique: true },
  providerMessageId: String, type: String, eventAt: Date, processedAt: Date }, { timestamps: true });
const gate = new Schema({ _id: String, nextAt: Date });
module.exports = {
  Settings: mongoose.model('DailyReportSettings', settings),
  Occurrence: mongoose.model('DailyReportOccurrence', occurrence),
  Delivery: mongoose.model('DailyReportDelivery', delivery),
  Audit: mongoose.model('DailyReportAudit', audit),
  WebhookEvent: mongoose.model('DailyReportWebhookEvent', webhook),
  Gate: mongoose.model('DailyReportGate', gate),
};
