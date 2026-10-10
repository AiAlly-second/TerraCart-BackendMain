const { Resend } = require('resend');
let readinessError = null;
function setReadinessError(code) { readinessError = code; }
function sender() {
  const address = String(process.env.RESEND_FROM_EMAIL || '').trim();
  const name = String(process.env.RESEND_FROM_NAME || 'TerraCart').replace(/[\r\n<>"]/g, '').trim() || 'TerraCart';
  if (!address) return '';
  if (address.includes('<') && address.endsWith('>')) return address;
  return `${name} <${address}>`;
}
function configured() {
  return !!process.env.RESEND_API_KEY && !!sender() &&
    process.env.DAILY_REPORT_EMAIL_ENABLED === 'true' && !readinessError;
}
function client() {
  if (!configured()) throw Object.assign(new Error('Email provider is not configured'), { code: 'PROVIDER_NOT_CONFIGURED' });
  const sdk = new Resend(process.env.RESEND_API_KEY);
  // Provider errors may contain addresses. Application logs use only classified codes.
  sdk.logError = () => {};
  return sdk;
}
async function send(payload, idempotencyKey) {
  const result = await client().emails.send(payload, { idempotencyKey, signal: AbortSignal.timeout(15000) });
  if (result.error) {
    const status = Number(result.error.statusCode || 0);
    throw Object.assign(new Error('Email request not accepted'), {
      code: String(result.error.name || 'PROVIDER_ERROR'),
      retryable: !status || status === 429 || status === 409 || status >= 500,
      retryAfterMs: Math.max(0, Number(result.headers?.['retry-after'] || 0) * 1000),
    });
  }
  if (!result.data?.id) throw Object.assign(new Error('Unknown email acceptance'), { code: 'UNKNOWN_ACCEPTANCE', retryable: true });
  return result.data.id;
}
function verify(raw, headers) {
  if (!process.env.RESEND_WEBHOOK_SECRET) throw new Error('WEBHOOK_NOT_CONFIGURED');
  return new Resend(process.env.RESEND_API_KEY || 'webhook-only').webhooks.verify({
    payload: raw.toString('utf8'), headers: { id: headers['svix-id'],
      timestamp: headers['svix-timestamp'], signature: headers['svix-signature'] },
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  });
}
module.exports = { configured, sender, send, verify, setReadinessError };
