const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ORDER_STATUS_VALUES,
  normalizeOrderStatus,
  normalizePaymentStatus,
  applyCanonicalOrderState,
} = require("./orderContract");

// Backward-compatible exports kept to avoid breaking existing imports.
const CANONICAL_LIFECYCLE_STATUSES = ORDER_STATUS_VALUES;

const CANONICAL_TO_LEGACY_STATUS = Object.freeze({
  NEW: ORDER_STATUSES.NEW,
  PREPARING: ORDER_STATUSES.PREPARING,
  READY: ORDER_STATUSES.READY,
  COMPLETED: ORDER_STATUSES.COMPLETED,
});

const normalizeStatusKey = (status) =>
  String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");

const resolveLegacyStatus = (status) => normalizeOrderStatus(status);

const resolveStatusForPersistence = (status) =>
  normalizeOrderStatus(status, ORDER_STATUSES.NEW);

const deriveLifecycleStatus = ({ status } = {}) =>
  normalizeOrderStatus(status, ORDER_STATUSES.NEW);

const deriveIsPaid = ({ paymentStatus } = {}) =>
  normalizePaymentStatus(paymentStatus, PAYMENT_STATUSES.PENDING) ===
  PAYMENT_STATUSES.PAID;

const applyLifecycleFields = (target, { status, paymentStatus, isPaid } = {}) => {
  return applyCanonicalOrderState(target, {
    status,
    paymentStatus,
    isPaid,
  });
};

module.exports = {
  CANONICAL_LIFECYCLE_STATUSES,
  CANONICAL_TO_LEGACY_STATUS,
  normalizeStatusKey,
  resolveLegacyStatus,
  resolveStatusForPersistence,
  deriveLifecycleStatus,
  deriveIsPaid,
  applyLifecycleFields,
};
