const mongoose = require("mongoose");
const User = require("../models/userModel");
const PlatformFeature = require("../models/platformFeatureModel");
const FranchiseFeature = require("../models/franchiseFeatureModel");
const FeatureChangeAudit = require("../models/featureChangeAuditModel");
const Ingredient = require("../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../models/costing-v2/inventoryTransactionModel");
const LegacyInventoryItem = require("../models/inventoryModel");
const Order = require("../models/orderModel");
const { resolveCartScope, resolveOperationalScope } = require("../utils/costing-v2/inventoryScope");

const INVENTORY = "inventory";
const SURFACES = ["adminWeb", "staffMobile"];
const disabledSurfaces = () => ({ adminWeb: false, staffMobile: false });
const disabledState = () => ({ enabled: false, surfaces: disabledSurfaces() });

class FeatureError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const assertFeatureKey = (featureKey) => {
  if (featureKey !== INVENTORY) throw new FeatureError("Unsupported feature", 404);
};

const validateFranchiseAdmin = async (franchiseAdminId, session = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(franchiseAdminId || ""))) {
    throw new FeatureError("Invalid franchise admin ID");
  }
  const query = User.findById(franchiseAdminId).select("_id role");
  if (session) query.session(session);
  const user = await query.lean();
  if (!user || user.role !== "franchise_admin") {
    throw new FeatureError("Franchise admin not found", 404);
  }
  return user._id;
};

const resolveFranchiseAdminId = async (user) => {
  const role = user?.role === "cart_admin" ? "admin" : user?.role;
  if (role === "super_admin") return null;
  if (role === "franchise_admin") return validateFranchiseAdmin(user._id);
  if (role === "admin") {
    const scope = await resolveCartScope(user._id, { operation: "feature-read" });
    return scope.franchiseId;
  }
  if (["manager", "cook", "waiter", "captain", "employee"].includes(role)) {
    const scope = await resolveOperationalScope({ ...user, role }, { operation: "feature-read" });
    return scope.franchiseId;
  }
  throw new FeatureError("Feature context unavailable", 403);
};

const getPlatformFeature = async (featureKey) => {
  assertFeatureKey(featureKey);
  return PlatformFeature.findOne({ featureKey }).lean();
};

const getFranchiseFeature = async (franchiseAdminId, featureKey) => {
  assertFeatureKey(featureKey);
  await validateFranchiseAdmin(franchiseAdminId);
  return FranchiseFeature.findOne({ franchiseAdminId, featureKey }).lean();
};

const storedState = (row) => ({
  enabled: row?.enabled === true,
  surfaces: {
    adminWeb: row?.surfaces?.adminWeb === true,
    staffMobile: row?.surfaces?.staffMobile === true,
  },
});

const reconciliationState = (row) => ({
  required: row?.reconciliationRequired === true,
  disabledAt: row?.disabledAt || null,
  enabledAt: row?.enabledAt || null,
  reconciledAt: row?.reconciledAt || null,
  reconciledBy: row?.reconciledBy || null,
});

const hasStaleInventory = async (franchiseAdminId, disabledAt, session) => {
  if (!disabledAt) return false;
  const carts = await User.find({ role: "admin", franchiseId: franchiseAdminId })
    .select("_id").session(session).lean();
  const cartIds = carts.map(cart => cart._id);
  const skipped = await Order.exists({ cartId: { $in: cartIds },
    franchiseId: franchiseAdminId, inventoryProcessingState: "skipped_feature_disabled",
    inventorySkippedAt: { $gte: disabledAt } }).session(session);
  if (!skipped) return false;
  const stock = await Ingredient.exists({ franchiseId: franchiseAdminId,
    $or: [{ cartId: null }, { cartId: { $in: cartIds } }] }).session(session);
  if (stock) return true;
  const legacyStock = await LegacyInventoryItem.exists({ cartId: { $in: cartIds },
    $or: [{ franchiseId: franchiseAdminId }, { franchiseId: null }, { franchiseId: { $exists: false } }] }).session(session);
  if (legacyStock) return true;
  const ingredientIds = await Ingredient.find({ franchiseId: franchiseAdminId })
    .select("_id").session(session).lean();
  return !!(await InventoryTransaction.exists({ cartId: { $in: cartIds },
    ingredientId: { $in: ingredientIds.map(row => row._id) } }).session(session));
};

const getFeatureState = async ({ featureKey, franchiseAdminId }) => {
  assertFeatureKey(featureKey);
  const [platform, franchise] = await Promise.all([
    PlatformFeature.findOne({ featureKey }).lean(),
    getFranchiseFeature(franchiseAdminId, featureKey),
  ]);
  const stored = storedState(franchise);
  const enabled = platform?.enabled === true && stored.enabled && franchise?.reconciliationRequired !== true;
  return {
    stored,
    reconciliation: reconciliationState(franchise),
    effective: {
      enabled,
      surfaces: {
        adminWeb: enabled && stored.surfaces.adminWeb,
        staffMobile: enabled && stored.surfaces.staffMobile,
      },
    },
  };
};

