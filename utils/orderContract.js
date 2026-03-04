const ORDER_STATUSES = Object.freeze({
  NEW: "NEW",
  PREPARING: "PREPARING",
  READY: "READY",
  COMPLETED: "COMPLETED",
});

const PUBLIC_ORDER_STATUSES = Object.freeze({
  NEW: "NEW",
  PREPARING: "PREPARING",
  READY: "READY",
  SERVED: "SERVED",
});

const PAYMENT_STATUSES = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
});

const ORDER_STATUS_VALUES = Object.freeze(Object.values(ORDER_STATUSES));
const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUSES));

const ORDER_STATUS_ALIASES = new Map([
  ["new", ORDER_STATUSES.NEW],
  ["pending", ORDER_STATUSES.NEW],
  ["confirmed", ORDER_STATUSES.NEW],
  ["accept", ORDER_STATUSES.NEW],
  ["accepted", ORDER_STATUSES.NEW],
  ["preparing", ORDER_STATUSES.PREPARING],
  ["being prepared", ORDER_STATUSES.PREPARING],
  ["beingprepared", ORDER_STATUSES.PREPARING],
  ["ready", ORDER_STATUSES.READY],
  ["completed", ORDER_STATUSES.COMPLETED],
  ["served", ORDER_STATUSES.COMPLETED],
  ["finalized", ORDER_STATUSES.COMPLETED],
  ["paid", ORDER_STATUSES.COMPLETED],
  ["cancelled", ORDER_STATUSES.COMPLETED],
  ["canceled", ORDER_STATUSES.COMPLETED],
  ["returned", ORDER_STATUSES.COMPLETED],
  ["rejected", ORDER_STATUSES.COMPLETED],
  ["closed", ORDER_STATUSES.COMPLETED],
  ["exit", ORDER_STATUSES.COMPLETED],
]);

const PAYMENT_STATUS_ALIASES = new Map([
  ["pending", PAYMENT_STATUSES.PENDING],
  ["unpaid", PAYMENT_STATUSES.PENDING],
  ["processing", PAYMENT_STATUSES.PENDING],
  ["cash_pending", PAYMENT_STATUSES.PENDING],
  ["cash pending", PAYMENT_STATUSES.PENDING],
  ["failed", PAYMENT_STATUSES.PENDING],
  ["refunded", PAYMENT_STATUSES.PENDING],
  ["paid", PAYMENT_STATUSES.PAID],
]);

const normalizeToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");

const normalizeOrderStatus = (value, fallback = ORDER_STATUSES.NEW) => {
  const token = normalizeToken(value);
  if (!token) return fallback;
  return ORDER_STATUS_ALIASES.get(token) || fallback;
};

const toPublicOrderStatus = (value, fallback = PUBLIC_ORDER_STATUSES.NEW) => {
  const normalized = normalizeOrderStatus(value, ORDER_STATUSES.NEW);
  if (normalized === ORDER_STATUSES.COMPLETED) {
    return PUBLIC_ORDER_STATUSES.SERVED;
  }
  if (normalized === ORDER_STATUSES.PREPARING) {
    return PUBLIC_ORDER_STATUSES.PREPARING;
  }
  if (normalized === ORDER_STATUSES.READY) {
    return PUBLIC_ORDER_STATUSES.READY;
  }
  if (normalized === ORDER_STATUSES.NEW) {
    return PUBLIC_ORDER_STATUSES.NEW;
  }
  return fallback;
};

const normalizePaymentStatus = (
  value,
  fallback = PAYMENT_STATUSES.PENDING,
) => {
  const token = normalizeToken(value);
  if (!token) return fallback;
  return PAYMENT_STATUS_ALIASES.get(token) || fallback;
};

const applyCanonicalOrderState = (
  target,
  {
    status,
    paymentStatus,
    isPaid,
  } = {},
) => {
  if (!target || typeof target !== "object") return target;

  const normalizedStatus = normalizeOrderStatus(
    status ?? target.status,
    ORDER_STATUSES.NEW,
  );
  const rawStatusToken = normalizeToken(status ?? target.status);
  const normalizedPaymentStatus = normalizePaymentStatus(
    paymentStatus ?? target.paymentStatus,
    PAYMENT_STATUSES.PENDING,
  );

  target.status = normalizedStatus;
  const explicitPaidFlag = isPaid === true || target.isPaid === true;
  const statusImpliesPaid = rawStatusToken === "paid";
  target.paymentStatus =
    explicitPaidFlag || statusImpliesPaid
      ? PAYMENT_STATUSES.PAID
      : normalizedPaymentStatus;

  // Backward compatibility fields consumed by older clients.
  target.lifecycleStatus = normalizedStatus;
  target.isPaid = target.paymentStatus === PAYMENT_STATUSES.PAID;

  return target;
};

const isOrderSettled = (orderLike) => {
  const status = normalizeOrderStatus(orderLike?.status, ORDER_STATUSES.NEW);
  const paymentStatus = normalizePaymentStatus(
    orderLike?.paymentStatus,
    PAYMENT_STATUSES.PENDING,
  );

  return (
    status === ORDER_STATUSES.COMPLETED &&
    paymentStatus === PAYMENT_STATUSES.PAID
  );
};

const shouldDisplayInActiveQueues = (orderLike) => !isOrderSettled(orderLike);

const buildOrderStatusUpdatedPayload = (orderLike) => {
  if (!orderLike || typeof orderLike !== "object") {
    return {
      orderId: null,
      status: ORDER_STATUSES.NEW,
      paymentStatus: PAYMENT_STATUSES.PENDING,
      updatedAt: new Date().toISOString(),
    };
  }

  const orderId =
    orderLike.orderId || orderLike._id || orderLike.id || null;

  return {
    orderId: orderId ? String(orderId) : null,
    status: toPublicOrderStatus(orderLike.status, PUBLIC_ORDER_STATUSES.NEW),
    paymentStatus: normalizePaymentStatus(
      orderLike.paymentStatus,
      PAYMENT_STATUSES.PENDING,
    ),
    updatedAt:
      orderLike.updatedAt instanceof Date
        ? orderLike.updatedAt.toISOString()
        : String(orderLike.updatedAt || orderLike.createdAt || new Date().toISOString()),
  };
};

const buildActiveOrderMongoFilter = () => ({
  $or: [
    { status: { $nin: [ORDER_STATUSES.COMPLETED, PUBLIC_ORDER_STATUSES.SERVED] } },
    { paymentStatus: { $ne: PAYMENT_STATUSES.PAID } },
  ],
});

module.exports = {
  ORDER_STATUSES,
  PUBLIC_ORDER_STATUSES,
  PAYMENT_STATUSES,
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  normalizeOrderStatus,
  toPublicOrderStatus,
  normalizePaymentStatus,
  applyCanonicalOrderState,
  isOrderSettled,
  shouldDisplayInActiveQueues,
  buildOrderStatusUpdatedPayload,
  buildActiveOrderMongoFilter,
};
