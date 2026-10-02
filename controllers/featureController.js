const featureService = require("../services/featureService");

const sendError = (res, error) => res.status(error.statusCode || 500).json({
  success: false,
  message: error.statusCode ? error.message : "Feature operation failed",
});

const emitFranchiseUpdate = (req, franchiseAdminId, effective) => {
  try {
    const io = req.app.get("io");
    const emitToFranchise = req.app.get("emitToFranchise");
    if (io && emitToFranchise) {
      emitToFranchise(io, String(franchiseAdminId), "feature:updated", {
        featureKey: featureService.INVENTORY,
        enabled: effective.enabled,
        surfaces: effective.surfaces,
      });
    }
  } catch (error) {
    console.warn("[FEATURE_SOCKET] Franchise notification failed", { franchiseAdminId: String(franchiseAdminId), message: error.message });
  }
};

const emitPlatformUpdate = (req, enabled) => {
  try {
    const io = req.app.get("io");
    if (io) {
      io.to(["role:super_admin", "role:franchise_admin", "role:admin",
        "role:manager", "role:cook", "role:waiter", "role:captain", "role:employee"])
        .emit("feature:updated", { featureKey: featureService.INVENTORY,
          platformEnabled: enabled, refetch: true });
    }
  } catch (error) {
    console.warn("[FEATURE_SOCKET] Platform notification failed", { message: error.message });
  }
};

exports.getMyFeatures = async (req, res) => {
  try {
    res.json({ success: true, features: await featureService.getFeaturesForUser(req.user) });
  } catch (error) { sendError(res, error); }
};

exports.getPlatformFeatures = async (_req, res) => {
  try {
    const platform = await featureService.getPlatformFeature(featureService.INVENTORY);
    res.json({ success: true, features: { inventory: { enabled: platform?.enabled === true } } });
  } catch (error) { sendError(res, error); }
};

exports.patchPlatformInventory = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== "boolean") {
      return res.status(400).json({ success: false, message: "enabled boolean required" });
    }
    const state = await featureService.setPlatformFeature({ featureKey: featureService.INVENTORY,
      enabled: req.body.enabled, changedBy: req.user._id });
    emitPlatformUpdate(req, state.enabled);
    res.json({ success: true, features: { inventory: state } });
  } catch (error) { sendError(res, error); }
};

exports.getFranchiseFeatures = async (req, res) => {
  try {
    const state = await featureService.getFeatureState({ featureKey: featureService.INVENTORY,
      franchiseAdminId: req.params.franchiseAdminId });
    res.json({ success: true, features: { inventory: state } });
  } catch (error) { sendError(res, error); }
};

exports.patchFranchiseInventory = async (req, res) => {
  try {
    await featureService.setFranchiseFeature({ featureKey: featureService.INVENTORY,
      franchiseAdminId: req.params.franchiseAdminId, patch: req.body, changedBy: req.user._id });
    const state = await featureService.getFeatureState({ featureKey: featureService.INVENTORY,
      franchiseAdminId: req.params.franchiseAdminId });
    emitFranchiseUpdate(req, req.params.franchiseAdminId, state.effective);
    res.json({ success: true, features: { inventory: state } });
  } catch (error) { sendError(res, error); }
};

exports.bulkPatchFranchiseInventory = async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ["all", "franchiseAdminIds", "enabled", "surfaces"];
    if (Object.keys(body).some(key => !allowed.includes(key))) {
      return res.status(400).json({ success: false, message: "Invalid bulk update field" });
    }
    const patch = {};
    if (Object.hasOwn(body, "enabled")) patch.enabled = body.enabled;
    if (Object.hasOwn(body, "surfaces")) patch.surfaces = body.surfaces;
    const result = await featureService.bulkSetFranchiseFeature({ featureKey: featureService.INVENTORY,
      franchiseAdminIds: body.franchiseAdminIds, all: body.all, patch, changedBy: req.user._id });
    for (const row of result.results) {
      const state = await featureService.getFeatureState({ featureKey: featureService.INVENTORY,
        franchiseAdminId: row.franchiseAdminId });
      emitFranchiseUpdate(req, row.franchiseAdminId, state.effective);
    }
    res.json({ success: true, updated: result.results.length,
      franchiseAdminIds: result.results.map(row => String(row.franchiseAdminId)) });
  } catch (error) { sendError(res, error); }
};