const isFeatureEnabled = async (context) => {
  try {
    return (await getFeatureState(context)).effective.enabled === true;
  } catch (_error) {
    return false;
  }
};

const getFeaturesForUser = async (user) => {
  if (user?.role === "super_admin") {
    const platform = await getPlatformFeature(INVENTORY);
    return { inventory: { enabled: platform?.enabled === true } };
  }
  try {
    const franchiseAdminId = await resolveFranchiseAdminId(user);
    return { inventory: (await getFeatureState({ featureKey: INVENTORY, franchiseAdminId })).effective };
  } catch (_error) {
    return { inventory: disabledState() };
  }
};

const validatePatch = (patch) => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new FeatureError("Feature update body required");
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !["enabled", "surfaces"].includes(key))) {
    throw new FeatureError("Invalid feature update field");
  }
  if (Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") {
    throw new FeatureError("enabled must be boolean");
  }
  if (Object.hasOwn(patch, "surfaces")) {
    const surfaces = patch.surfaces;
    if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces) ||
        !Object.keys(surfaces).length ||
        Object.keys(surfaces).some(key => !SURFACES.includes(key) || typeof surfaces[key] !== "boolean")) {
      throw new FeatureError("Invalid surfaces update");
    }
  }
  return patch;
};

const applyPatch = (current, patch) => ({
  enabled: Object.hasOwn(patch, "enabled") ? patch.enabled : current.enabled,
  surfaces: { ...current.surfaces, ...(patch.surfaces || {}) },
});

const runTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => work(session));
  } finally {
    await session.endSession();
  }
};

const writeAudit = async ({ featureKey, scope, franchiseAdminId = null, previousState, newState, changedBy = null, operationId = null, session }) => {
  await FeatureChangeAudit.create([{
    featureKey, scope, franchiseAdminId, previousState, newState,
    changedBy, actorType: changedBy ? "user" : "system", operationId,
  }], { session });
};

const setPlatformFeature = async ({ featureKey, enabled, changedBy }) => {
  assertFeatureKey(featureKey);
  if (typeof enabled !== "boolean") throw new FeatureError("enabled must be boolean");
  if (!changedBy) throw new FeatureError("Actor required");
  return runTransaction(async (session) => {
    const previous = await PlatformFeature.findOne({ featureKey }).session(session).lean();
    const next = { enabled };
    if (previous?.enabled === true && !enabled) {
      await FranchiseFeature.updateMany({ featureKey, enabled: true,
        reconciliationRequired: { $ne: true } },
        { $set: { disabledAt: new Date() } }, { session });
    }
    if (previous?.enabled === false && enabled) {
      const rows = await FranchiseFeature.find({ featureKey, enabled: true,
        reconciliationRequired: { $ne: true }, disabledAt: { $ne: null } }).session(session).lean();
      for (const row of rows) {
        if (await hasStaleInventory(row.franchiseAdminId, row.disabledAt, session)) {
          await FranchiseFeature.updateOne({ _id: row._id },
            { $set: { reconciliationRequired: true } }, { session });
          console.warn("[INVENTORY_RECONCILIATION_REQUIRED]", JSON.stringify({
            franchiseId: String(row.franchiseAdminId), userId: String(changedBy), timestamp: new Date().toISOString(),
          }));
        }
      }
    }
    await PlatformFeature.updateOne({ featureKey }, {
      $set: { enabled, updatedBy: changedBy },
      $setOnInsert: { createdBy: changedBy },
    }, { upsert: true, session });
    await writeAudit({ featureKey, scope: "platform", previousState: previous ? { enabled: previous.enabled === true } : null,
      newState: next, changedBy, session });
    return next;
  });
};

const writeFranchiseInSession = async ({ franchiseAdminId, featureKey, patch, changedBy, operationId = null, session }) => {
  const previous = await FranchiseFeature.findOne({ franchiseAdminId, featureKey }).session(session).lean();
  const next = applyPatch(storedState(previous), patch);
  const metadata = {};
  if ((previous?.enabled === true || !previous) && next.enabled === false) {
    metadata.disabledAt = new Date();
    metadata.reconciliationRequired = false;
  } else if (previous?.enabled !== true && next.enabled === true) {
    metadata.enabledAt = new Date();
    if (await hasStaleInventory(franchiseAdminId, previous?.disabledAt, session)) {
      metadata.reconciliationRequired = true;
      console.warn("[INVENTORY_RECONCILIATION_REQUIRED]", JSON.stringify({
        franchiseId: String(franchiseAdminId), userId: String(changedBy), timestamp: new Date().toISOString(),
      }));
    } else {
      metadata.reconciliationRequired = false;
    }
  }
  await FranchiseFeature.updateOne({ franchiseAdminId, featureKey }, {
    $set: { enabled: next.enabled, surfaces: next.surfaces, updatedBy: changedBy, ...metadata },
    $setOnInsert: { createdBy: changedBy },
  }, { upsert: true, session });
  await writeAudit({ featureKey, scope: "franchise", franchiseAdminId,
    previousState: previous ? storedState(previous) : null, newState: next,
    changedBy, operationId, session });
  return { franchiseAdminId, stored: next };
};

