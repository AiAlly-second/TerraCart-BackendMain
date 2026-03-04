const mongoose = require("mongoose");
const User = require("../models/userModel");
const DeviceToken = require("../models/deviceTokenModel");
const {
  normalizeAnonymousSessionId,
  upsertDeviceToken,
  sendPushNotification,
  sendPushToTokens,
  sendPushToUser,
} = require("../services/pushNotificationService");

const VALID_FCM_PLATFORMS = new Set(["android", "ios", "web", "unknown"]);
const NOTIFICATION_DEBUG_ENABLED =
  String(process.env.BACKEND_ENABLE_NOTIFICATION_DEBUG || "").toLowerCase() ===
  "true";

const writeNotificationDebugLog = (message, metadata = null) => {
  if (!NOTIFICATION_DEBUG_ENABLED) return;
  let suffix = "";
  if (metadata && typeof metadata === "object") {
    try {
      suffix = ` ${JSON.stringify(metadata)}`;
    } catch (_error) {
      suffix = " [metadata_unserializable]";
    }
  }
  try {
    process.stdout.write(`[NOTIFICATION_DEBUG] ${message}${suffix}\n`);
  } catch (_error) {
    // Ignore debug log write failures.
  }
};

const normalizePlatform = (platform) => {
  const normalized = String(platform || "unknown").trim().toLowerCase();
  return VALID_FCM_PLATFORMS.has(normalized) ? normalized : "unknown";
};

const readFirstEnvValue = (keys = []) => {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
};

const toObjectIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value.toString === "function") return value.toString().trim();
  return "";
};

const isUserInAdminCartScope = (adminUser, targetUser) => {
  const adminId = toObjectIdString(adminUser?._id);
  if (!adminId) return false;

  const targetId = toObjectIdString(targetUser?._id);
  const targetCafeId = toObjectIdString(targetUser?.cafeId);
  const targetCartId = toObjectIdString(targetUser?.cartId);

  return (
    targetId === adminId ||
    targetCafeId === adminId ||
    targetCartId === adminId
  );
};

const canManageTargetUser = (requestUser, targetUser) => {
  if (!requestUser || !targetUser) return false;

  const requesterRole = String(requestUser.role || "").toLowerCase();
  const requesterId = toObjectIdString(requestUser._id);
  const targetId = toObjectIdString(targetUser._id);

  if (requesterId && targetId && requesterId === targetId) {
    return true;
  }

  if (requesterRole === "super_admin") {
    return true;
  }

  if (requesterRole === "franchise_admin") {
    const targetFranchiseId = toObjectIdString(targetUser.franchiseId);
    return targetFranchiseId && targetFranchiseId === requesterId;
  }

  if (requesterRole === "admin" || requesterRole === "cart_admin") {
    return isUserInAdminCartScope(requestUser, targetUser);
  }

  return false;
};

const resolveCartIdForBroadcast = async (requestUser, providedCartId) => {
  const requesterRole = String(requestUser?.role || "").toLowerCase();
  const requesterId = toObjectIdString(requestUser?._id);
  const requestedCartId = toObjectIdString(providedCartId);

  if (requesterRole === "admin" || requesterRole === "cart_admin") {
    if (requestedCartId && requestedCartId !== requesterId) {
      return {
        ok: false,
        status: 403,
        message:
          "Access denied. Cart admin can send broadcasts only for their own cart.",
      };
    }

    return { ok: true, cartId: requesterId };
  }

  if (!requestedCartId) {
    return {
      ok: false,
      status: 400,
      message: "cartId is required for this role.",
    };
  }

  if (!mongoose.Types.ObjectId.isValid(requestedCartId)) {
    return {
      ok: false,
      status: 400,
      message: "Invalid cartId.",
    };
  }

  const cartAdmin = await User.findById(requestedCartId)
    .select("_id role franchiseId")
    .lean();

  if (!cartAdmin || cartAdmin.role !== "admin") {
    return {
      ok: false,
      status: 404,
      message: "Cart admin not found for cartId.",
    };
  }

  if (requesterRole === "franchise_admin") {
    const cartFranchiseId = toObjectIdString(cartAdmin.franchiseId);
    if (!cartFranchiseId || cartFranchiseId !== requesterId) {
      return {
        ok: false,
        status: 403,
        message: "Access denied. Cart does not belong to your franchise.",
      };
    }
  }

  return { ok: true, cartId: requestedCartId };
};

