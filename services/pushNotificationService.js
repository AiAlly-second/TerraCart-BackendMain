const mongoose = require("mongoose");
const User = require("../models/userModel");
const DeviceToken = require("../models/deviceTokenModel");
const {
  admin,
  ensureFirebaseInitialized,
  getFirebaseInitError,
} = require("../config/firebase");

const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
]);

const VALID_DEVICE_PLATFORMS = new Set(["android", "ios", "web", "unknown"]);
const VALID_DEVICE_SOURCES = new Set(["app", "web", "unknown"]);

const STATUS_CATEGORY_MAP = {
  accepted: new Set(["accepted", "accept", "confirmed", "new"]),
  preparing: new Set(["preparing", "being prepared", "beingprepared"]),
  completed: new Set(["completed", "ready", "served", "exit"]),
  paid: new Set(["paid", "payment_received"]),
  cancelled: new Set(["cancelled", "canceled", "returned"]),
};

const ORDER_STATUS_TEMPLATES = {
  accepted: {
    title: "Order Accepted",
    body: "Your order has been accepted.",
  },
  preparing: {
    title: "Preparing Order",
    body: "Your food is being prepared.",
  },
  completed: {
    title: "Order Ready",
    body: "Your order is ready.",
  },
  paid: {
    title: "Payment Received",
    body: "Your payment has been received successfully.",
  },
  cancelled: {
    title: "Order Cancelled",
    body: "Your order has been cancelled.",
  },
};

const STAFF_BROADCAST_ROLES = [
  "waiter",
  "cook",
  "captain",
  "manager",
  "employee",
];

const PUSH_DEBUG_ENABLED =
  String(process.env.BACKEND_ENABLE_NOTIFICATION_DEBUG || "").toLowerCase() ===
  "true";

const writePushDebugLog = (message, metadata = null) => {
  if (!PUSH_DEBUG_ENABLED) return;
  let suffix = "";
  if (metadata && typeof metadata === "object") {
    try {
      suffix = ` ${JSON.stringify(metadata)}`;
    } catch (_error) {
      suffix = " [metadata_unserializable]";
    }
  }
  try {
    process.stdout.write(`[FCM_DEBUG] ${message}${suffix}\n`);
  } catch (_error) {
    // Ignore debug log write failures.
  }
};

const normalizeStatus = (status) => String(status || "").trim().toLowerCase();

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const maskTokenForLogs = (token) => {
  const normalized = String(token || "").trim();
  if (!normalized) return "unknown";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
};

const normalizeAnonymousSessionId = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 160) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) return "";
  return normalized;
};

const normalizeObjectId = (value) => {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) return null;
  return new mongoose.Types.ObjectId(normalized);
};

const normalizePlatform = (platform) => {
  const normalized = String(platform || "unknown").trim().toLowerCase();
  return VALID_DEVICE_PLATFORMS.has(normalized) ? normalized : "unknown";
};

const normalizeSource = (source) => {
  const normalized = String(source || "unknown").trim().toLowerCase();
  return VALID_DEVICE_SOURCES.has(normalized) ? normalized : "unknown";
};

const isInvalidTokenError = (error) => {
  const code = String(error?.code || "").trim();
  if (INVALID_TOKEN_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("registration token") ||
    message.includes("not registered") ||
    message.includes("invalid argument")
  );
};

const clearInvalidToken = async (token) => {
  if (!token) return;

  await Promise.all([
    User.updateMany(
      { fcmToken: token },
      {
        $set: {
          fcmToken: null,
          fcmTokenPlatform: "unknown",
          fcmTokenUpdatedAt: new Date(),
        },
      }
    ),
    DeviceToken.deleteMany({ token }),
  ]);
};

const toStringDataValue = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
};

const normalizeDataPayload = (data) => {
  const source = data && typeof data === "object" ? data : {};
  const normalized = {};

  Object.entries(source).forEach(([key, value]) => {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return;
    normalized[normalizedKey] = toStringDataValue(value);
  });

  return normalized;
};

const getMessagingClient = () => {
  const initialized = ensureFirebaseInitialized();
  if (!initialized || typeof admin?.messaging !== "function") {
    return null;
  }
  return admin.messaging();
};