const setFranchiseFeature = async ({ franchiseAdminId, featureKey, patch, changedBy }) => {
  assertFeatureKey(featureKey);
  validatePatch(patch);
  if (!changedBy) throw new FeatureError("Actor required");
  await validateFranchiseAdmin(franchiseAdminId);
  return runTransaction(async (session) => writeFranchiseInSession({
    franchiseAdminId, featureKey, patch, changedBy, session,
  }));
};

const bulkSetFranchiseFeature = async ({ featureKey, franchiseAdminIds, all, patch, changedBy }) => {
  assertFeatureKey(featureKey);
  validatePatch(patch);
  if (!changedBy) throw new FeatureError("Actor required");
  if (all !== true && (!Array.isArray(franchiseAdminIds) || franchiseAdminIds.length === 0)) {
    throw new FeatureError("Nonempty franchiseAdminIds or all:true required");
  }
  if (all === true && franchiseAdminIds !== undefined) throw new FeatureError("Choose all or franchiseAdminIds");
  const ids = all === true
    ? (await User.find({ role: "franchise_admin" }).select("_id").lean()).map(user => user._id)
    : [...new Set(franchiseAdminIds.map(String))];
  for (const franchiseAdminId of ids) await validateFranchiseAdmin(franchiseAdminId);
  const operationId = new mongoose.Types.ObjectId();
  return runTransaction(async (session) => {
    const results = [];
    for (const franchiseAdminId of ids) {
      results.push(await writeFranchiseInSession({ franchiseAdminId, featureKey,
        patch, changedBy, operationId, session }));
    }
    return { operationId, results };
  });
};

const createNewFranchiseDefaults = async (franchiseAdminId) => {
  await validateFranchiseAdmin(franchiseAdminId);
  return runTransaction(async (session) => {
    const existing = await FranchiseFeature.findOne({ franchiseAdminId, featureKey: INVENTORY }).session(session).lean();
    if (existing) return storedState(existing);
    const next = disabledState();
    await FranchiseFeature.create([{ franchiseAdminId, featureKey: INVENTORY, ...next,
      disabledAt: new Date() }], { session });
    await writeAudit({ featureKey: INVENTORY, scope: "franchise", franchiseAdminId,
      previousState: null, newState: next, session });
    return next;
  });
};

const seedExistingInventoryFeatures = async ({ apply = false } = {}) => {
  const admins = await User.find({ role: "franchise_admin" }).select("_id").lean();
  const [platform, existing] = await Promise.all([
    PlatformFeature.findOne({ featureKey: INVENTORY }).lean(),
    FranchiseFeature.find({ featureKey: INVENTORY,
      franchiseAdminId: { $in: admins.map(admin => admin._id) } }).select("franchiseAdminId").lean(),
  ]);
  const existingIds = new Set(existing.map(row => String(row.franchiseAdminId)));
  const missingIds = admins.map(admin => admin._id).filter(id => !existingIds.has(String(id)));
  const plan = { dryRun: !apply, platformCreate: !platform,
    franchiseAdminIdsToCreate: missingIds.map(String), existingRowsPreserved: existing.length };
  if (!apply || (!plan.platformCreate && !missingIds.length)) return plan;
  await runTransaction(async (session) => {
    if (!platform) {
      await PlatformFeature.updateOne({ featureKey: INVENTORY },
        { $setOnInsert: { enabled: true } }, { upsert: true, session });
      await writeAudit({ featureKey: INVENTORY, scope: "platform", previousState: null,
        newState: { enabled: true }, session });
    }
    for (const franchiseAdminId of missingIds) {
      const next = { enabled: true, surfaces: { adminWeb: true, staffMobile: true } };
      await FranchiseFeature.updateOne({ franchiseAdminId, featureKey: INVENTORY },
        { $setOnInsert: next }, { upsert: true, session });
      await writeAudit({ featureKey: INVENTORY, scope: "franchise", franchiseAdminId,
        previousState: null, newState: next, session });
    }
  });
  return plan;
};

module.exports = {
  INVENTORY, FeatureError, disabledState, validateFranchiseAdmin, resolveFranchiseAdminId,
  getPlatformFeature, getFranchiseFeature, getFeatureState, isFeatureEnabled,
  getFeaturesForUser, setPlatformFeature, setFranchiseFeature, bulkSetFranchiseFeature,
  createNewFranchiseDefaults, seedExistingInventoryFeatures, storedState,
};