const saveFcmToken = async (req, res) => {
  try {
    const {
      userId,
      firebaseToken,
      token,
      platform,
      cartId,
      source,
      metadata,
    } =
      req.body || {};
    const rawHeaderAnonymousSessionId =
      req.headers["x-anonymous-session-id"] || req.headers["x-session-id"];
    const headerAnonymousSessionId = Array.isArray(rawHeaderAnonymousSessionId)
      ? rawHeaderAnonymousSessionId[0]
      : rawHeaderAnonymousSessionId;
    const normalizedAnonymousSessionId = normalizeAnonymousSessionId(
      req.body?.anonymousSessionId || headerAnonymousSessionId
    );
    const normalizedToken = String(firebaseToken || token || "").trim();
    const normalizedUserId = String(userId || "").trim();

    let user = null;
    if (normalizedUserId) {
      if (!mongoose.Types.ObjectId.isValid(normalizedUserId)) {
        return res.status(400).json({ message: "Invalid userId." });
      }

      if (!req.user) {
        return res.status(401).json({
          message: "Authentication is required when saving token for userId.",
        });
      }

      user = await User.findById(normalizedUserId);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      if (!canManageTargetUser(req.user, user)) {
        return res.status(403).json({
          message: "Access denied. You cannot update this user's FCM token.",
        });
      }
    }

    if (!user && !normalizedAnonymousSessionId) {
      return res.status(400).json({
        message:
          "Either userId or anonymousSessionId is required to save FCM token.",
      });
    }

    const now = new Date();
    const deactivateFilters = [];
    if (user?._id) {
      deactivateFilters.push({ userId: user._id });
    }
    if (normalizedAnonymousSessionId) {
      deactivateFilters.push({
        anonymousSessionId: normalizedAnonymousSessionId,
      });
    }

    if (!normalizedToken) {
      if (user) {
        user.fcmToken = null;
        user.fcmTokenPlatform = "unknown";
        user.fcmTokenUpdatedAt = now;
        await user.save();
      }

      if (deactivateFilters.length > 0) {
        await DeviceToken.updateMany(
          {
            $or: deactivateFilters,
            isActive: true,
          },
          {
            $set: {
              isActive: false,
              lastSeenAt: now,
            },
          }
        );
      }

      writeNotificationDebugLog("FCM token cleared", {
        requesterId: toObjectIdString(req.user?._id),
        userId: user?._id ? user._id.toString() : null,
        anonymousSessionId: normalizedAnonymousSessionId || null,
      });

      return res.json({
        success: true,
        message: "FCM token cleared successfully.",
        data: {
          userId: user?._id || null,
          anonymousSessionId: normalizedAnonymousSessionId || null,
          hasToken: false,
          platform: "unknown",
          updatedAt: now,
        },
      });
    }

    const deviceTokenResult = await upsertDeviceToken({
      token: normalizedToken,
      platform: normalizePlatform(platform),
      userId: user?._id || null,
      anonymousSessionId: normalizedAnonymousSessionId || null,
      cartId: cartId || req.user?.cartId || req.user?.cafeId || null,
      source,
      metadata,
    });

    if (!deviceTokenResult.success) {
      return res.status(400).json({
        success: false,
        message: deviceTokenResult.reason || "Failed to save device token.",
        result: deviceTokenResult,
      });
    }

    if (user) {
      user.fcmToken = normalizedToken;
      user.fcmTokenPlatform = normalizePlatform(platform);
      user.fcmTokenUpdatedAt = now;
      await user.save();
    }

    writeNotificationDebugLog("FCM token registered", {
      requesterId: toObjectIdString(req.user?._id),
      userId: user?._id ? user._id.toString() : null,
      anonymousSessionId: normalizedAnonymousSessionId || null,
      cartId: toObjectIdString(deviceTokenResult.cartId || cartId),
      platform: normalizePlatform(platform),
      tokenPreview:
        normalizedToken.length > 12
          ? `${normalizedToken.slice(0, 6)}...${normalizedToken.slice(-6)}`
          : normalizedToken,
    });

    return res.json({
      success: true,
      message: "FCM token saved successfully.",
      data: {
        userId: user?._id || null,
        anonymousSessionId: normalizedAnonymousSessionId || null,
        hasToken: true,
        platform: normalizePlatform(platform),
        updatedAt: now,
      },
      deviceToken: deviceTokenResult,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to save FCM token.",
    });
  }
};