const buildSingleMessage = (token, payload = {}) => ({
  token,
  notification: {
    title: String(payload.title || "Notification"),
    body: String(payload.body || ""),
  },
  data: normalizeDataPayload(payload.data),
  android: {
    priority: "high",
  },
  apns: {
    headers: { "apns-priority": "10" },
    payload: { aps: { sound: "default" } },
  },
});

const buildMulticastMessage = (tokens, payload = {}) => ({
  tokens,
  notification: {
    title: String(payload.title || "Notification"),
    body: String(payload.body || ""),
  },
  data: normalizeDataPayload(payload.data),
  android: {
    priority: "high",
  },
  apns: {
    headers: { "apns-priority": "10" },
    payload: { aps: { sound: "default" } },
  },
});

const normalizeTokens = (tokens) =>
  [
    ...new Set(
      (Array.isArray(tokens) ? tokens : [tokens]).map((token) =>
        String(token || "").trim()
      )
    ),
  ].filter((token) => token.length > 0);

const upsertDeviceToken = async ({
  token,
  platform = "unknown",
  userId = null,
  anonymousSessionId = null,
  cartId = null,
  source = "unknown",
  metadata = null,
} = {}) => {
  const [normalizedToken] = normalizeTokens([token]);
  if (!normalizedToken) {
    return {
      success: false,
      reason: "TOKEN_MISSING",
    };
  }

  const normalizedUserId = normalizeObjectId(userId);
  const normalizedAnonymousSessionId =
    normalizeAnonymousSessionId(anonymousSessionId);
  const normalizedCartId = normalizeObjectId(cartId);

  if (!normalizedUserId && !normalizedAnonymousSessionId) {
    return {
      success: false,
      reason: "IDENTITY_MISSING",
    };
  }

  const now = new Date();
  const identityFilters = [];
  if (normalizedUserId) {
    identityFilters.push({ userId: normalizedUserId });
  }
  if (normalizedAnonymousSessionId) {
    identityFilters.push({ anonymousSessionId: normalizedAnonymousSessionId });
  }

  if (identityFilters.length > 0) {
    await DeviceToken.updateMany(
      {
        $or: identityFilters,
        token: { $ne: normalizedToken },
      },
      {
        $set: {
          isActive: false,
          lastSeenAt: now,
        },
      }
    );
  }

  const update = {
    token: normalizedToken,
    platform: normalizePlatform(platform),
    userId: normalizedUserId || null,
    anonymousSessionId: normalizedAnonymousSessionId || null,
    cartId: normalizedCartId || null,
    source: normalizeSource(source),
    isActive: true,
    lastSeenAt: now,
  };

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    update.metadata = metadata;
  }

  const deviceToken = await DeviceToken.findOneAndUpdate(
    { token: normalizedToken },
    { $set: update },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  writePushDebugLog("Device token upserted", {
    userId: deviceToken.userId ? deviceToken.userId.toString() : null,
    anonymousSessionId: deviceToken.anonymousSessionId || null,
    cartId: deviceToken.cartId ? deviceToken.cartId.toString() : null,
    platform: deviceToken.platform,
    source: deviceToken.source,
    tokenPreview: maskTokenForLogs(deviceToken.token),
  });

  return {
    success: true,
    token: deviceToken.token,
    deviceTokenId: deviceToken._id.toString(),
    userId: deviceToken.userId ? deviceToken.userId.toString() : null,
    anonymousSessionId: deviceToken.anonymousSessionId || null,
    cartId: deviceToken.cartId ? deviceToken.cartId.toString() : null,
    platform: deviceToken.platform,
    source: deviceToken.source,
  };
};

const resolveTokensForAudience = async ({
  userId = null,
  anonymousSessionId = null,
  fallbackUserToken = null,
} = {}) => {
  const userObjectId = normalizeObjectId(userId);
  const normalizedAnonymousSessionId =
    normalizeAnonymousSessionId(anonymousSessionId);

  const audienceFilters = [];
  if (userObjectId) {
    audienceFilters.push({ userId: userObjectId });
  }
  if (normalizedAnonymousSessionId) {
    audienceFilters.push({ anonymousSessionId: normalizedAnonymousSessionId });
  }

  let deviceTokens = [];
  if (audienceFilters.length > 0) {
    const rows = await DeviceToken.find({
      $or: audienceFilters,
      isActive: true,
    })
      .select("token")
      .lean();
    deviceTokens = rows.map((row) => row.token);
  }

  return normalizeTokens([fallbackUserToken, ...deviceTokens]);
};

