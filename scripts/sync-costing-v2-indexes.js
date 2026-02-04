/**
 * Sync Costing-v2 MongoDB indexes (run once after deployment)
 *
 * Why:
 * - In production, mongoose autoIndex is often disabled
 * - This repo relies on indexes for duplicate prevention & performance
 *
 * Usage:
 *   cd backend
 *   node scripts/sync-costing-v2-indexes.js
 */

const mongoose = require("mongoose");

async function main() {
  const mongoUri =
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  console.log("✅ Connected. Loading models...");

  // Require models so mongoose registers schemas + indexes
  const Recipe = require("../models/costing-v2/recipeModel");
  const Ingredient = require("../models/costing-v2/ingredientModel");
  const MenuItem = require("../models/costing-v2/menuItemModel");
  const Purchase = require("../models/costing-v2/purchaseModel");
  const InventoryTxn = require("../models/costing-v2/inventoryTransactionModel");
  const Supplier = require("../models/costing-v2/supplierModel");
  const Expense = require("../models/costing-v2/expenseModel");

  const models = [
    ["RecipeV2", Recipe],
    ["IngredientV2", Ingredient],
    ["MenuItemV2", MenuItem],
    ["PurchaseV2", Purchase],
    ["InventoryTransactionV2", InventoryTxn],
    ["SupplierV2", Supplier],
    ["ExpenseV2", Expense],
  ];

  for (const [name, model] of models) {
    try {
      console.log(`Syncing indexes for ${name}...`);
      await model.syncIndexes();
      console.log(`✅ ${name} indexes synced`);
    } catch (err) {
      console.error(`❌ Failed syncing indexes for ${name}:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log("✅ Done");
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});


