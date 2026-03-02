const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Payment, PAYMENT_METHODS, PAYMENT_STATUSES } = require("../models/paymentModel");
const Order = require("../models/orderModel");
const PaymentQR = require("../models/paymentQrModel");
const Employee = require("../models/employeeModel");
const { releaseTableForOrder } = require("./orderController");
const { consumeIngredientsForOrder } = require("../services/costing-v2/orderConsumptionService");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES: ORDER_PAYMENT_STATUSES,
  buildOrderStatusUpdatedPayload,
} = require("../utils/orderContract");
const { notifyPaymentReceived } = require("../services/notificationEventService");
const { Jimp } = require("jimp");
const jsQR = require("jsqr");

const toObjectIdIfValid = (value) => {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
};

const toSocketIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const nested =
      value._id || value.id || value.cartId || value.cafeId || null;
    if (nested && nested !== value) return toSocketIdString(nested);
  }
  if (typeof value?.toString === "function") return value.toString().trim();
  return "";
};

const normalizeOrderUpsertTimestamp = (value) => {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value?.toISOString === "function") {
    try {
      return value.toISOString();
    } catch (_error) {
      return new Date().toISOString();
    }
  }
  return new Date().toISOString();
};

const buildOrderUpsertPayload = (order) => {
  const source =
    (order && typeof order.toObject === "function" && order.toObject()) ||
    (order && typeof order.toJSON === "function" && order.toJSON()) ||
    order ||
    {};
  const orderId = toSocketIdString(source._id || source.id || source.orderId);
  const cartId = toSocketIdString(source.cartId || source.cafeId);
  const statusRaw = String(source.status || "").trim();
  const paymentStatusRaw = String(source.paymentStatus || "").trim();
  const orderTypeRaw = String(
    source.orderType || source.serviceType || "",
  ).trim();

  return {
    orderId: orderId || null,
    cartId: cartId || null,
    updatedAt: normalizeOrderUpsertTimestamp(
      source.updatedAt || source.createdAt,
    ),
    status: statusRaw || null,
    paymentStatus: paymentStatusRaw || null,
    orderType: orderTypeRaw || null,
  };
};

