/**
 * Fix inventory items with wrong or null cartId
 * Assigns items to the correct cart so mobile app (manager, etc.) can see them
 *
 * Usage: node scripts/fix-inventory-cartid.js <targetCartId>
 * Example: node scripts/fix-inventory-cartid.js 6929a028012403b42b92c83f
 *
 * Or with no args: shows diagnostic (distinct cartIds, items with null cartId)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const InventoryItem = require("../models/inventoryModel");

async function run() {
  await connectDB();

  const targetCartId = process.argv[2];

  if (!targetCartId) {
    // Diagnostic mode
    const total = await InventoryItem.countDocuments({});
    const withNullCartId = await InventoryItem.countDocuments({ $or: [{ cartId: null }, { cartId: { $exists: false } }] });
    const distinctCartIds = await InventoryItem.distinct("cartId");
    const itemsByCart = await InventoryItem.aggregate([
      { $group: { _id: "$cartId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    console.log("\n=== INVENTORY CARTID DIAGNOSTIC ===\n");
    console.log("Total items:", total);
    console.log("Items with null/missing cartId:", withNullCartId);
    console.log("Distinct cartIds in use:", distinctCartIds.map((id) => id?.toString()).filter(Boolean));
    console.log("\nItems per cartId:");
    itemsByCart.forEach((row) => {
      console.log("  -", row._id?.toString() || "null", ":", row.count, "items");
    });
    console.log("\nTo fix: node scripts/fix-inventory-cartid.js <targetCartId>");
    console.log("Example: node scripts/fix-inventory-cartid.js 6929a028012403b42b92c83f\n");
    process.exit(0);
    return;
  }

  const targetObjId = mongoose.Types.ObjectId.isValid(targetCartId)
    ? new mongoose.Types.ObjectId(targetCartId)
    : null;

  if (!targetObjId) {
    console.error("Invalid cartId:", targetCartId);
    process.exit(1);
  }

  // By default: only update items with null/missing cartId (orphaned items)
  // Use --all to update ALL items to target cartId (use with caution)
  const updateAll = process.argv.includes("--all");
  const filter = updateAll
    ? {} // Update all items
    : { $or: [{ cartId: null }, { cartId: { $exists: false } }] }; // Only orphaned

  const result = await InventoryItem.updateMany(filter, { $set: { cartId: targetObjId } });

  console.log("\n=== FIX INVENTORY CARTID ===\n");
  console.log("Target cartId:", targetCartId);
  console.log("Mode:", updateAll ? "ALL items" : "orphaned only (null cartId)");
  console.log("Matched:", result.matchedCount);
  console.log("Modified:", result.modifiedCount);
  if (result.matchedCount > 0 && !updateAll) {
    const stillWrong = await InventoryItem.countDocuments({ cartId: { $exists: true, $ne: targetObjId } });
    if (stillWrong > 0) {
      console.log("\nNote:", stillWrong, "items still have different cartId. Run with --all to fix:");
      console.log("  node scripts/fix-inventory-cartid.js", targetCartId, "--all");
    }
  }
  console.log("\nDone. Restart the app and check inventory.\n");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
