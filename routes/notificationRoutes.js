const express = require("express");
const {
  getFirebaseWebConfig,
  saveFcmToken,
  sendNotificationToUser,
  sendCartBroadcastNotification,
  testPushToToken,
  getFcmTokensDebug,
} = require("../controllers/notificationController");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/firebase-web-config", optionalProtect, getFirebaseWebConfig);

// Required endpoint as requested: POST /api/save-token
router.post("/save-token", optionalProtect, saveFcmToken);

// Required endpoint as requested: POST /api/send-notification
router.post(
  "/send-notification",
  protect,
  authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]),
  sendNotificationToUser
);

// Cart-admin broadcast endpoint for test / maintenance / custom notices.
router.post(
  "/notifications/cart-broadcast",
  protect,
  authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]),
  sendCartBroadcastNotification
);

// Required endpoint as requested: POST /api/test-push
router.post(
  "/test-push",
  protect,
  authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]),
  testPushToToken
);

router.get(
  "/debug/fcm-tokens",
  protect,
  authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]),
  getFcmTokensDebug
);

// Backward-compatible GET support for legacy callers.
router.get(
  "/test-push",
  protect,
  authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]),
  testPushToToken
);

module.exports = router;