const emitOrderUpsert = ({ io, emitToCafe, order, cartId = null }) => {
  if (!io || !emitToCafe || !order) return;
  const payload = buildOrderUpsertPayload(order);
  const resolvedCartId = toSocketIdString(cartId || payload.cartId);
  if (!resolvedCartId || !payload.orderId) return;
  emitToCafe(io, resolvedCartId, "order:upsert", payload);
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

const parseUpiPayload = (payload) => {
  if (!payload || typeof payload !== "string") return null;
  const trimmed = payload.trim();
  if (!/^upi:\/\/pay\?/i.test(trimmed)) return null;

  const query = trimmed.split("?")[1] || "";
  if (!query) return null;

  const params = new URLSearchParams(query);
  const normalized = {};
  for (const [key, value] of params.entries()) {
    const lowered = String(key || "").toLowerCase();
    if (!lowered) continue;

    let decoded = value;
    try {
      decoded = decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
    } catch (_err) {
      decoded = String(value || "");
    }
    normalized[lowered] = decoded.trim();
  }

  const upiId = normalized.pa || "";
  const payeeName = normalized.pn || "";

  if (!upiId) return null;

  return {
    upiId,
    payeeName,
    rawPayload: trimmed,
  };
};

const downloadBufferFromUrl = (url, depth = 0) =>
  new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url) || depth > 3) {
      resolve(null);
      return;
    }

    const transport = url.startsWith("https://") ? https : http;
    const request = transport.get(url, (response) => {
      const { statusCode = 0, headers = {} } = response;
      const redirectLocation = headers.location;
      if (statusCode >= 300 && statusCode < 400 && redirectLocation) {
        response.resume();
        const redirectedUrl = new URL(redirectLocation, url).toString();
        resolve(downloadBufferFromUrl(redirectedUrl, depth + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.on("error", () => resolve(null));
    request.setTimeout(10000, () => {
      request.destroy();
      resolve(null);
    });
  });

const readQrImageBuffer = async (qrImageUrl) => {
  if (!qrImageUrl) return null;

  // Local storage path style: uploads/payment-qr/xxx.png
  if (!/^https?:\/\//i.test(qrImageUrl)) {
    const normalizedRelativePath = String(qrImageUrl).replace(/^\/+/, "");
    const absolutePath = path.join(__dirname, "..", normalizedRelativePath);
    if (!fs.existsSync(absolutePath)) return null;
    return fs.promises.readFile(absolutePath);
  }

  // Remote URL (e.g., S3)
  return downloadBufferFromUrl(qrImageUrl);
};

const extractUpiFromQrImageUrl = async (qrImageUrl) => {
  try {
    const imageBuffer = await readQrImageBuffer(qrImageUrl);
    if (!imageBuffer) return null;

    const image = await Jimp.read(imageBuffer);
    const { data, width, height } = image.bitmap || {};
    if (!data || !width || !height) return null;

    const pixels = new Uint8ClampedArray(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );

    const decoded = jsQR(pixels, width, height, {
      inversionAttempts: "attemptBoth",
    });
    if (!decoded?.data) return null;

    return parseUpiPayload(decoded.data);
  } catch (error) {
    console.warn(
      "[PAYMENT] Failed to extract UPI from QR image URL:",
      error.message,
    );
    return null;
  }
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
    
    if (qrCode) {
      // Use explicit values if admin entered them.
      if (qrCode.upiId) {
        payee = qrCode.upiId.trim();
      }
      if (qrCode.gatewayName) {
        payeeName = qrCode.gatewayName.trim();
      }

      // Backfill legacy records: decode UPI details from QR image when not saved explicitly.
      if ((!qrCode.upiId || !qrCode.gatewayName) && qrCode.qrImageUrl) {
        const extracted = await extractUpiFromQrImageUrl(qrCode.qrImageUrl);
        if (extracted?.upiId) {
          payee = extracted.upiId.trim();
          if (!qrCode.upiId) {
            qrCode.upiId = extracted.upiId.trim();
          }
        }
        if (extracted?.payeeName) {
          payeeName = extracted.payeeName.trim();
          if (!qrCode.gatewayName) {
            qrCode.gatewayName = extracted.payeeName.trim();
          }
        }

        if ((qrCode.isModified?.("upiId") || qrCode.isModified?.("gatewayName"))) {
          try {
            await qrCode.save();
          } catch (saveErr) {
            console.warn(
              "[PAYMENT] Failed to persist decoded UPI details on PaymentQR:",
              saveErr.message,
            );
          }
        }
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

const isRazorpayConfigured = () =>
  Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

const buildRazorpayReceipt = (orderId) => {
  const sanitizedOrderId = String(orderId || "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(-24);
  const stamp = Date.now().toString(36).slice(-8);
  const receipt = `tc_${sanitizedOrderId || "order"}_${stamp}`;
  return receipt.slice(0, 40);
};

const createRazorpayOrder = ({ amount, orderId }) =>
  new Promise((resolve, reject) => {
    if (!isRazorpayConfigured()) {
      reject(new Error("Razorpay credentials are not configured on server."));
      return;
    }

    const amountInPaise = Math.max(0, Math.round(Number(amount || 0) * 100));
    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      reject(new Error("Invalid payment amount for Razorpay order."));
      return;
    }

    const requestBody = JSON.stringify({
      amount: amountInPaise,
      currency: "INR",
      receipt: buildRazorpayReceipt(orderId),
      notes: {
        orderId: String(orderId || ""),
      },
    });

    const basicAuth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
    ).toString("base64");

    const request = https.request(
      {
        hostname: "api.razorpay.com",
        path: "/v1/orders",
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsedBody = {};

          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch (_error) {
              reject(new Error("Unable to parse Razorpay order response."));
              return;
            }
          }

          const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
          if (isSuccess && parsedBody?.id) {
            resolve(parsedBody);
            return;
          }

          reject(
            new Error(
              parsedBody?.error?.description ||
                parsedBody?.description ||
                "Failed to create Razorpay order.",
            ),
          );
        });
      },
    );

    request.on("error", (error) => reject(error));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error("Razorpay order request timed out."));
    });

    request.write(requestBody);
    request.end();
  });

