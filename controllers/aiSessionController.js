const Cart = require("../models/cartModel");
const {
  signCartSessionToken,
  getTtlMs,
} = require("../services/aiSessionService");

/**
 * Issue short-lived HMAC token for billable AI routes (cart-scoped).
 * POST body: { cartId }
 */
exports.issueAiSessionToken = async (req, res) => {
  try {
    const cartId = String(req.body?.cartId || "").trim();
    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" });
    }

    const cart = await Cart.findById(cartId).select("_id isActive").lean();
    if (!cart || cart.isActive === false) {
      return res.status(404).json({ message: "Cart not found" });
    }

    let token;
    try {
      token = signCartSessionToken(cartId);
    } catch (e) {
      return res.status(503).json({
        message:
          e?.message ||
          "AI session signing unavailable (configure AI_SESSION_SECRET or JWT_SECRET)",
      });
    }

    return res.json({
      success: true,
      token,
      expiresInMs: getTtlMs(),
      cartId,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to issue AI session token" });
  }
};
