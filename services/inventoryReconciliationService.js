const mongoose = require("mongoose");
const User = require("../models/userModel");
const Ingredient = require("../models/costing-v2/ingredientModel");
const Transaction = require("../models/costing-v2/inventoryTransactionModel");
const LegacyItem = require("../models/inventoryModel");
const LegacyTransaction = require("../models/inventoryTransactionModel");
const Count = require("../models/inventoryReconciliationCountModel");
const Feature = require("../models/franchiseFeatureModel");
const { validateFranchiseAdmin, FeatureError } = require("./featureService");
const { resolveCartScope } = require("../utils/costing-v2/inventoryScope");

const id = value => String(value || "");
const log = (event, fields) => console.warn(`[${event}]`, JSON.stringify({
  ...fields, timestamp: new Date().toISOString(),
}));

const actorScope = async (user, franchiseHint, cartHint) => {
  let franchiseId;
  let cartId = null;
  if (user.role === "super_admin") {
    franchiseId = await validateFranchiseAdmin(franchiseHint);
  } else if (user.role === "franchise_admin") {
    franchiseId = await validateFranchiseAdmin(user._id);
    if (franchiseHint && id(franchiseHint) !== id(franchiseId)) throw new FeatureError("Franchise scope mismatch", 403);
  } else if (["admin", "cart_admin"].includes(user.role)) {
    const scope = await resolveCartScope(user._id, { operation: "inventory-reconciliation" });
    franchiseId = scope.franchiseId;
    cartId = scope.cartId;
    if (franchiseHint && id(franchiseHint) !== id(franchiseId)) throw new FeatureError("Franchise scope mismatch", 403);
  } else {
    throw new FeatureError("Reconciliation access denied", 403);
  }
  if (cartHint) {
    const scopedCart = await resolveCartScope(cartHint, { operation: "inventory-reconciliation" });
    if (id(scopedCart.franchiseId) !== id(franchiseId) || (cartId && id(cartId) !== id(scopedCart.cartId))) {
      throw new FeatureError("Cart scope mismatch", 403);
    }
    cartId = scopedCart.cartId;
  }
  return { franchiseId, cartId };
};

const requiredItems = async (franchiseId, cartId = null, session = null) => {
  const cartQuery = User.find({ role: "admin", franchiseId, isActive: { $ne: false } }).select("_id name");
  if (session) cartQuery.session(session);
  const carts = await cartQuery.lean();
  const selected = cartId ? carts.filter(cart => id(cart._id) === id(cartId)) : carts;
  if (cartId && !selected.length) throw new FeatureError("Active cart not found", 404);
  const ingredientQuery = Ingredient.find({ franchiseId, isActive: true,
    $or: [{ cartId: null }, { cartId: { $in: selected.map(cart => cart._id) } }] })
    .select("_id name baseUnit uom qtyOnHand cartId franchiseId");
  if (session) ingredientQuery.session(session);
  const ingredients = await ingredientQuery.lean();
  const legacyQuery = LegacyItem.find({ isActive: true, cartId: { $in: selected.map(cart => cart._id) },
    $or: [{ franchiseId }, { franchiseId: null }, { franchiseId: { $exists: false } }] })
    .select("_id name unit quantity cartId franchiseId");
  if (session) legacyQuery.session(session);
  const legacy = await legacyQuery.lean();
  return [...selected.flatMap(cart => ingredients
    .filter(ingredient => !ingredient.cartId || id(ingredient.cartId) === id(cart._id))
    .map(ingredient => ({ cart, ingredient, kind: "ingredient" }))),
    ...selected.flatMap(cart => legacy.filter(item => id(item.cartId) === id(cart._id))
      .map(item => ({ cart, ingredient: item, kind: "legacy" })))];
};

