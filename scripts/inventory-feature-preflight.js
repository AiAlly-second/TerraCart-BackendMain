// Read-only production gate. No index creation, upsert, migration, or feature write.
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const User = require("../models/userModel");
const PlatformFeature = require("../models/platformFeatureModel");
const FranchiseFeature = require("../models/franchiseFeatureModel");
const Ingredient = require("../models/costing-v2/ingredientModel");
const Transaction = require("../models/costing-v2/inventoryTransactionModel");
const Order = require("../models/orderModel");
const Count = require("../models/inventoryReconciliationCountModel");

const id = value => String(value || "");
async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const [platform, admins, rows, carts] = await Promise.all([
    PlatformFeature.findOne({ featureKey: "inventory" }).lean(),
    User.find({ role: "franchise_admin" }).select("_id").lean(),
    FranchiseFeature.find({ featureKey: "inventory" }).lean(),
    User.find({ role: "admin" }).select("_id franchiseId").lean(),
  ]);
  const currentIds = new Set(admins.map(admin => id(admin._id)));
  const rowIds = new Set(rows.map(row => id(row.franchiseAdminId)));
  const missing = admins.filter(admin => !rowIds.has(id(admin._id))).map(admin => id(admin._id));
  const orphan = rows.filter(row => !currentIds.has(id(row.franchiseAdminId)))
    .map(row => id(row.franchiseAdminId));
  const badCarts = carts.filter(cart => !currentIds.has(id(cart.franchiseId)))
    .map(cart => id(cart._id));
  const ingredients = await Ingredient.find({ franchiseId: { $ne: null } })
    .select("_id cartId franchiseId").lean();
  const cartFranchise = new Map(carts.map(cart => [id(cart._id), id(cart.franchiseId)]));
  const badIngredients = ingredients.filter(item => item.cartId &&
    cartFranchise.has(id(item.cartId)) && cartFranchise.get(id(item.cartId)) !== id(item.franchiseId))
    .map(item => id(item._id));
  const currentCartIds = carts.filter(cart => currentIds.has(id(cart.franchiseId))).map(cart => cart._id);
  const currentTransactions = await Transaction.find({ cartId: { $in: currentCartIds } })
    .select("ingredientId cartId").lean();
  const ingredientFranchise = new Map(ingredients.map(item => [id(item._id), id(item.franchiseId)]));
  const crossTenantTransactionCount = currentTransactions.filter(txn =>
    ingredientFranchise.has(id(txn.ingredientId)) &&
    ingredientFranchise.get(id(txn.ingredientId)) !== cartFranchise.get(id(txn.cartId))).length;
  const currentOrders = await Order.find({ cartId: { $in: currentCartIds } })
    .select("_id cartId franchiseId").lean();
  const mismatchedCurrentOrderCount = currentOrders.filter(order =>
    cartFranchise.get(id(order.cartId)) !== id(order.franchiseId)).length;
  const skipped = await Order.aggregate([
    { $match: { cartId: { $in: currentCartIds },
      inventoryProcessingState: "skipped_feature_disabled" } },
    { $group: { _id: "$franchiseId", count: { $sum: 1 } } },
  ]);
  const skippedByFranchise = Object.fromEntries(skipped.filter(row => currentIds.has(id(row._id)))
    .map(row => [id(row._id), row.count]));
  const on = rows.filter(row => row.enabled === true).length;
  const webOn = rows.filter(row => row.surfaces?.adminWeb === true).length;
  const mobileOn = rows.filter(row => row.surfaces?.staffMobile === true).length;
  const pending = rows.filter(row => row.reconciliationRequired === true)
    .map(row => id(row.franchiseAdminId));
  let reconciliationUniqueIndex = false;
  try {
    const indexes = await Count.collection.listIndexes().toArray();
    reconciliationUniqueIndex = indexes.some(index => index.unique === true &&
      Object.keys(index.key || {}).join(",") ===
      "franchiseAdminId,disabledAt,cartId,ingredientId,legacyItemId");
  } catch (error) {
    if (error.codeName !== "NamespaceNotFound") throw error;
  }
  const reasons = [];
  if (!platform) reasons.push("Platform Inventory feature row missing");
  else if (!platform.enabled) reasons.push("Global Inventory is OFF; existing behavior is not preserved");
  if (missing.length) reasons.push(`${missing.length} current franchises lack Inventory feature rows`);
  if (orphan.length) reasons.push(`${orphan.length} orphan Inventory feature rows`);
  if (badCarts.length) reasons.push(`${badCarts.length} current cart-admin mappings are invalid`);
  if (badIngredients.length) reasons.push(`${badIngredients.length} current cart ingredients have a franchise mismatch`);
  if (mismatchedCurrentOrderCount) reasons.push(`${mismatchedCurrentOrderCount} current-cart orders have a franchise mismatch`);
  if (pending.length) reasons.push(`${pending.length} franchises require reconciliation`);
  if (!reconciliationUniqueIndex) reasons.push("Reconciliation count unique index missing");
  // Historical transactions are evidence, not a new write hazard by themselves.
  const report = {
    verdict: reasons.length ? "NOT READY" : "READY", reasons,
    platformRowExists: !!platform, globalInventoryEnabled: platform?.enabled === true,
    currentFranchiseAdmins: admins.length, franchiseFeatureRowsForCurrentAdmins: rows.length - orphan.length,
    missingFranchiseFeatureRows: missing, orphanFeatureRows: orphan,
    stored: { on, off: rows.length - on },
    adminWeb: { on: webOn, off: rows.length - webOn },
    staffMobile: { on: mobileOn, off: rows.length - mobileOn },
    invalidFranchiseAdminReferences: orphan,
    reconciliationRequiredFranchises: pending,
    reconciliationUniqueIndex,
    skippedFeatureDisabledOrdersByCurrentFranchise: skippedByFranchise,
    tenantAnomalies: { invalidCurrentCartMappings: badCarts,
      mismatchedCurrentCartIngredients: badIngredients,
      mismatchedCurrentCartOrderCount: mismatchedCurrentOrderCount,
      historicalCrossTenantTransactionCount: crossTenantTransactionCount },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reasons.length) process.exitCode = 1;
}
main().catch(error => {
  process.stderr.write(`Inventory preflight failed: ${error.message}\n`);
  process.exitCode = 2;
}).finally(async () => { await mongoose.disconnect(); });
