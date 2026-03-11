#!/usr/bin/env node
"use strict";

/**
 * Reset ONLY Finances (costing-v2) data for exactly one cart admin.
 *
 * This script does NOT touch orders, tables, customers, payments, menu, users,
 * or any non-finances panel data.
 *
 * Usage:
 *   node scripts/reset-cart-finances-data.js
 *   node scripts/reset-cart-finances-data.js --cart "Terracart Nashik"
 *   node scripts/reset-cart-finances-data.js --cart-id <USER_ID>
 *   node scripts/reset-cart-finances-data.js --cart "Terracart Nashik" --confirm
 */

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const User = require("../models/userModel");
const Supplier = require("../models/costing-v2/supplierModel");
const IngredientV2 = require("../models/costing-v2/ingredientModel");
const Purchase = require("../models/costing-v2/purchaseModel");
const InventoryTransactionV2 = require("../models/costing-v2/inventoryTransactionModel");
const RecipeV2 = require("../models/costing-v2/recipeModel");
const MenuItemV2 = require("../models/costing-v2/menuItemModel");
const LabourCost = require("../models/costing-v2/labourCostModel");
const Overhead = require("../models/costing-v2/overheadModel");
const CostingExpense = require("../models/costing-v2/expenseModel");
const CostingExpenseCategory = require("../models/costing-v2/expenseCategoryModel");
const Waste = require("../models/costing-v2/wasteModel");
const Preparation = require("../models/costing-v2/preparationModel");

const DEFAULT_CART_NAME = "TerraCart - Nashik";

function printUsage() {
  console.log(`
Usage:
  node scripts/reset-cart-finances-data.js [options]

Options:
  --cart "<name>"      Cart admin name/cartName (default: "${DEFAULT_CART_NAME}")
  --cart-id <id>       Cart admin user ObjectId (preferred if known)
  --confirm            Execute deletion (without this, script is dry-run)
  --help               Show help
`);
}