const recordedQuantity = async (ingredient, cartId, session = null) => {
  if (ingredient.unit && ingredient.quantity != null) return Number(ingredient.quantity) || 0;
  if (ingredient.cartId) return Number(ingredient.qtyOnHand) || 0;
  const query = Transaction.find({ ingredientId: ingredient._id, cartId }).sort({ date: 1, _id: 1 });
  if (session) query.session(session);
  const rows = await query.lean();
  if (!rows.length) return Number(ingredient.qtyOnHand) || 0;
  let stock = 0;
  for (const row of rows) {
    const qty = Number(row.qtyInBaseUnit ?? row.qty) || 0;
    if (row.type === "ADJUSTMENT" && row.physicalQtyAfter != null) stock = Number(row.physicalQtyAfter);
    else if (row.type === "ADJUSTMENT") stock += qty;
    else if (row.type === "IN" || row.type === "RETURN") stock += qty;
    else if (row.type === "OUT" || row.type === "WASTE") stock = Math.max(0, stock - qty);
  }
  return stock;
};

const getReconciliation = async ({ user, franchiseAdminId, cartId }) => {
  const scope = await actorScope(user, franchiseAdminId, cartId);
  const feature = await Feature.findOne({ franchiseAdminId: scope.franchiseId, featureKey: "inventory" }).lean();
  if (!feature?.reconciliationRequired || !feature.disabledAt) throw new FeatureError("Reconciliation is not required", 409);
  const all = await requiredItems(scope.franchiseId);
  const visible = scope.cartId ? all.filter(item => id(item.cart._id) === id(scope.cartId)) : all;
  const counts = await Count.find({ franchiseAdminId: scope.franchiseId, disabledAt: feature.disabledAt }).lean();
  const counted = new Map(counts.map(row => [`${row.cartId}:${row.legacyItemId || row.ingredientId}`, row]));
  const confirmedRequired = all.filter(({ cart, ingredient }) =>
    counted.has(`${cart._id}:${ingredient._id}`)).length;
  const items = await Promise.all(visible.map(async ({ cart, ingredient, kind }) => ({
    ingredientId: kind === "ingredient" ? ingredient._id : undefined,
    legacyItemId: kind === "legacy" ? ingredient._id : undefined,
    kind, name: ingredient.name, cartId: cart._id, cartName: cart.name,
    franchiseId: scope.franchiseId, recordedQty: await recordedQuantity(ingredient, cart._id),
    unit: kind === "legacy" ? ingredient.unit : ingredient.baseUnit,
    physicalQty: counted.get(`${cart._id}:${ingredient._id}`)?.physicalQty ?? null,
    confirmed: counted.has(`${cart._id}:${ingredient._id}`),
  })));
  return { franchiseAdminId: scope.franchiseId, disabledAt: feature.disabledAt,
    totalRequired: all.length, confirmed: confirmedRequired, items };
};