const verifyRazorpaySignature = ({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!isRazorpayConfigured()) return false;
  const payload = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest("hex");

  return expectedSignature === razorpaySignature;
};

const isRazorpayPaymentRecord = (payment) => {
  const gateway = String(payment?.metadata?.gateway || "")
    .trim()
    .toUpperCase();
  return gateway === "RAZORPAY" || Boolean(payment?.metadata?.razorpayOrderId);
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

const getKotItemsAmount = (order) => {
  if (!Array.isArray(order?.kotLines) || order.kotLines.length === 0) return 0;

  const totalInPaise = order.kotLines.reduce((kotSum, kot) => {
    const items = Array.isArray(kot?.items) ? kot.items : [];
    return (
      kotSum +
      items.reduce((itemSum, item) => {
        if (!item || item.returned) return itemSum;
        const priceInPaise = Number(item.price);
        if (!Number.isFinite(priceInPaise) || priceInPaise < 0) return itemSum;
        const qtyValue = Number(item.quantity);
        const quantity =
          Number.isFinite(qtyValue) && qtyValue > 0 ? Math.floor(qtyValue) : 0;
        return itemSum + priceInPaise * quantity;
      }, 0)
    );
  }, 0);

  return Number((totalInPaise / 100).toFixed(2));
};

const getOrderAmount = (order) => {
  const kotAmount = getKotItemsAmount(order);
  const addonsAmount = getSelectedAddonsAmount(order);
  const totalAmount = kotAmount + addonsAmount;
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;
  return Number(totalAmount.toFixed(2));
};

const normalizeOfficePaymentMode = (value, fallback = "ONLINE") => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "ONLINE" || normalized === "COD" || normalized === "BOTH") {
    return normalized;
  }
  return fallback;
};

