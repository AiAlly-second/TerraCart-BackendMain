const { createHash, timingSafeEqual } = require('node:crypto');
const REPLAY_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};
function readIdempotencyKey(req) {
  const body = req.body?.idempotencyKey, header = req.headers?.['x-idempotency-key'];
  if (body !== undefined && header !== undefined && body !== header) throw new Error('Conflicting idempotency keys.');
  const value = body ?? header;
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error('Invalid idempotency key.');
  return value;
}
function orderRequestBinding(req, anonymousSessionId, sessionToken, now = Date.now(), operation = 'create-order') {
  const userId = req.user?._id ? String(req.user._id) : '';
  if (!userId && !anonymousSessionId && !sessionToken) throw new Error('A customer session is required for idempotent orders.');
  const payload = { ...req.body };
  for (const key of ['idempotencyKey', 'anonymousSessionId', 'sessionToken']) delete payload[key];
  if (payload.customerLocation) {
    payload.customerLocation = { ...payload.customerLocation };
    // Recovery pointer is not a business input. Coordinates/address remain bound.
    delete payload.customerLocation.locationReference;
  }
  return {
    ownerHash: digest(JSON.stringify(userId ? ['user', userId] : ['guest', anonymousSessionId || '', sessionToken || ''])),
    payloadHash: digest(JSON.stringify(canonical({ operation, payload }))),
    expiresAt: new Date(now + REPLAY_MS),
  };
}
const equalHash = (left, right) => typeof left === 'string' && typeof right === 'string' && /^[a-f\d]{64}$/.test(left) && /^[a-f\d]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
function verifyOrderReplay(order, binding, now = Date.now()) {
  const saved = order.idempotencyBinding;
  // Historical keys alone never grant ownership or invent a payload fingerprint.
  if (!saved?.ownerHash || !saved?.payloadHash) return { ok: false, status: 409, message: 'Legacy retry cannot be verified. Restore the existing order by its authorized order link; do not submit a new payment.' };
  if (!equalHash(saved.ownerHash, binding.ownerHash)) return { ok: false, status: 403, message: 'Idempotency key belongs to a different customer.' };
  if (!equalHash(saved.payloadHash, binding.payloadHash)) return { ok: false, status: 409, message: 'Idempotency key was already used for a different order request.' };
  if (!(new Date(saved.expiresAt).getTime() > now)) return { ok: false, status: 409, message: 'Retry window expired. Restore the existing order before retrying payment.' };
  return { ok: true };
}
module.exports = { readIdempotencyKey, orderRequestBinding, verifyOrderReplay, REPLAY_MS };
