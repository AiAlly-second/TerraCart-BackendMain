/**
 * Guards DIRECT Inventory API calls (the caller explicitly asked to use
 * Inventory, e.g. POST /api/costing-v2/inventory/consume). Returns a
 * consistent 403 FEATURE_DISABLED when Inventory is off - never used around
 * a normal Order/KOT/Payment operation, which must never fail merely because
 * Inventory is disabled (see services/costing-v2/orderInventoryCoordinator.js
 * for that side).
 */
const featureService = require("../services/featureService");
const { resolveOperationalScope } = require("../utils/costing-v2/inventoryScope");

const FEATURE_DISABLED_BODY = {
  success: false,
  message: "Inventory is not enabled",
  code: "FEATURE_DISABLED",
};

const extractCartHint = (req) => req.body?.cartId || req.query?.cartId || null;

/**
 * requireInventoryEnabled(): resolves the authenticated caller's own
 * franchise scope (never a caller-supplied franchiseId) and checks the
 * central feature service. Fails closed on any resolution error - a
 * misconfigured or unresolvable scope never grants Inventory access.
 */
const requireInventoryEnabled = (options = {}) => async (req, res, next) => {
  try {
    const scope = await resolveOperationalScope(req.user, {
      cartId: options.cartHint ? options.cartHint(req) : extractCartHint(req),
      requireCart: false,
      operation: options.operation || "inventory-feature-guard",
    });
    const enabled = await featureService.isFeatureEnabled({
      featureKey: featureService.INVENTORY,
      franchiseAdminId: scope.franchiseId,
    });
    if (!enabled) {
      return res.status(403).json(FEATURE_DISABLED_BODY);
    }
    req.inventoryFeatureScope = scope;
    return next();
  } catch (error) {
    console.warn("[INVENTORY_FEATURE_GUARD] resolution failed", JSON.stringify({
      message: error.message, path: req.originalUrl, userId: req.user?._id,
    }));
    return res.status(403).json(FEATURE_DISABLED_BODY);
  }
};

module.exports = { requireInventoryEnabled, FEATURE_DISABLED_BODY };