const sendPushToToken = async (token, payload = {}) => {
  const [normalizedToken] = normalizeTokens([token]);
  if (!normalizedToken) {
    return {
      success: false,
      reason: "TOKEN_MISSING",
    };
  }

  const messaging = getMessagingClient();
  if (!messaging) {
    writePushDebugLog("Push send skipped: firebase not configured", {
      tokenPreview: maskTokenForLogs(normalizedToken),
      initError: getFirebaseInitError() || null,
    });
    return {
      success: false,
      reason: "FIREBASE_NOT_CONFIGURED",
      error: getFirebaseInitError() || "Firebase Admin is not initialized",
    };
  }

  try {
    const messageId = await messaging.send(
      buildSingleMessage(normalizedToken, payload)
    );

    return {
      success: true,
      messageId,
      token: normalizedToken,
    };
  } catch (error) {
    const invalidToken = isInvalidTokenError(error);
    const maskedToken = maskTokenForLogs(normalizedToken);
    console.error(
      `[FCM] Failed push send to token ${maskedToken}: ${
        error?.code || "unknown"
      } ${error?.message || ""}`
    );

    if (invalidToken) {
      console.warn(`[FCM] Invalid token detected. Clearing token ${maskedToken}`);
      await clearInvalidToken(normalizedToken);
    }

    return {
      success: false,
      reason: invalidToken ? "TOKEN_INVALID" : "SEND_FAILED",
      error: error?.message || "Failed to send push notification",
      code: error?.code || null,
      invalidToken,
      token: normalizedToken,
    };
  }
};

const sendPushNotification = async ({ token, title, body, data } = {}) => {
  // Reusable single-device notification utility for controllers/jobs.
  return sendPushToToken(token, {
    title: String(title || "Notification"),
    body: String(body || ""),
    data: data && typeof data === "object" ? data : {},
  });
};

const sendPushToTokens = async (tokens, payload = {}) => {
  const normalizedTokens = normalizeTokens(tokens);
  writePushDebugLog("Push send requested", {
    tokenCount: normalizedTokens.length,
    notificationType: payload?.data?.notificationType || null,
    title: String(payload?.title || ""),
  });
  if (!normalizedTokens.length) {
    return {
      success: false,
      reason: "NO_TOKENS",
      total: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
    };
  }

  if (normalizedTokens.length === 1) {
    const single = await sendPushToToken(normalizedTokens[0], payload);
    return {
      success: single.success,
      reason: single.reason || null,
      error: single.error || null,
      code: single.code || null,
      total: 1,
      successCount: single.success ? 1 : 0,
      failureCount: single.success ? 0 : 1,
      invalidTokens: single.invalidToken ? [normalizedTokens[0]] : [],
      results: [single],
    };
  }

  const messaging = getMessagingClient();
  if (!messaging) {
    writePushDebugLog("Push multicast skipped: firebase not configured", {
      tokenCount: normalizedTokens.length,
      initError: getFirebaseInitError() || null,
    });
    return {
      success: false,
      reason: "FIREBASE_NOT_CONFIGURED",
      error: getFirebaseInitError() || "Firebase Admin is not initialized",
      total: normalizedTokens.length,
      successCount: 0,
      failureCount: normalizedTokens.length,
      invalidTokens: [],
      results: [],
    };
  }

  try {
    const response = await messaging.sendEachForMulticast(
      buildMulticastMessage(normalizedTokens, payload)
    );

    const invalidTokens = [];
    const results = response.responses.map((item, index) => {
      const token = normalizedTokens[index];
      if (item.success) {
        return {
          success: true,
          token,
          messageId: item.messageId,
        };
      }

      const invalidToken = isInvalidTokenError(item.error);
      if (invalidToken) {
        invalidTokens.push(token);
      }

      return {
        success: false,
        token,
        code: item.error?.code || null,
        error: item.error?.message || "Failed to send push notification",
        invalidToken,
      };
    });

    if (invalidTokens.length) {
      await Promise.all([
        User.updateMany(
          { fcmToken: { $in: invalidTokens } },
          {
            $set: {
              fcmToken: null,
              fcmTokenPlatform: "unknown",
              fcmTokenUpdatedAt: new Date(),
            },
          }
        ),
        DeviceToken.deleteMany({ token: { $in: invalidTokens } }),
      ]);
    }

    writePushDebugLog("Push multicast completed", {
      total: normalizedTokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidCount: invalidTokens.length,
    });

    return {
      success: response.successCount > 0,
      total: normalizedTokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
      results,
    };
  } catch (error) {
    writePushDebugLog("Push multicast failed", {
      total: normalizedTokens.length,
      code: error?.code || null,
      error: error?.message || "unknown",
    });
    return {
      success: false,
      reason: "MULTICAST_SEND_FAILED",
      error: error?.message || "Failed to send multicast notification",
      code: error?.code || null,
      total: normalizedTokens.length,
      successCount: 0,
      failureCount: normalizedTokens.length,
      invalidTokens: [],
      results: [],
    };
  }
};

