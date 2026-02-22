const mongoose = require("mongoose");
const { Payment, PAYMENT_METHODS, PAYMENT_STATUSES } = require("../models/paymentModel");
const Order = require("../models/orderModel");
const PaymentQR = require("../models/paymentQrModel");
const Employee = require("../models/employeeModel");
const { releaseTableForOrder } = require("./orderController");
const { consumeIngredientsForOrder } = require("../services/costing-v2/orderConsumptionService");

const toObjectIdIfValid = (value) => {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
};

const buildQrScopeOrFilter = (scopeId) => {
  if (!scopeId) return [];

  const variants = [];
  const normalizedScopeId = toObjectIdIfValid(scopeId);
  variants.push(normalizedScopeId);

  const scopeAsString = String(scopeId);
  if (!variants.some((v) => String(v) === scopeAsString)) {
    variants.push(scopeAsString);
  }

  const fields = ["cartId", "userId", "cafeId"];
  const filters = [];
  for (const field of fields) {
    for (const variant of variants) {
      filters.push({ [field]: variant });
    }
  }
  return filters;
};

const resetInventoryDeductionFlag = async (orderId) => {
  if (!orderId) return;
  try {
    await Order.findByIdAndUpdate(orderId, {
      inventoryDeducted: false,
      inventoryDeductedAt: null,
    });
  } catch (err) {
    console.error(
      `[COSTING] Failed to reset inventoryDeducted for order ${orderId}:`,
      err.message,
    );
  }
};

const shouldResetInventoryDeduction = (result) => {
  if (!result) return true;
  if (result.success || result.alreadyProcessed) return false;
  const consumedCount = Array.isArray(result.summary?.ingredientsConsumed)
    ? result.summary.ingredientsConsumed.length
    : 0;
  const processedCount = Number(result.summary?.itemsProcessed || 0);
  return consumedCount === 0 && processedCount === 0;
};

const buildUpiPayload = async (orderId, amount, cartScopeId = null) => {
  // Try to get UPI ID from admin uploaded QR code
  let payee = process.env.UPI_PAYEE_VPA || "sarvacafe@upi";
  let payeeName = process.env.UPI_PAYEE_NAME || "Terra Cart";
  
  try {
    // Try to find cart-scoped QR first.
    let qrCode = null;
    if (cartScopeId) {
      const scopeOrFilter = buildQrScopeOrFilter(cartScopeId);
      qrCode = await PaymentQR.findOne({
        $or: scopeOrFilter,
        isActive: true,
      }).sort({ createdAt: -1 });
    }
    
    // Optional legacy fallback: allow truly global QR only when cart scope is unavailable.
    if (!qrCode && !cartScopeId) {
      qrCode = await PaymentQR.findOne({
        isActive: true,
        $and: [
          { $or: [{ cartId: { $exists: false } }, { cartId: null }] },
          { $or: [{ userId: { $exists: false } }, { userId: null }] },
          { $or: [{ cafeId: { $exists: false } }, { cafeId: null }] },
        ],
      }).sort({ createdAt: -1 });
    }
    
    // Use UPI ID from uploaded QR if available
    if (qrCode && qrCode.upiId) {
      payee = qrCode.upiId.trim();
      if (qrCode.gatewayName) {
        payeeName = qrCode.gatewayName;
      }
    }
  } catch (err) {
    console.warn("[PAYMENT] Failed to fetch PaymentQR, using default UPI:", err.message);
  }
  
  const encodedPayeeName = encodeURIComponent(payeeName);
  const note = encodeURIComponent(`Order ${orderId}`);
  return `upi://pay?pa=${payee}&pn=${encodedPayeeName}&tn=${note}&am=${amount.toFixed(
    2
  )}&cu=INR`;
};

const getSelectedAddonsAmount = (order) => {
  if (!Array.isArray(order?.selectedAddons)) return 0;
  return order.selectedAddons.reduce((sum, addon) => {
    if (!addon) return sum;
    const price = Number(addon.price);
    if (!Number.isFinite(price) || price < 0) return sum;
    const quantityValue = Number(addon.quantity);
    const quantity =
      Number.isFinite(quantityValue) && quantityValue > 0
        ? Math.floor(quantityValue)
        : 1;
    return sum + price * quantity;
  }, 0);
};