function parseArgs(argv) {
  const args = {
    cartName: DEFAULT_CART_NAME,
    cartId: null,
    confirm: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--cart" && i + 1 < argv.length) {
      args.cartName = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === "--cart-id" && i + 1 < argv.length) {
      args.cartId = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === "--confirm") {
      args.confirm = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function findTargetCartAdmin({ cartId, cartName }) {
  if (cartId) {
    if (!mongoose.Types.ObjectId.isValid(cartId)) {
      throw new Error(`Invalid --cart-id: ${cartId}`);
    }
    const user = await User.findOne({ _id: cartId, role: "admin" })
      .select("_id name cartName createdAt franchiseId isActive")
      .lean();
    if (!user) {
      throw new Error(`Cart admin not found for id: ${cartId}`);
    }
    return user;
  }

  const exact = new RegExp(`^${escapeRegExp(cartName)}$`, "i");
  const exactMatches = await User.find({
    role: "admin",
    $or: [{ name: exact }, { cartName: exact }],
  })
    .select("_id name cartName createdAt franchiseId isActive")
    .lean();

  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    const rows = exactMatches
      .map((u) => `  - ${u._id} | name="${u.name}" | cartName="${u.cartName || ""}"`)
      .join("\n");
    throw new Error(
      `Multiple cart admins matched "${cartName}". Use --cart-id.\n${rows}`,
    );
  }

  const contains = new RegExp(escapeRegExp(cartName), "i");
  const fuzzyMatches = await User.find({
    role: "admin",
    $or: [{ name: contains }, { cartName: contains }],
  })
    .select("_id name cartName createdAt franchiseId isActive")
    .lean();

  if (fuzzyMatches.length === 1) return fuzzyMatches[0];
  if (fuzzyMatches.length > 1) {
    const rows = fuzzyMatches
      .map((u) => `  - ${u._id} | name="${u.name}" | cartName="${u.cartName || ""}"`)
      .join("\n");
    throw new Error(
      `Multiple cart admins matched "${cartName}" (fuzzy). Use --cart-id.\n${rows}`,
    );
  }

  const normalizedTarget = normalizeName(cartName);
  if (normalizedTarget) {
    const allAdmins = await User.find({ role: "admin" })
      .select("_id name cartName createdAt franchiseId isActive")
      .lean();
    const normalizedMatches = allAdmins.filter((u) => {
      const nameNorm = normalizeName(u.name);
      const cartNameNorm = normalizeName(u.cartName);
      return (
        nameNorm === normalizedTarget ||
        cartNameNorm === normalizedTarget ||
        nameNorm.includes(normalizedTarget) ||
        cartNameNorm.includes(normalizedTarget) ||
        normalizedTarget.includes(nameNorm) ||
        normalizedTarget.includes(cartNameNorm)
      );
    });

    if (normalizedMatches.length === 1) return normalizedMatches[0];
    if (normalizedMatches.length > 1) {
      const rows = normalizedMatches
        .map((u) => `  - ${u._id} | name="${u.name}" | cartName="${u.cartName || ""}"`)
        .join("\n");
      throw new Error(
        `Multiple cart admins matched "${cartName}" (normalized). Use --cart-id.\n${rows}`,
      );
    }
  }

  throw new Error(`No cart admin found for --cart "${cartName}"`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/terra-cart";
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });

  try {
    const cartAdmin = await findTargetCartAdmin(args);
    const cartObjectId = new mongoose.Types.ObjectId(cartAdmin._id);

    const scopes = {
      suppliers: { model: Supplier, query: { cartId: cartObjectId } },
      ingredientsV2: { model: IngredientV2, query: { cartId: cartObjectId } },
      purchases: { model: Purchase, query: { cartId: cartObjectId } },
      inventoryTransactionsV2: {
        model: InventoryTransactionV2,
        query: { cartId: cartObjectId },
      },
      recipesV2: { model: RecipeV2, query: { cartId: cartObjectId } },
      menuItemsV2: { model: MenuItemV2, query: { cartId: cartObjectId } },
      labourCosts: { model: LabourCost, query: { cartId: cartObjectId } },
      overheads: { model: Overhead, query: { cartId: cartObjectId } },
      expenses: { model: CostingExpense, query: { cartId: cartObjectId } },
      expenseCategories: {
        model: CostingExpenseCategory,
        query: { cartId: cartObjectId },
      },
      waste: { model: Waste, query: { cartId: cartObjectId } },
      preparations: { model: Preparation, query: { cartId: cartObjectId } },
    };

    const counts = {};
    for (const [key, scope] of Object.entries(scopes)) {
      counts[key] = await scope.model.countDocuments(scope.query);
    }

    console.log("Target cart admin:");
    console.log(`  id: ${cartAdmin._id}`);
    console.log(`  name: ${cartAdmin.name || ""}`);
    console.log(`  cartName: ${cartAdmin.cartName || ""}`);
    console.log(`  createdAt: ${new Date(cartAdmin.createdAt).toISOString()}`);
    console.log(`  mode: ${args.confirm ? "EXECUTE" : "DRY-RUN"}`);
    console.log("");
    console.log("Finances records targeted (costing-v2 only):");
    Object.entries(counts).forEach(([key, value]) => {
      console.log(`  - ${key}: ${value}`);
    });
    console.log("");

    if (!args.confirm) {
      console.log("Dry-run only. No changes were applied.");
      if (args.cartId) {
        console.log(
          `Run with --confirm to execute:\n  node scripts/reset-cart-finances-data.js --cart-id ${args.cartId} --confirm`,
        );
      } else {
        console.log(
          `Run with --confirm to execute:\n  node scripts/reset-cart-finances-data.js --cart "${args.cartName}" --confirm`,
        );
      }
      return;
    }

    const results = {};
    for (const [key, scope] of Object.entries(scopes)) {
      results[key] = await scope.model.deleteMany(scope.query);
    }

    console.log("Execution completed (costing-v2 only):");
    Object.entries(results).forEach(([key, result]) => {
      console.log(`  - ${key} deleted: ${result.deletedCount || 0}`);
    });
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error("Finances reset failed:", err.message);
  process.exitCode = 1;
});