const sendPushToUser = async (user, payload = {}) => {
  if (!user?._id) {
    return {
      success: false,
      reason: "USER_NOT_FOUND",
    };
  }

  const tokens = await resolveTokensForAudience({
    userId: user._id,
    fallbackUserToken: user.fcmToken,
  });

  if (!tokens.length) {
    return {
      success: false,
      reason: "TOKEN_MISSING",
      userId: user._id.toString(),
    };
  }

  const result = await sendPushToTokens(tokens, payload);
  return {
    ...result,
    userId: user._id.toString(),
    tokenCount: tokens.length,
  };
};

const sendPushToAudience = async (
  { userId = null, anonymousSessionId = null, fallbackUserToken = null } = {},
  payload = {}
) => {
  const tokens = await resolveTokensForAudience({
    userId,
    anonymousSessionId,
    fallbackUserToken,
  });

  if (!tokens.length) {
    return {
      success: false,
      reason: "TOKEN_MISSING",
      userId: userId ? String(userId) : null,
      anonymousSessionId: normalizeAnonymousSessionId(anonymousSessionId) || null,
    };
  }

  const result = await sendPushToTokens(tokens, payload);
  return {
    ...result,
    userId: userId ? String(userId) : null,
    anonymousSessionId: normalizeAnonymousSessionId(anonymousSessionId) || null,
    tokenCount: tokens.length,
  };
};

const resolveStatusCategory = (status) => {
  const normalized = normalizeStatus(status);

  for (const [category, statuses] of Object.entries(STATUS_CATEGORY_MAP)) {
    if (statuses.has(normalized)) {
      return category;
    }
  }

  return null;
};

const resolveOrderNotificationUser = async (order) => {
  if (!order) return null;

  const orderUserId = order.userId || order.customerId || null;
  if (orderUserId && mongoose.Types.ObjectId.isValid(String(orderUserId))) {
    const byId = await User.findById(orderUserId).select(
      "_id fcmToken email phone mobile"
    );
    if (byId) return byId;
  }

  const customerEmail = String(order.customerEmail || "").trim().toLowerCase();
  if (customerEmail) {
    const byEmail = await User.findOne({
      email: { $regex: `^${escapeRegex(customerEmail)}$`, $options: "i" },
    }).select("_id fcmToken email phone mobile");
    if (byEmail) return byEmail;
  }

  const customerPhone = String(order.customerMobile || order.customerPhone || "")
    .trim()
    .replace(/\s+/g, "");
  if (customerPhone) {
    const byPhone = await User.findOne({
      $or: [{ phone: customerPhone }, { mobile: customerPhone }],
    }).select("_id fcmToken email phone mobile");
    if (byPhone) return byPhone;
  }

  return null;
};