const getOrderAmount = (order) => {
  if (!order?.kotLines?.length) return null;
  const latestKot = order.kotLines[order.kotLines.length - 1];
  const kotAmountRaw = Number(latestKot.totalAmount || latestKot.subtotal || 0);
  const kotAmount = Number.isFinite(kotAmountRaw) ? kotAmountRaw : 0;
  const addonsAmount = getSelectedAddonsAmount(order);
  const totalAmount = kotAmount + addonsAmount;
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;
  return Number(totalAmount.toFixed(2));
};

const formatPaymentResponse = (payment) => ({
  id: payment._id,
  orderId: payment.orderId,
  amount: payment.amount,
  method: payment.method,
  status: payment.status,
  description: payment.description,
  upiPayload: payment.upiPayload,
  paymentUrl: payment.paymentUrl,
  providerReference: payment.providerReference,
  metadata: payment.metadata,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
  paidAt: payment.paidAt,
  cancelledAt: payment.cancelledAt,
  cancellationReason: payment.cancellationReason,
});

const ensurePaymentForOrder = async (order, options = {}) => {
  if (!order?._id) return { payment: null, created: false };
  const amount = getOrderAmount(order);
  if (!amount || amount <= 0) {
    return { payment: null, created: false };
  }

  let payment = await Payment.findOne({ orderId: order._id });
  let created = false;

  if (!payment) {
    payment = await Payment.create({
      orderId: order._id,
      amount,
      method: options.method || "CASH",
      status: options.status || "PAID",
      description: options.description || `Payment for order ${order._id}`,
      paidAt: options.status === "PAID" ? new Date() : undefined,
    });
    created = true;
  } else {
    let mutate = false;
    if (payment.amount !== amount) {
      payment.amount = amount;
      mutate = true;
    }
    if (options.status && payment.status !== options.status) {
      payment.status = options.status;
      if (options.status === "PAID" && !payment.paidAt) {
        payment.paidAt = new Date();
      }
      mutate = true;
    }
    if (options.method && payment.method !== options.method) {
      payment.method = options.method;
      mutate = true;
    }
    if (options.description && payment.description !== options.description) {
      payment.description = options.description;
      mutate = true;
    }
    if (mutate) {
      await payment.save();
    }
  }

  return { payment, created };
};

const MOBILE_PAYMENT_ROLES = new Set([
  "waiter",
  "cook",
  "captain",
  "manager",
  "employee",
]);

const resolveMobileCartId = async (user) => {
  if (!user) return null;

  if (user.cartId || user.cafeId) {
    return user.cartId || user.cafeId;
  }

  let employee = null;
  if (user.employeeId) {
    employee = await Employee.findById(user.employeeId).select("cartId cafeId").lean();
  }

  if (!employee && user._id) {
    employee = await Employee.findOne({ userId: user._id })
      .select("cartId cafeId")
      .lean();
  }

  if (!employee && user.email) {
    employee = await Employee.findOne({
      email: String(user.email).toLowerCase(),
    })
      .select("cartId cafeId")
      .lean();
  }

  return employee?.cartId || employee?.cafeId || null;
};

const resolvePaymentScope = async (user) => {
  if (!user) return { type: "none" };

  if (user.role === "super_admin") {
    return { type: "super_admin" };
  }

  if (user.role === "franchise_admin" && user._id) {
    return { type: "franchise", franchiseId: user._id };
  }

  if (user.role === "admin" && user._id) {
    return { type: "cart", cartId: user._id };
  }

  if (MOBILE_PAYMENT_ROLES.has(user.role)) {
    const mobileCartId = await resolveMobileCartId(user);
    if (!mobileCartId) {
      return { type: "none" };
    }
    return { type: "cart", cartId: mobileCartId };
  }

  return { type: "none" };
};

const canAccessOrderByScope = (scope, order) => {
  if (!scope || !order) return false;

  if (scope.type === "super_admin") return true;

  if (scope.type === "franchise") {
    return (
      scope.franchiseId &&
      order.franchiseId &&
      order.franchiseId.toString() === scope.franchiseId.toString()
    );
  }

  if (scope.type === "cart") {
    return (
      scope.cartId &&
      order.cartId &&
      order.cartId.toString() === scope.cartId.toString()
    );
  }

  return false;
};