const submitReconciliation = async ({ user, franchiseAdminId, cartId, items, note, finalize }) => {
  const scope = await actorScope(user, franchiseAdminId, cartId);
  if (items != null && (!Array.isArray(items) || !scope.cartId)) throw new FeatureError("Choose a cart and items", 400);
  if (items?.length && (!note || !String(note).trim())) throw new FeatureError("Count note required", 400);
  if (items?.some(item => !mongoose.Types.ObjectId.isValid(id(item.ingredientId || item.legacyItemId)) ||
      Boolean(item.ingredientId) === Boolean(item.legacyItemId) ||
      typeof item.physicalQty !== "number" || !Number.isFinite(item.physicalQty) || item.physicalQty < 0)) {
    throw new FeatureError("Physical counts must be finite numbers >= 0", 400);
  }
  if (new Set((items || []).map(item => id(item.ingredientId || item.legacyItemId))).size !== (items || []).length) {
    throw new FeatureError("Duplicate ingredient count", 400);
  }
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const feature = await Feature.findOne({ franchiseAdminId: scope.franchiseId, featureKey: "inventory" }).session(session);
      if (!feature?.enabled || !feature.reconciliationRequired || !feature.disabledAt) {
        throw new FeatureError("Reconciliation is not pending", 409);
      }
      const required = await requiredItems(scope.franchiseId, null, session);
      const allowed = new Map(required.filter(entry => id(entry.cart._id) === id(scope.cartId))
        .map(entry => [id(entry.ingredient._id), entry]));
      for (const item of items || []) {
        const entry = allowed.get(id(item.ingredientId || item.legacyItemId));
        if (!entry || (entry.kind === "legacy") !== Boolean(item.legacyItemId)) {
          throw new FeatureError("Stock item is outside the selected cart", 403);
        }
        const ingredient = entry.ingredient;
        const key = { franchiseAdminId: scope.franchiseId, disabledAt: feature.disabledAt,
          cartId: scope.cartId, ingredientId: item.ingredientId || null,
          legacyItemId: item.legacyItemId || null };
        if (await Count.exists(key).session(session)) throw new FeatureError("Item already counted this cycle", 409);
        const previousQty = await recordedQuantity(ingredient, scope.cartId, session);
        const physicalQty = item.physicalQty;
        const [count] = await Count.create([{ ...key, previousQty, physicalQty,
          countedBy: user._id, note: String(note).trim().slice(0, 500) }], { session });
        if (entry.kind === "legacy") {
          await LegacyTransaction.create([{ inventoryItemId: ingredient._id, cartId: scope.cartId,
            franchiseId: scope.franchiseId, changeQty: physicalQty - previousQty,
            changeType: "adjustment", referenceId: count._id, cost: 0,
            remarks: `Physical reconciliation: ${String(note).trim().slice(0, 300)}; previous=${previousQty}; physical=${physicalQty}`,
            createdBy: user._id }], { session });
          await LegacyItem.updateOne({ _id: ingredient._id, cartId: scope.cartId },
            { $set: { quantity: physicalQty } }, { session });
        } else {
          await Transaction.create([{ ingredientId: ingredient._id, cartId: scope.cartId,
            type: "ADJUSTMENT", qty: physicalQty - previousQty,
            qtyInBaseUnit: physicalQty - previousQty, physicalQtyAfter: physicalQty,
            previousQty, reconciliationId: count._id, uom: ingredient.baseUnit,
            refType: "adjustment", refId: count._id, recordedBy: user._id,
            notes: `Physical reconciliation: ${String(note).trim().slice(0, 300)}` }], { session });
        }
        if (entry.kind === "ingredient" && ingredient.cartId) {
          await Ingredient.updateOne({ _id: ingredient._id, cartId: scope.cartId,
            franchiseId: scope.franchiseId }, { $set: { qtyOnHand: physicalQty } }, { session });
        }
      }
      log("INVENTORY_RECONCILIATION_STARTED", { franchiseId: id(scope.franchiseId),
        cartId: id(scope.cartId), userId: id(user._id), itemCount: (items || []).length });
      const countedRows = await Count.find({ franchiseAdminId: scope.franchiseId,
        disabledAt: feature.disabledAt }).select("cartId ingredientId legacyItemId").session(session).lean();
      const countedKeys = new Set(countedRows.map(row => `${row.cartId}:${row.legacyItemId || row.ingredientId}`));
      const count = required.filter(({ cart, ingredient }) =>
        countedKeys.has(`${cart._id}:${ingredient._id}`)).length;
      if (finalize) {
        if (count !== required.length) throw new FeatureError("All active stock counts must be confirmed", 409);
        feature.reconciliationRequired = false;
        feature.reconciledAt = new Date();
        feature.reconciledBy = user._id;
        await feature.save({ session });
        log("INVENTORY_RECONCILIATION_COMPLETED", { franchiseId: id(scope.franchiseId),
          cartId: id(scope.cartId), userId: id(user._id), itemCount: count });
      }
      return { franchiseAdminId: scope.franchiseId, totalRequired: required.length,
        confirmed: count, completed: Boolean(finalize) };
    });
  } finally {
    await session.endSession();
  }
};

module.exports = { actorScope, getReconciliation, submitReconciliation, recordedQuantity };