const getFirebaseWebConfig = async (_req, res) => {
  try {
    const projectId = readFirstEnvValue(["FIREBASE_PROJECT_ID"]);
    const messagingSenderId = readFirstEnvValue([
      "FIREBASE_WEB_MESSAGING_SENDER_ID",
      "FIREBASE_MESSAGING_SENDER_ID",
    ]);
    const apiKey = readFirstEnvValue([
      "FIREBASE_WEB_API_KEY",
      "FIREBASE_API_KEY",
    ]);
    const appId = readFirstEnvValue(["FIREBASE_WEB_APP_ID"]);
    const authDomain =
      readFirstEnvValue(["FIREBASE_WEB_AUTH_DOMAIN"]) ||
      (projectId ? `${projectId}.firebaseapp.com` : "");
    const storageBucket =
      readFirstEnvValue(["FIREBASE_WEB_STORAGE_BUCKET"]) ||
      (projectId ? `${projectId}.firebasestorage.app` : "");
    const vapidKey = readFirstEnvValue(["FIREBASE_WEB_VAPID_KEY"]);

    const hasMessagingConfig =
      !!projectId && !!messagingSenderId && !!apiKey && !!appId;

    return res.json({
      success: true,
      enabled: hasMessagingConfig,
      config: hasMessagingConfig
        ? {
            apiKey,
            authDomain,
            projectId,
            storageBucket,
            messagingSenderId,
            appId,
          }
        : null,
      vapidKey: vapidKey || null,
      missing: hasMessagingConfig
        ? []
        : [
            !projectId ? "FIREBASE_PROJECT_ID" : null,
            !messagingSenderId
              ? "FIREBASE_WEB_MESSAGING_SENDER_ID (or FIREBASE_MESSAGING_SENDER_ID)"
              : null,
            !apiKey ? "FIREBASE_WEB_API_KEY (or FIREBASE_API_KEY)" : null,
            !appId ? "FIREBASE_WEB_APP_ID" : null,
          ].filter(Boolean),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      enabled: false,
      message: error.message || "Failed to load Firebase web config.",
    });
  }
};

const sendNotificationToUser = async (req, res) => {
  try {
    const { userId, title, body, data } = req.body || {};

    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ message: "Valid userId is required." });
    }
    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "title is required." });
    }
    if (!String(body || "").trim()) {
      return res.status(400).json({ message: "body is required." });
    }

    const user = await User.findById(userId).select(
      "_id role franchiseId cartId cafeId fcmToken"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (!canManageTargetUser(req.user, user)) {
      return res.status(403).json({
        message: "Access denied. You cannot notify this user.",
      });
    }

    writeNotificationDebugLog("push attempt user", {
      requesterId: toObjectIdString(req.user?._id),
      userId: toObjectIdString(user._id),
      title: String(title).trim(),
    });

    const result = await sendPushToUser(user, {
      title: String(title).trim(),
      body: String(body).trim(),
      data: data && typeof data === "object" ? data : {},
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message:
          result.reason === "TOKEN_MISSING"
            ? "Target user does not have an FCM token."
            : result.error || "Failed to send notification.",
        result,
      });
    }

    return res.json({
      success: true,
      message: "Notification sent successfully.",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send notification.",
    });
  }
};

const buildBroadcastDefaults = (type) => {
  const normalizedType = String(type || "custom").trim().toLowerCase();
  if (normalizedType === "test") {
    return {
      type: "test",
      title: "Test Notification",
      body: "This is a test notification from your cart admin.",
    };
  }

  if (normalizedType === "maintenance") {
    return {
      type: "maintenance",
      title: "Maintenance Update",
      body: "Scheduled maintenance is in progress. Please check updates in the app.",
    };
  }

  return {
    type: "custom",
    title: "Cart Announcement",
    body: "You have a new announcement from your cart admin.",
  };
};