const requiresPaymentBeforeProceeding = (order) => {
  if (!order) return false;
  if (Boolean(order.paymentRequiredBeforeProceeding)) return true;

  const normalizedSourceQrType = String(order.sourceQrType || "")
    .trim()
    .toUpperCase();
  const normalizedOfficePaymentMode = normalizeOfficePaymentMode(
    order.officePaymentMode,
    "ONLINE",
  );

  return (
    normalizedSourceQrType === "OFFICE" &&
    normalizedOfficePaymentMode === "ONLINE"
  );
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

const finalizePaidPaymentAndOrder = async ({ payment, order, req, source }) => {
  if (!payment || !order) return;

  const isPaymentFirstOrder = requiresPaymentBeforeProceeding(order);
  let needsFallbackConsumption = false;

  order.paidAt = payment.paidAt || new Date();
  order.paymentStatus = "PAID";
  order.paymentMode = payment.method === "ONLINE" ? "ONLINE" : "CASH";

  if (isPaymentFirstOrder) {
    if (order.status === "Pending") {
      order.status = "Confirmed";
    }
  } else {
    order.status = "Paid";
    needsFallbackConsumption = !order.inventoryDeducted;
    if (needsFallbackConsumption) {
      order.inventoryDeducted = true;
      order.inventoryDeductedAt = new Date();
    }
  }
  await order.save();

  const io = req.app.get("io");
  const emitToCafe = req.app.get("emitToCafe");
  if (io) {
    io.emit("paymentUpdated", formatPaymentResponse(payment));
    io.emit("orderUpdated", order);
  }
  if (order.cartId && io && emitToCafe) {
    const cartId = order.cartId.toString();
    const statusPayload = buildOrderStatusUpdatedPayload(order);
    emitToCafe(io, cartId, "order:created", order);
    emitToCafe(io, cartId, "newOrder", order);
    emitToCafe(io, cartId, "kot:created", order);
    emitToCafe(io, cartId, "order:status:updated", order);
    emitToCafe(io, cartId, "order_status_updated", statusPayload);
    emitToCafe(io, cartId, "orderUpdated", order);
    emitOrderUpsert({ io, emitToCafe, order, cartId });
    notifyPaymentReceived({
      io,
      emitToCafeFn: emitToCafe,
      order,
    }).catch((pushError) => {
      console.error(
        "[PAYMENT] payment_received notification failed:",
        pushError?.message || pushError,
      );
    });
  }

  if (!isPaymentFirstOrder) {
    await releaseTableForOrder(order, io, emitToCafe);
  }

  if (!isPaymentFirstOrder && needsFallbackConsumption) {
    const userId =
      req.user && req.user._id
        ? req.user._id
        : order.cartId && (order.cartId._id || order.cartId);

    if (userId) {
      console.log(
        `[COSTING] Fallback: Order ${order._id} paid via ${source} - triggering consumption`,
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

    const isOfficeOrder =
      String(order.sourceQrType || "").trim().toUpperCase() === "OFFICE";
    const officePaymentMode = isOfficeOrder
      ? normalizeOfficePaymentMode(order.officePaymentMode, "ONLINE")
      : null;

    if (officePaymentMode === "ONLINE" && method !== "ONLINE") {
      return res.status(400).json({
        message:
          "This office QR accepts online payment only. Please choose online payment.",
        code: "OFFICE_PAYMENT_MODE_ONLINE_ONLY",
      });
    }

    if (officePaymentMode === "COD" && method !== "CASH") {
      return res.status(400).json({
        message:
          "This office QR accepts Cash on Delivery only. Please choose cash payment.",
        code: "OFFICE_PAYMENT_MODE_COD_ONLY",
      });
    }

    const amount = getOrderAmount(order);
    if (!amount || amount <= 0) {
      return res.status(400).json({
        message: "Order has no billable amount yet. Please add items before payment.",
      });
    }

    if (method === "ONLINE" && !isRazorpayConfigured()) {
      return res.status(503).json({
        message:
          "Online payment is temporarily unavailable. Razorpay is not configured.",
        code: "RAZORPAY_NOT_CONFIGURED",
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
      const razorpayOrder = await createRazorpayOrder({ amount, orderId });
      payload.providerReference = razorpayOrder.id;
      payload.metadata = {
        gateway: "RAZORPAY",
        razorpayOrderId: razorpayOrder.id,
        razorpayReceipt: razorpayOrder.receipt || "",
        razorpayAmount: razorpayOrder.amount || Math.round(amount * 100),
        razorpayCurrency: razorpayOrder.currency || "INR",
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      };
      payload.description = description || `Razorpay payment for order ${orderId}`;
    }

    const payment = await Payment.create(payload);
    const normalizedOrderType = String(order.orderType || "")
      .trim()
      .toUpperCase();
    const normalizedServiceType = String(order.serviceType || "")
      .trim()
      .toUpperCase();
    const isPickupOrder =
      normalizedOrderType === "PICKUP" || normalizedServiceType === "PICKUP";
    const shouldAdvanceOrderForCashSelection =
      method === "CASH" &&
      (Boolean(order.paymentRequiredBeforeProceeding) ||
        (isPickupOrder && !isOfficeOrder));

    if (shouldAdvanceOrderForCashSelection) {
      order.paymentRequiredBeforeProceeding = false;
      if (order.status === "Pending") {
        order.status = "Confirmed";
      }
      order.paymentMode = "CASH";
      await order.save();
    }

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io) {
      io.emit("paymentCreated", formatPaymentResponse(payment));
      if (shouldAdvanceOrderForCashSelection) {
        io.emit("orderUpdated", order);
      }
    }

    if (shouldAdvanceOrderForCashSelection && order.cartId && io && emitToCafe) {
      emitToCafe(io, order.cartId.toString(), "order:created", order);
      emitToCafe(io, order.cartId.toString(), "newOrder", order);
      emitToCafe(io, order.cartId.toString(), "order:status:updated", order);
      emitToCafe(io, order.cartId.toString(), "orderUpdated", order);
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
      .sort({ createdAt: -1 });
    if (!payment) {
      // Return 200 with null instead of 404 - no payment yet is a valid state
      return res.json(null);
    }

    // Keep pending payment amount aligned with current order bill (all KOT lines + add-ons).
    if (["PENDING", "PROCESSING", "CASH_PENDING"].includes(payment.status)) {
      const order = await Order.findById(orderId).select(
        "kotLines selectedAddons cartId cafeId",
      );
      if (order) {
        const recalculatedAmount = getOrderAmount(order);
        const currentAmount = Number(payment.amount) || 0;
        if (
          recalculatedAmount &&
          Math.abs(recalculatedAmount - currentAmount) > 0.009
        ) {
          // Razorpay orders are amount-locked at gateway order creation time.
          // Keep recorded amount unchanged for existing Razorpay intents.
          if (!isRazorpayPaymentRecord(payment)) {
            payment.amount = recalculatedAmount;

            // Legacy UPI payload updates are only for non-Razorpay online records.
            if (payment.method === "ONLINE") {
              const cartScopeId = order.cartId || order.cafeId || null;
              payment.upiPayload = await buildUpiPayload(
                orderId,
                recalculatedAmount,
                cartScopeId,
              );
            }

            await payment.save();
          }
        }
      }
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

    await finalizePaidPaymentAndOrder({
      payment,
      order,
      req,
      source: "markPaymentPaid",
    });

    return res.json(formatPaymentResponse(payment));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.verifyRazorpayPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      razorpay_payment_id: razorpayPaymentId,
      razorpay_order_id: razorpayOrderId,
      razorpay_signature: razorpaySignature,
    } = req.body || {};

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.status(400).json({
        message:
          "razorpay_payment_id, razorpay_order_id and razorpay_signature are required.",
      });
    }

    if (!isRazorpayConfigured()) {
      return res.status(503).json({
        message:
          "Online payment verification is temporarily unavailable. Razorpay is not configured.",
        code: "RAZORPAY_NOT_CONFIGURED",
      });
    }

    const payment = await Payment.findById(id);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (payment.method !== "ONLINE") {
      return res.status(400).json({ message: "This is not an online payment." });
    }

    if (payment.status === "PAID") {
      return res.json(formatPaymentResponse(payment));
    }

    if (["CANCELLED", "FAILED"].includes(payment.status)) {
      return res.status(400).json({ message: "Payment is already finalised" });
    }

    const expectedOrderId =
      payment.metadata?.razorpayOrderId || payment.providerReference || "";
    if (!expectedOrderId || expectedOrderId !== razorpayOrderId) {
      return res.status(400).json({ message: "Razorpay order does not match payment." });
    }

    const isSignatureValid = verifyRazorpaySignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!isSignatureValid) {
      payment.status = "FAILED";
      payment.metadata = {
        ...(payment.metadata || {}),
        gateway: "RAZORPAY",
        razorpayOrderId,
        razorpayPaymentId,
        signatureVerified: false,
        verificationFailedAt: new Date().toISOString(),
      };
      await payment.save();
      const io = req.app.get("io");
      if (io) {
        io.emit("paymentUpdated", formatPaymentResponse(payment));
      }

      return res.status(400).json({ message: "Razorpay signature verification failed." });
    }

    const order = await Order.findById(payment.orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found for this payment" });
    }

    payment.status = "PAID";
    payment.paidAt = new Date();
    payment.providerReference = razorpayPaymentId;
    payment.metadata = {
      ...(payment.metadata || {}),
      gateway: "RAZORPAY",
      razorpayOrderId,
      razorpayPaymentId,
      signatureVerified: true,
      razorpayVerifiedAt: new Date().toISOString(),
    };
    await payment.save();

    await finalizePaidPaymentAndOrder({
      payment,
      order,
      req,
      source: "razorpayVerification",
    });

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
    const query = buildOrderScopeQuery(scope, {
      status: ORDER_STATUSES.COMPLETED,
      paymentStatus: ORDER_PAYMENT_STATUSES.PAID,
    });
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