const sendOrderStatusNotification = async (order, nextStatus) => {
  const statusCategory = resolveStatusCategory(nextStatus);
  if (!statusCategory) {
    return {
      success: false,
      skipped: true,
      reason: "STATUS_NOT_NOTIFIABLE",
    };
  }

  const targetUser = await resolveOrderNotificationUser(order);
  const targetUserId = targetUser?._id ? String(targetUser._id) : null;
  const targetAnonymousSessionId = normalizeAnonymousSessionId(
    order?.anonymousSessionId || ""
  );

  if (!targetUserId && !targetAnonymousSessionId) {
    return {
      success: false,
      skipped: true,
      reason: "ORDER_AUDIENCE_NOT_FOUND",
    };
  }

  const template = ORDER_STATUS_TEMPLATES[statusCategory];
  const payload = {
    title: template.title,
    body: template.body,
    data: {
      notificationType: "order_status",
      orderId: String(order?._id || ""),
      orderStatus: String(nextStatus || ""),
      serviceType: String(order?.serviceType || ""),
      orderType: String(order?.orderType || ""),
      cartId: String(order?.cartId || ""),
      anonymousSessionId: targetAnonymousSessionId || "",
    },
  };

  writePushDebugLog("Order status push requested", {
    orderId: String(order?._id || ""),
    status: String(nextStatus || ""),
    statusCategory,
    userId: targetUserId,
    anonymousSessionId: targetAnonymousSessionId || null,
  });

  const result = await sendPushToAudience(
    {
      userId: targetUserId,
      anonymousSessionId: targetAnonymousSessionId,
      fallbackUserToken: targetUser?.fcmToken || null,
    },
    payload
  );

  writePushDebugLog("Order status push completed", {
    orderId: String(order?._id || ""),
    status: String(nextStatus || ""),
    success: !!result?.success,
    reason: result?.reason || null,
    tokenCount: result?.tokenCount || 0,
    successCount: result?.successCount || 0,
    failureCount: result?.failureCount || 0,
  });

  return result;
};

const buildStaffOrderNotificationBody = (order) => {
  const orderId = String(order?._id || "").trim();
  const orderType = String(order?.orderType || order?.serviceType || "")
    .trim()
    .toUpperCase();
  const tokenText = Number.isInteger(order?.takeawayToken)
    ? ` #${order.takeawayToken}`
    : "";

  if (orderType === "DELIVERY") {
    return `New delivery order${tokenText} received${orderId ? ` (${orderId})` : ""}.`;
  }
  if (orderType === "PICKUP") {
    return `New pickup order${tokenText} received${orderId ? ` (${orderId})` : ""}.`;
  }
  return `New order${tokenText} received${orderId ? ` (${orderId})` : ""}.`;
};

const sendNewOrderNotificationToCartStaff = async (order) => {
  const cartObjectId = normalizeObjectId(order?.cartId);
  if (!cartObjectId) {
    return {
      success: false,
      skipped: true,
      reason: "CART_NOT_FOUND",
    };
  }

  const recipients = await User.find({
    role: { $in: STAFF_BROADCAST_ROLES },
    $or: [{ cartId: cartObjectId }, { cafeId: cartObjectId }],
  })
    .select("_id fcmToken")
    .lean();

  const userIds = recipients
    .map((recipient) => normalizeObjectId(recipient?._id))
    .filter(Boolean);

  const deviceTokenRows = userIds.length
    ? await DeviceToken.find({
        userId: { $in: userIds },
        isActive: true,
      })
        .select("token")
        .lean()
    : [];

  const tokens = normalizeTokens([
    ...deviceTokenRows.map((row) => row.token),
    ...recipients.map((recipient) => recipient?.fcmToken),
  ]);

  writePushDebugLog("New-order push audience resolved", {
    orderId: String(order?._id || ""),
    cartId: cartObjectId.toString(),
    recipients: recipients.length,
    tokenCount: tokens.length,
  });

  if (!tokens.length) {
    return {
      success: false,
      skipped: true,
      reason: "TOKEN_MISSING",
      recipients: recipients.length,
      tokenCount: 0,
    };
  }

  const payload = {
    title: "New Order",
    body: buildStaffOrderNotificationBody(order),
    data: {
      notificationType: "new_order",
      event: "order:created",
      orderId: String(order?._id || ""),
      orderStatus: String(order?.status || ""),
      lifecycleStatus: String(order?.lifecycleStatus || ""),
      serviceType: String(order?.serviceType || ""),
      orderType: String(order?.orderType || ""),
      cartId: cartObjectId.toString(),
      tableNumber: String(order?.tableNumber || ""),
      takeawayToken: Number.isInteger(order?.takeawayToken)
        ? String(order.takeawayToken)
        : "",
    },
  };

  const result = await sendPushToTokens(tokens, payload);
  return {
    ...result,
    recipients: recipients.length,
    tokenCount: tokens.length,
    orderId: String(order?._id || ""),
    cartId: cartObjectId.toString(),
  };
};

module.exports = {
  normalizeAnonymousSessionId,
  upsertDeviceToken,
  sendPushNotification,
  sendPushToToken,
  sendPushToTokens,
  sendPushToUser,
  sendPushToAudience,
  sendOrderStatusNotification,
  resolveStatusCategory,
  sendNewOrderNotificationToCartStaff,
};
