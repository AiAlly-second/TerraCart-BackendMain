const ORDER_TYPE_INPUTS = Object.freeze({
  DINE_IN: "dine-in",
  TAKEAWAY: "takeaway",
  DELIVERY: "delivery",
});

const ORDER_TYPE_ALIASES = new Map([
  ["dine-in", ORDER_TYPE_INPUTS.DINE_IN],
  ["dinein", ORDER_TYPE_INPUTS.DINE_IN],
  ["dine_in", ORDER_TYPE_INPUTS.DINE_IN],
  ["dine in", ORDER_TYPE_INPUTS.DINE_IN],
  ["dine", ORDER_TYPE_INPUTS.DINE_IN],
  ["takeaway", ORDER_TYPE_INPUTS.TAKEAWAY],
  ["pickup", ORDER_TYPE_INPUTS.TAKEAWAY], // legacy alias
  ["delivery", ORDER_TYPE_INPUTS.DELIVERY],
]);

const normalizeToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

const resolveOrderType = (...values) => {
  for (const value of values) {
    const token = normalizeToken(value);
    if (!token) continue;
    if (ORDER_TYPE_ALIASES.has(token)) {
      return ORDER_TYPE_ALIASES.get(token);
    }
  }
  return null;
};

const mapOrderTypeToServiceType = (orderType) => {
  if (orderType === ORDER_TYPE_INPUTS.DINE_IN) return "DINE_IN";
  if (orderType === ORDER_TYPE_INPUTS.DELIVERY) return "DELIVERY";
  if (orderType === ORDER_TYPE_INPUTS.TAKEAWAY) return "TAKEAWAY";
  return null;
};

const validateOrderType = (req, res, next) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const incomingOrderType = body.orderType;
  const incomingServiceType = body.serviceType;

  const normalizedOrderType = resolveOrderType(
    incomingOrderType,
    incomingServiceType,
  );

  if (!normalizedOrderType) {
    return res.status(400).json({
      message:
        "Invalid orderType. Allowed values: dine-in, delivery, takeaway.",
    });
  }

  const normalizedServiceType = mapOrderTypeToServiceType(normalizedOrderType);
  req.body.orderTypeInput = normalizedOrderType;
  req.body.serviceType = normalizedServiceType;

  console.log(
    `[ORDER_VALIDATION] create-order type`,
    JSON.stringify({
      receivedOrderType: incomingOrderType || null,
      receivedServiceType: incomingServiceType || null,
      normalizedOrderType,
      normalizedServiceType,
    }),
  );

  return next();
};

module.exports = {
  ORDER_TYPE_INPUTS,
  validateOrderType,
};
