const mongoose = require("mongoose");
const User = require("../models/userModel");
const Employee = require("../models/employeeModel");
const DeviceToken = require("../models/deviceTokenModel");
const {
  sendOrderStatusNotification,
  sendNewOrderNotificationToCartStaff,
  sendPushToTokens,
} = require("./pushNotificationService");

const NOTIFICATION_EVENT_TYPES = Object.freeze({
  NEW_ORDER: "new_order",
  ORDER_READY: "order_ready",
  ASSISTANCE_REQUEST: "assistance_request",
  PAYMENT_RECEIVED: "payment_received",
  ORDER_CANCELLED: "order_cancelled",
});

const NOTIFICATION_LOG_PREFIX = "[NOTIFICATION_EVENT]";

const toObjectId = (value) => {
  if (!value) return null;
  const token =
    typeof value === "string"
      ? value.trim()
      : typeof value?.toString === "function"
        ? value.toString().trim()
        : "";
  if (!token || !mongoose.Types.ObjectId.isValid(token)) return null;
  return new mongoose.Types.ObjectId(token);
};

const toObjectIdString = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value?.toString === "function") {
    const token = value.toString().trim();
    return token || null;
  }
  return null;
};

const logNotificationEvent = (message, metadata = null) => {
  const suffix =
    metadata && typeof metadata === "object"
      ? ` ${JSON.stringify(metadata)}`
      : "";
  console.log(`${NOTIFICATION_LOG_PREFIX} ${message}${suffix}`);
};

const emitToCafe = ({ io, emitToCafeFn, cartId, event, payload }) => {
  const cartIdStr = toObjectIdString(cartId);
  if (!io || !emitToCafeFn || !cartIdStr) return;
  emitToCafeFn(io, cartIdStr, event, payload);
  logNotificationEvent("socket emit", {
    event,
    cartId: cartIdStr,
    orderId:
      payload?.orderId || payload?._id || payload?.order?._id || null,
    requestId: payload?._id || payload?.id || null,
  });
};

const resolveAudienceTokens = async ({
  cartId = null,
  roles = [],
  userIds = [],
}) => {
  const cartObjectId = toObjectId(cartId);
  const normalizedRoles = roles
    .map((role) => String(role || "").trim().toLowerCase())
    .filter(Boolean);
  const normalizedUserIds = userIds
    .map((id) => toObjectId(id))
    .filter(Boolean);

  const userQuery = [];
  if (cartObjectId) {
    userQuery.push({
      $or: [{ cartId: cartObjectId }, { cafeId: cartObjectId }, { _id: cartObjectId }],
    });
  }
  if (normalizedRoles.length) {
    userQuery.push({ role: { $in: normalizedRoles } });
  }
  if (normalizedUserIds.length) {
    userQuery.push({ _id: { $in: normalizedUserIds } });
  }

  const query = userQuery.length ? { $and: userQuery } : {};
  const users = await User.find(query).select("_id fcmToken").lean();
  const userIdSet = new Set(
    users
      .map((user) => toObjectIdString(user?._id))
      .filter(Boolean),
  );
  normalizedUserIds.forEach((id) => {
    const token = toObjectIdString(id);
    if (token) userIdSet.add(token);
  });

  const deviceTokenRows = userIdSet.size
    ? await DeviceToken.find({
        userId: { $in: Array.from(userIdSet).map((id) => new mongoose.Types.ObjectId(id)) },
        isActive: true,
      })
        .select("token")
        .lean()
    : [];

  const tokens = new Set();
  users.forEach((user) => {
    const token = String(user?.fcmToken || "").trim();
    if (token) tokens.add(token);
  });
  deviceTokenRows.forEach((row) => {
    const token = String(row?.token || "").trim();
    if (token) tokens.add(token);
  });

  return Array.from(tokens);
};

const notifyNewOrder = async ({ io, emitToCafeFn, order }) => {
  const cartId = order?.cartId || order?.cafeId || null;
  emitToCafe({
    io,
    emitToCafeFn,
    cartId,
    event: NOTIFICATION_EVENT_TYPES.NEW_ORDER,
    payload: {
      orderId: toObjectIdString(order?._id),
      status: order?.status || null,
      paymentStatus: order?.paymentStatus || null,
      updatedAt: order?.updatedAt || order?.createdAt || new Date().toISOString(),
    },
  });
  logNotificationEvent("push dispatch start", {
    event: NOTIFICATION_EVENT_TYPES.NEW_ORDER,
    orderId: toObjectIdString(order?._id),
    cartId: toObjectIdString(cartId),
  });
  const pushResult = await sendNewOrderNotificationToCartStaff(order);
  logNotificationEvent("push dispatch end", {
    event: NOTIFICATION_EVENT_TYPES.NEW_ORDER,
    orderId: toObjectIdString(order?._id),
    success: !!pushResult?.success,
    reason: pushResult?.reason || null,
    tokenCount: pushResult?.tokenCount || 0,
  });
  return pushResult;
};

const notifyOrderReady = async ({ io, emitToCafeFn, order }) => {
  const cartId = order?.cartId || null;
  emitToCafe({
    io,
    emitToCafeFn,
    cartId,
    event: NOTIFICATION_EVENT_TYPES.ORDER_READY,
    payload: {
      orderId: toObjectIdString(order?._id),
      status: order?.status || null,
      paymentStatus: order?.paymentStatus || null,
      updatedAt: order?.updatedAt || new Date().toISOString(),
    },
  });
  logNotificationEvent("push dispatch start", {
    event: NOTIFICATION_EVENT_TYPES.ORDER_READY,
    orderId: toObjectIdString(order?._id),
  });
  const pushResult = await sendOrderStatusNotification(order, "READY");
  logNotificationEvent("push dispatch end", {
    event: NOTIFICATION_EVENT_TYPES.ORDER_READY,
    orderId: toObjectIdString(order?._id),
    success: !!pushResult?.success,
    reason: pushResult?.reason || null,
    tokenCount: pushResult?.tokenCount || 0,
  });
  return pushResult;
};

