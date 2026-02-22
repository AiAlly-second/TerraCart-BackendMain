#!/usr/bin/env node
"use strict";

/**
 * Reset operational data for exactly one cart admin.
 *
 * This script only removes transactional/operational records and keeps
 * configuration/setup data (menu, users, printer config, settings) untouched.
 *
 * Default target: TerraCart Nashik
 *
 * Usage:
 *   node scripts/reset-cart-operational-data.js
 *   node scripts/reset-cart-operational-data.js --cart "TerraCart Nashik"
 *   node scripts/reset-cart-operational-data.js --cart-id <USER_ID>
 *   node scripts/reset-cart-operational-data.js --cart "TerraCart Nashik" --confirm
 *   node scripts/reset-cart-operational-data.js --cart-id <USER_ID> --all-time --confirm
 *   node scripts/reset-cart-operational-data.js --cart "TerraCart Nashik" --from 2026-01-01 --confirm
 *
 * Notes:
 * - Dry-run by default. Nothing is deleted unless --confirm is passed.
 * - By default, the reset window starts from cart registration date (user createdAt).
 */

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const User = require("../models/userModel");
const Order = require("../models/orderModel");
const { Payment } = require("../models/paymentModel");
const Customer = require("../models/customerModel");
const Feedback = require("../models/feedbackModel");
const CustomerRequest = require("../models/customerRequestModel");
const PrintQueue = require("../models/printQueueModel");
const InventoryTransaction = require("../models/inventoryTransactionModel");
const InventoryTransactionV2 = require("../models/costing-v2/inventoryTransactionModel");
const RevenueHistory = require("../models/revenueHistoryModel");
const Waitlist = require("../models/waitlistModel");
const { Table } = require("../models/tableModel");

const DEFAULT_CART_NAME = "TerraCart - Nashik";

function printUsage() {
  console.log(`
Usage:
  node scripts/reset-cart-operational-data.js [options]

Options:
  --cart "<name>"      Cart admin name/cartName (default: "${DEFAULT_CART_NAME}")
  --cart-id <id>       Cart admin user ObjectId (preferred if known)
  --from YYYY-MM-DD    Start date override (inclusive)
  --all-time           Ignore date filtering (reset all operational records for cart)
  --confirm            Execute deletion/update (without this, script is dry-run)
  --help               Show help
`);
}