const buildOrderScopeQuery = (scope, baseQuery = {}) => {
  const query = { ...baseQuery };

  if (!scope || scope.type === "none") {
    return null;
  }

  if (scope.type === "cart") {
    query.cartId = toObjectIdIfValid(scope.cartId);
  } else if (scope.type === "franchise") {
    query.franchiseId = toObjectIdIfValid(scope.franchiseId);
  }

  // super_admin keeps base query without additional scope.
  return query;
};

exports.createPaymentIntent = async (req, res) => {
  try {
    const { orderId, method = "ONLINE", description } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }
    if (!PAYMENT_METHODS.includes(method)) {
      return res
        .status(400)
        .json({ message: `Method must be one of ${PAYMENT_METHODS.join(", ")}` });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const amount = getOrderAmount(order);
    if (!amount || amount <= 0) {
      return res.status(400).json({
        message: "Order has no billable amount yet. Please add items before payment.",
      });
    }

    await Payment.updateMany(
      {
        orderId,
        status: { $in: ["PENDING", "PROCESSING", "CASH_PENDING"] },
      },
      {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: "Superseded by new payment intent",
      }
    );

    const payload = {
      orderId,
      amount,
      method,
      status: method === "CASH" ? "CASH_PENDING" : "PENDING",
      description: description || `Payment for order ${orderId}`,
    };

    if (method === "ONLINE") {
      // Get cart scope from order to find cart-admin uploaded UPI QR
      const cartScopeId = order.cartId || order.cafeId || null;
      payload.upiPayload = await buildUpiPayload(orderId, amount, cartScopeId);
    }

    const payment = await Payment.create(payload);

    const io = req.app.get("io");
    if (io) {
      io.emit("paymentCreated", formatPaymentResponse(payment));
    }

    return res.status(201).json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.listPayments = async (req, res) => {
  try {
    const { status, method } = req.query;
    const filter = {};
    if (status && PAYMENT_STATUSES.includes(status)) {
      filter.status = status;
    }
    if (method && PAYMENT_METHODS.includes(method)) {
      filter.method = method;
    }

    // Scope payments to the caller's outlet/franchise unless super_admin.
    const scope = await resolvePaymentScope(req.user);
    if (scope.type === "none") {
      return res.json([]);
    }

    if (scope.type !== "super_admin") {
      const scopedOrderQuery = buildOrderScopeQuery(scope);
      const scopedOrders = await Order.find(scopedOrderQuery)
        .select("_id")
        .limit(10000)
        .lean();

      const orderIds = scopedOrders.map((order) => order._id);
      if (!orderIds.length) {
        return res.json([]);
      }

      filter.orderId = { $in: orderIds };
    }

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json(payments.map(formatPaymentResponse));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getPaymentById = async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const scope = await resolvePaymentScope(req.user);
    if (scope.type === "none") {
      return res.status(403).json({ message: "Not authorized to access this payment" });
    }

    if (scope.type !== "super_admin") {
      const order = await Order.findById(payment.orderId)
        .select("cartId franchiseId")
        .lean();
      if (!order || !canAccessOrderByScope(scope, order)) {
        return res.status(403).json({ message: "Payment does not belong to your cart/franchise" });
      }
    }

    return res.json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getPaymentsForOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId).select("cartId franchiseId").lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const scope = await resolvePaymentScope(req.user);
    if (!canAccessOrderByScope(scope, order)) {
      return res.status(403).json({ message: "Order does not belong to your cart/franchise" });
    }

    const payments = await Payment.find({ orderId }).sort({ createdAt: -1 }).lean();
    return res.json(payments.map(formatPaymentResponse));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getLatestPaymentForOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Order._id is a String (order number like "ORD-xxxxx"), and Payment.orderId stores the same string
    // So we can directly use orderId to find the payment
    const payment = await Payment.findOne({ orderId })
      .sort({ createdAt: -1 })
      .lean();
    if (!payment) {
      // Return 200 with null instead of 404 - no payment yet is a valid state
      return res.json(null);
    }
    return res.json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.cancelPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const payment = await Payment.findById(id);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (req.user) {
      const scope = await resolvePaymentScope(req.user);
      if (scope.type === "none") {
        return res.status(403).json({ message: "Not authorized to cancel this payment" });
      }
      if (scope.type !== "super_admin") {
        const order = await Order.findById(payment.orderId)
          .select("cartId franchiseId")
          .lean();
        if (!order || !canAccessOrderByScope(scope, order)) {
          return res.status(403).json({ message: "Payment does not belong to your cart/franchise" });
        }
      }
    }

    if (["PAID", "CANCELLED"].includes(payment.status)) {
      return res.status(400).json({ message: "Payment is already finalised" });
    }

    payment.status = "CANCELLED";
    payment.cancelledAt = new Date();
    payment.cancellationReason = reason || "Cancelled by user";
    await payment.save();

    const io = req.app.get("io");
    if (io) {
      io.emit("paymentUpdated", formatPaymentResponse(payment));
    }

    return res.json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.markPaymentPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await Payment.findById(id);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const scope = await resolvePaymentScope(req.user);
    if (scope.type === "none") {
      return res.status(403).json({ message: "Not authorized to mark this payment as paid" });
    }

    const order = await Order.findById(payment.orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found for this payment" });
    }

    if (!canAccessOrderByScope(scope, order)) {
      return res.status(403).json({ message: "Payment does not belong to your cart/franchise" });
    }

    if (payment.status === "PAID") {
      return res.json(formatPaymentResponse(payment));
    }

    payment.status = "PAID";
    payment.paidAt = new Date();
    await payment.save();

    if (order) {
      order.status = "Paid";
      order.paidAt = new Date();
      const needsFallbackConsumption = !order.inventoryDeducted;
      if (needsFallbackConsumption) {
        order.inventoryDeducted = true;
        order.inventoryDeductedAt = new Date();
      }
      await order.save();
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");
      if (io) {
        io.emit("paymentUpdated", formatPaymentResponse(payment));
        io.emit("orderUpdated", order);
      }
      if (order.cartId && io && emitToCafe) {
        emitToCafe(io, order.cartId.toString(), "order:created", order);
        emitToCafe(io, order.cartId.toString(), "newOrder", order);
        emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
        emitToCafe(io, order.cartId.toString(), "orderUpdated", order);
      }
      await releaseTableForOrder(order, io, emitToCafe);

      if (needsFallbackConsumption) {
        const userId =
          req.user && req.user._id
            ? req.user._id
            : order.cartId && (order.cartId._id || order.cartId);
        if (userId) {
          console.log(
            `[COSTING] Fallback: Order ${order._id} paid via markPaymentPaid - triggering consumption`,
          );
          consumeIngredientsForOrder(order, userId)
            .then(async (consumptionResult) => {
              if (consumptionResult.success) {
                console.log(
                  `[COSTING] Fallback consumption success for order ${order._id}`,
                );
              } else {
                const isBenign =
                  consumptionResult.alreadyProcessed ||
                  consumptionResult.message?.includes("No new items");
                if (!isBenign && consumptionResult.summary?.errors) {
                  consumptionResult.summary.errors.forEach((e) =>
                    console.warn(`[COSTING] ${e.item}: ${e.error}`),
                  );
                }
                if (!isBenign && shouldResetInventoryDeduction(consumptionResult)) {
                  await resetInventoryDeductionFlag(order._id);
                }
              }
            })
            .catch(async (err) => {
              console.error(
                `[COSTING] Fallback consumption error for order ${order._id}:`,
                err,
              );
              await resetInventoryDeductionFlag(order._id);
            });
        } else {
          console.warn(
            `[COSTING] Skipping fallback consumption for order ${order._id}: no userId`,
          );
          await resetInventoryDeductionFlag(order._id);
        }
      }
    }

    return res.json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.PAYMENT_METHODS = PAYMENT_METHODS;
exports.PAYMENT_STATUSES = PAYMENT_STATUSES;

exports.syncPaidOrders = async (req, res) => {
  try {
    // Filter orders by caller scope so no cross-cart sync happens.
    const scope = await resolvePaymentScope(req.user);
    const query = buildOrderScopeQuery(scope, { status: "Paid" });
    if (!query) {
      return res.json({ synced: 0, payments: [] });
    }

    const orders = await Order.find(query).sort({ updatedAt: -1 });
    const results = [];
    for (const order of orders) {
      const amount = getOrderAmount(order);
      if (!amount || amount <= 0) continue;
      const { payment, created } = await ensurePaymentForOrder(order, {
        status: "PAID",
        method: "CASH",
        description: "Synced from admin invoices panel",
      });
      if (payment) {
        results.push({
          payment: formatPaymentResponse(payment),
          created,
        });
      }
    }
    return res.json({
      synced: results.length,
      payments: results.map((entry) => entry.payment),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