const notifyPaymentReceived = async ({ io, emitToCafeFn, order }) => {
  const cartId = order?.cartId || null;
  emitToCafe({
    io,
    emitToCafeFn,
    cartId,
    event: NOTIFICATION_EVENT_TYPES.PAYMENT_RECEIVED,
    payload: {
      orderId: toObjectIdString(order?._id),
      status: order?.status || null,
      paymentStatus: order?.paymentStatus || null,
      updatedAt: order?.updatedAt || new Date().toISOString(),
    },
  });
  logNotificationEvent("push dispatch start", {
    event: NOTIFICATION_EVENT_TYPES.PAYMENT_RECEIVED,
    orderId: toObjectIdString(order?._id),
  });
  const pushResult = await sendOrderStatusNotification(order, "PAID");
  logNotificationEvent("push dispatch end", {
    event: NOTIFICATION_EVENT_TYPES.PAYMENT_RECEIVED,
    orderId: toObjectIdString(order?._id),
    success: !!pushResult?.success,
    reason: pushResult?.reason || null,
    tokenCount: pushResult?.tokenCount || 0,
  });
  return pushResult;
};

const notifyOrderCancelled = async ({ io, emitToCafeFn, order, reason = null }) => {
  const cartId = order?.cartId || null;
  emitToCafe({
    io,
    emitToCafeFn,
    cartId,
    event: NOTIFICATION_EVENT_TYPES.ORDER_CANCELLED,
    payload: {
      orderId: toObjectIdString(order?._id),
      status: order?.status || null,
      paymentStatus: order?.paymentStatus || null,
      updatedAt: order?.updatedAt || new Date().toISOString(),
      reason: reason || null,
    },
  });
  logNotificationEvent("push dispatch start", {
    event: NOTIFICATION_EVENT_TYPES.ORDER_CANCELLED,
    orderId: toObjectIdString(order?._id),
  });
  const pushResult = await sendOrderStatusNotification(order, "CANCELLED");
  logNotificationEvent("push dispatch end", {
    event: NOTIFICATION_EVENT_TYPES.ORDER_CANCELLED,
    orderId: toObjectIdString(order?._id),
    success: !!pushResult?.success,
    reason: pushResult?.reason || null,
    tokenCount: pushResult?.tokenCount || 0,
  });
  return pushResult;
};

const notifyAssistanceRequestCreated = async ({
  io,
  emitToCafeFn,
  request,
}) => {
  const cartId = request?.cartId || request?.cafeId || null;
  const requestId = toObjectIdString(request?._id) || toObjectIdString(request?.id);

  emitToCafe({
    io,
    emitToCafeFn,
    cartId,
    event: "assistance_request_created",
    payload: request,
  });

  const assignedUserIds = [];
  const directAssigned = toObjectId(request?.assignedToUser);
  if (directAssigned) {
    assignedUserIds.push(directAssigned);
  }

  if (!directAssigned && request?.assignedTo) {
    const employee = await Employee.findById(request.assignedTo)
      .select("userId")
      .lean();
    const employeeUserId = toObjectId(employee?.userId);
    if (employeeUserId) {
      assignedUserIds.push(employeeUserId);
    }
  }

  const tokens = await resolveAudienceTokens({
    cartId,
    roles: ["admin", "franchise_admin", "manager", "cook", "kitchen"],
    userIds: assignedUserIds,
  });

  logNotificationEvent("push dispatch start", {
    event: NOTIFICATION_EVENT_TYPES.ASSISTANCE_REQUEST,
    requestId,
    cartId: toObjectIdString(cartId),
    tokenCount: tokens.length,
  });

  if (!tokens.length) {
    return {
      success: false,
      skipped: true,
      reason: "TOKEN_MISSING",
    };
  }

  const tableLabel =
    request?.tableId?.number || request?.tableNumber || request?.tableNo || "N/A";
  const pushResult = await sendPushToTokens(tokens, {
    title: "Assistance Request",
    body: `New assistance request from table ${tableLabel}.`,
    data: {
      notificationType: NOTIFICATION_EVENT_TYPES.ASSISTANCE_REQUEST,
      requestId: requestId || "",
      cartId: toObjectIdString(cartId) || "",
      orderId: toObjectIdString(request?.orderId) || "",
      requestType: String(request?.requestType || "assistance"),
      status: String(request?.status || "pending"),
    },
  });

  logNotificationEvent("push dispatch end", {
    event: NOTIFICATION_EVENT_TYPES.ASSISTANCE_REQUEST,
    requestId,
    success: !!pushResult?.success,
    reason: pushResult?.reason || null,
    tokenCount: tokens.length,
    successCount: pushResult?.successCount || 0,
    failureCount: pushResult?.failureCount || 0,
  });

  return pushResult;
};

module.exports = {
  NOTIFICATION_EVENT_TYPES,
  notifyNewOrder,
  notifyOrderReady,
  notifyPaymentReceived,
  notifyOrderCancelled,
  notifyAssistanceRequestCreated,
};