const sendCartBroadcastNotification = async (req, res) => {
  try {
    const { cartId, type, title, body, data, includeCartAdmin = false } =
      req.body || {};

    const cartContext = await resolveCartIdForBroadcast(req.user, cartId);
    if (!cartContext.ok) {
      return res.status(cartContext.status).json({ message: cartContext.message });
    }

    const resolvedCartId = cartContext.cartId;
    const defaults = buildBroadcastDefaults(type);
    const finalTitle = String(title || defaults.title).trim();
    const finalBody = String(body || defaults.body).trim();

    if (!finalTitle || !finalBody) {
      return res.status(400).json({
        message: "title and body are required for broadcast notifications.",
      });
    }

    const cartObjectId = new mongoose.Types.ObjectId(resolvedCartId);
    const staffRoles = ["waiter", "cook", "captain", "manager", "employee"];

    const recipients = await User.find({
      role: { $in: staffRoles },
      $or: [{ cafeId: cartObjectId }, { cartId: cartObjectId }],
    })
      .select("_id name role fcmToken")
      .lean();

    if (includeCartAdmin) {
      const cartAdmin = await User.findById(cartObjectId)
        .select("_id name role fcmToken")
        .lean();
      if (cartAdmin) {
        recipients.push(cartAdmin);
      }
    }

    const recipientById = new Map();
    for (const recipient of recipients) {
      const recipientId = toObjectIdString(recipient?._id);
      if (!recipientId || recipientById.has(recipientId)) continue;
      recipientById.set(recipientId, recipient);
    }
    const uniqueRecipients = Array.from(recipientById.values());

    const recipientObjectIds = Array.from(recipientById.keys())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const deviceTokenRows = recipientObjectIds.length
      ? await DeviceToken.find({
          userId: { $in: recipientObjectIds },
          isActive: true,
        })
          .select("token userId")
          .lean()
      : [];

    const tokenSet = new Set();
    const recipientsWithTokenIds = new Set();

    for (const row of deviceTokenRows) {
      const token = String(row?.token || "").trim();
      const rowUserId = toObjectIdString(row?.userId);
      if (!token || !rowUserId) continue;
      tokenSet.add(token);
      recipientsWithTokenIds.add(rowUserId);
    }

    for (const recipient of uniqueRecipients) {
      const fallbackToken = String(recipient?.fcmToken || "").trim();
      if (!fallbackToken) continue;
      tokenSet.add(fallbackToken);
      const recipientId = toObjectIdString(recipient?._id);
      if (recipientId) {
        recipientsWithTokenIds.add(recipientId);
      }
    }

    const recipientsWithToken = uniqueRecipients.filter((recipient) =>
      recipientsWithTokenIds.has(toObjectIdString(recipient?._id))
    );
    const tokens = Array.from(tokenSet);

    writeNotificationDebugLog("cart broadcast push attempt", {
      requesterId: toObjectIdString(req.user?._id),
      cartId: resolvedCartId,
      recipients: uniqueRecipients.length,
      tokenCount: tokens.length,
      type: defaults.type,
    });

    const result = await sendPushToTokens(tokens, {
      title: finalTitle,
      body: finalBody,
      data: {
        ...(data && typeof data === "object" ? data : {}),
        notificationType: "cart_broadcast",
        broadcastType: defaults.type,
        cartId: resolvedCartId,
        sentByUserId: toObjectIdString(req.user?._id),
      },
    });

    const failureDetails = (result.results || [])
      .filter((item) => item && item.success === false)
      .map((item) => ({
        reason: item.reason || null,
        code: item.code || null,
        error: item.error || null,
        invalidToken: !!item.invalidToken,
      }));

    return res.json({
      success: result.success,
      message: result.success
        ? "Broadcast notification processed."
        : result.error ||
          failureDetails[0]?.error ||
          "Broadcast notification failed.",
      summary: {
        cartId: resolvedCartId,
        broadcastType: defaults.type,
        totalRecipients: uniqueRecipients.length,
        recipientsWithToken: recipientsWithToken.length,
        recipientsWithoutToken:
          uniqueRecipients.length - recipientsWithToken.length,
        totalTokens: tokens.length,
        successCount: result.successCount || 0,
        failureCount: result.failureCount || 0,
        invalidTokens: result.invalidTokens || [],
        failureReasons: failureDetails.map(
          (item) => item.reason || item.code || "SEND_FAILED"
        ),
        failureDetails,
      },
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send cart broadcast notification.",
    });
  }
};