function parseArgs(argv) {
  const args = {
    cartName: DEFAULT_CART_NAME,
    cartId: null,
    from: null,
    allTime: false,
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
    if (token === "--from" && i + 1 < argv.length) {
      args.from = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (token === "--all-time") {
      args.allTime = true;
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

function parseDate(input) {
  if (!input) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function buildFranchiseRevenueFromCartRevenue(cartRevenue) {
  const map = new Map();

  for (const entry of cartRevenue || []) {
    if (!entry || !entry.franchiseId) continue;
    const key = String(entry.franchiseId);
    if (!map.has(key)) {
      map.set(key, {
        franchiseId: entry.franchiseId,
        franchiseName: entry.franchiseName || "Unknown",
        revenue: 0,
        cartIds: new Set(),
      });
    }
    const bucket = map.get(key);
    bucket.revenue += toNumber(entry.revenue);
    if (entry.cartId) bucket.cartIds.add(String(entry.cartId));
  }

  return Array.from(map.values()).map((item) => ({
    franchiseId: item.franchiseId,
    franchiseName: item.franchiseName,
    revenue: item.revenue,
    cafeCount: item.cartIds.size,
    cartCount: item.cartIds.size,
  }));
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

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

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

  if (fuzzyMatches.length === 1) {
    return fuzzyMatches[0];
  }

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

    if (normalizedMatches.length === 1) {
      return normalizedMatches[0];
    }

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

    let fromDate = null;
    if (!args.allTime) {
      if (args.from) {
        fromDate = parseDate(args.from);
        if (!fromDate) {
          throw new Error(`Invalid --from date: ${args.from}`);
        }
      } else {
        fromDate = new Date(cartAdmin.createdAt);
      }
    }

    if (fromDate && Number.isNaN(fromDate.getTime())) {
      throw new Error("Could not determine a valid start date");
    }

    const cartObjectId = new mongoose.Types.ObjectId(cartAdmin._id);
    const dateFilter = fromDate ? { createdAt: { $gte: fromDate } } : {};

    const ordersQuery = { cartId: cartObjectId, ...dateFilter };
    const orderDocs = await Order.find(ordersQuery).select("_id").lean();
    const orderIds = orderDocs.map((o) => String(o._id));

    const paymentsQuery =
      orderIds.length > 0 ? { orderId: { $in: orderIds } } : { _id: null };

    const tableDocs = await Table.find({ cartId: cartObjectId }).select("_id").lean();
    const tableIds = tableDocs.map((t) => t._id);
    const waitlistQuery =
      tableIds.length > 0
        ? { table: { $in: tableIds }, ...dateFilter }
        : { _id: null };

    const historyQuery = { "cartRevenue.cartId": cartObjectId };
    if (fromDate) {
      historyQuery.$or = [
        { periodType: "daily", date: { $gte: startOfDay(fromDate) } },
        { periodType: "monthly", date: { $gte: startOfMonth(fromDate) } },
      ];
    }

    const queryPlan = {
      orders: ordersQuery,
      payments: paymentsQuery,
      customers: { cartId: cartObjectId, ...dateFilter },
      feedback: { cartId: cartObjectId, ...dateFilter },
      customerRequests: { cartId: cartObjectId, ...dateFilter },
      printQueue: { cartId: cartObjectId, ...dateFilter },
      waitlist: waitlistQuery,
      inventoryTransactions: {
        cartId: cartObjectId,
        changeType: "consumption",
        ...dateFilter,
      },
      inventoryTransactionsV2: {
        cartId: cartObjectId,
        refType: "order",
        ...dateFilter,
      },
      revenueHistory: historyQuery,
    };

    const counts = {
      orders: await Order.countDocuments(queryPlan.orders),
      payments: await Payment.countDocuments(queryPlan.payments),
      customers: await Customer.countDocuments(queryPlan.customers),
      feedback: await Feedback.countDocuments(queryPlan.feedback),
      customerRequests: await CustomerRequest.countDocuments(queryPlan.customerRequests),
      printQueue: await PrintQueue.countDocuments(queryPlan.printQueue),
      waitlist: await Waitlist.countDocuments(queryPlan.waitlist),
      inventoryTransactions: await InventoryTransaction.countDocuments(
        queryPlan.inventoryTransactions,
      ),
      inventoryTransactionsV2: await InventoryTransactionV2.countDocuments(
        queryPlan.inventoryTransactionsV2,
      ),
      revenueHistoryDocsWithCartEntry: await RevenueHistory.countDocuments(
        queryPlan.revenueHistory,
      ),
    };

    console.log("Target cart admin:");
    console.log(`  id: ${cartAdmin._id}`);
    console.log(`  name: ${cartAdmin.name || ""}`);
    console.log(`  cartName: ${cartAdmin.cartName || ""}`);
    console.log(`  createdAt: ${new Date(cartAdmin.createdAt).toISOString()}`);
    console.log(`  mode: ${args.confirm ? "EXECUTE" : "DRY-RUN"}`);
    console.log(
      `  date window: ${fromDate ? `createdAt >= ${fromDate.toISOString()}` : "all-time"}`,
    );
    console.log("");
    console.log("Records targeted:");
    Object.entries(counts).forEach(([key, value]) => {
      console.log(`  - ${key}: ${value}`);
    });
    console.log("");

    if (!args.confirm) {
      console.log("Dry-run only. No changes were applied.");
      console.log(
        "Run again with --confirm to execute, for example:",
      );
      if (args.cartId) {
        console.log(
          `  node scripts/reset-cart-operational-data.js --cart-id ${args.cartId} --confirm`,
        );
      } else {
        console.log(
          `  node scripts/reset-cart-operational-data.js --cart "${args.cartName}" --confirm`,
        );
      }
      return;
    }

    const deletionResults = {};
    deletionResults.payments = await Payment.deleteMany(queryPlan.payments);
    deletionResults.printQueue = await PrintQueue.deleteMany(queryPlan.printQueue);
    deletionResults.customerRequests = await CustomerRequest.deleteMany(
      queryPlan.customerRequests,
    );
    deletionResults.feedback = await Feedback.deleteMany(queryPlan.feedback);
    deletionResults.customers = await Customer.deleteMany(queryPlan.customers);
    deletionResults.waitlist = await Waitlist.deleteMany(queryPlan.waitlist);
    deletionResults.inventoryTransactions = await InventoryTransaction.deleteMany(
      queryPlan.inventoryTransactions,
    );
    deletionResults.inventoryTransactionsV2 = await InventoryTransactionV2.deleteMany(
      queryPlan.inventoryTransactionsV2,
    );
    deletionResults.orders = await Order.deleteMany(queryPlan.orders);

    // Clean stale table references to deleted orders.
    let tableResetResult = { matchedCount: 0, modifiedCount: 0 };
    if (orderIds.length > 0) {
      tableResetResult = await Table.updateMany(
        { cartId: cartObjectId, currentOrder: { $in: orderIds } },
        {
          $set: {
            currentOrder: null,
            status: "AVAILABLE",
            sessionToken: null,
            lastAssignedAt: null,
          },
        },
      );
    }

    // Remove cart contribution from revenue history snapshots and recalculate totals.
    const historyDocs = await RevenueHistory.find(queryPlan.revenueHistory);
    let historyDocsUpdated = 0;
    for (const doc of historyDocs) {
      const beforeLen = Array.isArray(doc.cartRevenue) ? doc.cartRevenue.length : 0;
      if (beforeLen === 0) continue;

      doc.cartRevenue = doc.cartRevenue.filter(
        (entry) => String(entry.cartId) !== String(cartObjectId),
      );
      const afterLen = doc.cartRevenue.length;
      if (afterLen === beforeLen) continue;

      doc.totalRevenue = doc.cartRevenue.reduce(
        (sum, entry) => sum + toNumber(entry.revenue),
        0,
      );
      doc.totalOrders = doc.cartRevenue.reduce(
        (sum, entry) => sum + toNumber(entry.orderCount),
        0,
      );
      doc.totalPayments = doc.totalOrders;
      doc.franchiseRevenue = buildFranchiseRevenueFromCartRevenue(doc.cartRevenue);
      doc.calculatedAt = new Date();

      await doc.save();
      historyDocsUpdated += 1;
    }

    console.log("Execution completed:");
    console.log(`  - orders deleted: ${deletionResults.orders.deletedCount || 0}`);
    console.log(`  - payments deleted: ${deletionResults.payments.deletedCount || 0}`);
    console.log(
      `  - printQueue deleted: ${deletionResults.printQueue.deletedCount || 0}`,
    );
    console.log(
      `  - customerRequests deleted: ${deletionResults.customerRequests.deletedCount || 0}`,
    );
    console.log(`  - feedback deleted: ${deletionResults.feedback.deletedCount || 0}`);
    console.log(`  - customers deleted: ${deletionResults.customers.deletedCount || 0}`);
    console.log(`  - waitlist deleted: ${deletionResults.waitlist.deletedCount || 0}`);
    console.log(
      `  - inventoryTransactions deleted: ${deletionResults.inventoryTransactions.deletedCount || 0}`,
    );
    console.log(
      `  - inventoryTransactionsV2 deleted: ${deletionResults.inventoryTransactionsV2.deletedCount || 0}`,
    );
    console.log(
      `  - tables reset (stale currentOrder): ${tableResetResult.modifiedCount || 0}`,
    );
    console.log(`  - revenueHistory docs updated: ${historyDocsUpdated}`);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((err) => {
  console.error("Reset failed:", err.message);
  process.exitCode = 1;
});