const testPushToToken = async (req, res) => {
  try {
    // Prefer POST body; keep query fallback for old GET callers.
    const token = String(req.body?.token || req.query?.token || "").trim();
    const title = String(req.body?.title || "Test Push").trim();
    const body = String(
      req.body?.body || "FCM test notification from TerraCart backend."
    ).trim();
    const data =
      req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "token is required in request body.",
      });
    }
    if (!title) {
      return res.status(400).json({
        success: false,
        message: "title is required in request body.",
      });
    }
    if (!body) {
      return res.status(400).json({
        success: false,
        message: "body is required in request body.",
      });
    }

    const result = await sendPushNotification({
      token,
      title,
      body,
      data: {
        ...data,
        notificationType: "test_push",
        source: "api_test_push",
      },
    });

    if (!result.success) {
      const statusCode = result.reason === "TOKEN_INVALID" ? 410 : 400;
      return res.status(statusCode).json({
        success: false,
        message: result.error || "Failed to send test push.",
        result,
      });
    }

    writeNotificationDebugLog("test push sent", {
      requesterId: toObjectIdString(req.user?._id),
      tokenPreview:
        token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token,
      title,
    });

    return res.json({
      success: true,
      message: "Test push sent successfully.",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send test push.",
    });
  }
};

const getFcmTokensDebug = async (req, res) => {
  try {
    const requestedCartId = toObjectIdString(req.query?.cartId);
    const baseFilter = {};
    if (requestedCartId) {
      if (!mongoose.Types.ObjectId.isValid(requestedCartId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid cartId query parameter.",
        });
      }
      baseFilter.cartId = new mongoose.Types.ObjectId(requestedCartId);
    }

    const [totalTokens, activeTokens, perUser, perAnonymousSession] =
      await Promise.all([
        DeviceToken.countDocuments(baseFilter),
        DeviceToken.countDocuments({ ...baseFilter, isActive: true }),
        DeviceToken.aggregate([
          { $match: { ...baseFilter, userId: { $ne: null } } },
          {
            $group: {
              _id: "$userId",
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [{ $eq: ["$isActive", true] }, 1, 0],
                },
              },
            },
          },
          { $sort: { active: -1, total: -1 } },
        ]),
        DeviceToken.aggregate([
          {
            $match: {
              ...baseFilter,
              anonymousSessionId: { $ne: null },
            },
          },
          {
            $group: {
              _id: "$anonymousSessionId",
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [{ $eq: ["$isActive", true] }, 1, 0],
                },
              },
            },
          },
          { $sort: { active: -1, total: -1 } },
        ]),
      ]);

    return res.json({
      success: true,
      cartId: requestedCartId || null,
      summary: {
        totalTokens,
        activeTokens,
        inactiveTokens: Math.max(totalTokens - activeTokens, 0),
        tokensPerUserCount: perUser.length,
        tokensPerAnonymousSessionCount: perAnonymousSession.length,
      },
      tokensPerUser: perUser.map((row) => ({
        userId: row._id ? row._id.toString() : null,
        total: row.total || 0,
        active: row.active || 0,
      })),
      tokensPerAnonymousSession: perAnonymousSession.map((row) => ({
        anonymousSessionId: row._id || null,
        total: row.total || 0,
        active: row.active || 0,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch FCM debug stats.",
    });
  }
};

module.exports = {
  getFirebaseWebConfig,
  saveFcmToken,
  sendNotificationToUser,
  sendCartBroadcastNotification,
  testPushToToken,
  getFcmTokensDebug,
};
