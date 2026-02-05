/**
 * Debug Food Cost Query - Check actual database queries
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const InventoryTransaction = require("../models/costing-v2/inventoryTransactionModel");
const User = require("../models/userModel");

async function debugFoodCostQuery() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Get cart admin
    const cartAdmin = await User.findOne({ role: "admin", isActive: true });
    if (!cartAdmin) {
      console.log("❌ No active cart admin found");
      return;
    }

    const cartId = cartAdmin._id;
    console.log("🛒 CART INFO");
    console.log("=".repeat(70));
    console.log(`Cart Admin: ${cartAdmin.cartName || cartAdmin.name}`);
    console.log(`Cart ID: ${cartId}`);
    console.log(`Cart ID Type: ${typeof cartId} (${cartId.constructor.name})`);
    console.log("=".repeat(70));

    // STEP 1: Check transactions with EXACT query from backend
    console.log("\n📝 STEP 1: CHECK INVENTORY TRANSACTIONS (Backend Query)");
    console.log("-".repeat(70));

    const transactionOutletFilter = { cartId: cartId };
    const transactionDateFilter = {}; // No date filter for full check
    
    console.log("Query filter:", JSON.stringify({
      type: { $in: ["OUT", "WASTE"] },
      ...transactionDateFilter,
      ...transactionOutletFilter,
    }, null, 2));

    const consumptionTransactions = await InventoryTransaction.aggregate([
      {
        $match: {
          type: { $in: ["OUT", "WASTE"] },
          ...transactionDateFilter,
          ...transactionOutletFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
          count: { $sum: 1 },
        },
      },
    ]);

    const totalFoodCost = consumptionTransactions[0]?.totalFoodCost || 0;
    const transactionCount = consumptionTransactions[0]?.count || 0;

    console.log(`Total Consumption Transactions: ${transactionCount}`);
    console.log(`Total Food Cost: ₹${totalFoodCost.toFixed(2)}`);

    if (transactionCount === 0) {
      console.log("\n❌ NO CONSUMPTION TRANSACTIONS FOUND!");
      console.log("\n🔍 Checking if ANY transactions exist for this cart...");
      
      // Check all transaction types
      const allTransactions = await InventoryTransaction.find({ cartId: cartId });
      console.log(`All transactions for cart: ${allTransactions.length}`);
      
      if (allTransactions.length > 0) {
        console.log("\nSample transactions:");
        allTransactions.slice(0, 5).forEach((txn) => {
          console.log(`  - Type: ${txn.type}, Ingredient: ${txn.ingredientId}, Cost: ₹${txn.costAllocated || 0}, Date: ${txn.date}`);
        });
      } else {
        console.log("\n⚠️ Cart has ZERO transactions of any type!");
        console.log("This means:");
        console.log("  1. No purchases recorded");
        console.log("  2. No consumption happened");
        console.log("  3. Check if cartId is correct");
      }
      
      // Check if transactions exist with different cartId format
      console.log("\n🔍 Checking for cartId format issues...");
      const cartIdString = cartId.toString();
      const transWithString = await InventoryTransaction.countDocuments({
        cartId: cartIdString,
        type: { $in: ["OUT", "WASTE"] },
      });
      console.log(`Transactions with cartId as string: ${transWithString}`);
      
      // Check for null cartId (should be for super admin only)
      const transWithNull = await InventoryTransaction.countDocuments({
        cartId: null,
        type: { $in: ["OUT", "WASTE"] },
      });
      console.log(`Transactions with cartId = null: ${transWithNull}`);
    }

    // STEP 2: Check sales with EXACT query from backend
    console.log("\n💰 STEP 2: CHECK SALES (Backend Query)");
    console.log("-".repeat(70));

    const orderFilter = {
      cartId: cartId,
      status: { $in: ["Paid", "Finalized", "Exit"] },
    };
    
    console.log("Order filter:", JSON.stringify(orderFilter, null, 2));

    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $unwind: {
          path: "$kotLines",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$kotLines.totalAmount", 0] } },
          orderCount: { $sum: 1 },
        },
      },
    ]);

    const totalSales = salesData[0]?.totalSales || 0;
    const kotLineCount = salesData[0]?.orderCount || 0;

    console.log(`Total Finalized Orders KOT Lines: ${kotLineCount}`);
    console.log(`Total Sales: ₹${totalSales.toFixed(2)}`);

    // STEP 3: Calculate Food Cost %
    console.log("\n📊 STEP 3: FOOD COST CALCULATION");
    console.log("-".repeat(70));

    const foodCostPercent = totalSales > 0 
      ? Number(((totalFoodCost / totalSales) * 100).toFixed(2))
      : 0;

    console.log(`Total Sales: ₹${totalSales.toFixed(2)}`);
    console.log(`Total Food Cost: ₹${totalFoodCost.toFixed(2)}`);
    console.log(`Food Cost %: ${foodCostPercent}%`);

    // STEP 4: Check for data issues
    console.log("\n🔍 STEP 4: DIAGNOSE ISSUES");
    console.log("-".repeat(70));

    if (totalSales > 0 && totalFoodCost === 0) {
      console.log("❌ ISSUE: Sales exist but food cost is 0");
      console.log("\n🔎 Checking why consumption is not happening...\n");
      
      // Check recent orders
      const recentOrders = await Order.find({
        cartId: cartId,
        status: { $in: ["Paid", "Finalized", "Exit"] },
      })
        .sort({ createdAt: -1 })
        .limit(3)
        .select("_id status createdAt kotLines");

      console.log("Recent finalized orders:");
      for (const order of recentOrders) {
        console.log(`\nOrder ${order._id}:`);
        console.log(`  Status: ${order.status}`);
        console.log(`  Date: ${new Date(order.createdAt).toLocaleString()}`);
        console.log(`  KOT Lines: ${order.kotLines?.length || 0}`);
        
        // Check if this order has transactions
        const orderTrans = await InventoryTransaction.countDocuments({
          refType: "order",
          refId: order._id,
        });
        console.log(`  Transactions: ${orderTrans}`);
        
        if (orderTrans === 0 && order.kotLines && order.kotLines.length > 0) {
          console.log(`  ⚠️ Order has KOT lines but NO transactions!`);
          console.log(`  Items in order:`);
          order.kotLines.forEach((kot, idx) => {
            if (kot.items && kot.items.length > 0) {
              kot.items.forEach((item) => {
                console.log(`    - ${item.name} (qty: ${item.quantity})`);
              });
            }
          });
        }
      }
    } else if (totalSales === 0) {
      console.log("⚠️ No sales data found");
      console.log("Check if orders are being finalized (status: Paid/Finalized)");
    } else if (totalSales > 0 && totalFoodCost > 0) {
      console.log("✅ Food cost calculation is working!");
      console.log(`Food Cost %: ${foodCostPercent}%`);
    }

    // STEP 5: Check cartId consistency
    console.log("\n🔍 STEP 5: CHECK CARTID CONSISTENCY");
    console.log("-".repeat(70));

    // Check orders cartId format
    const orderWithObjectId = await Order.countDocuments({ cartId: cartId });
    const orderWithString = await Order.countDocuments({ cartId: cartId.toString() });
    
    console.log(`Orders with cartId as ObjectId: ${orderWithObjectId}`);
    console.log(`Orders with cartId as String: ${orderWithString}`);

    // Check transactions cartId format
    const transWithObjectId = await InventoryTransaction.countDocuments({ cartId: cartId });
    const transWithStringId = await InventoryTransaction.countDocuments({ cartId: cartId.toString() });
    
    console.log(`Transactions with cartId as ObjectId: ${transWithObjectId}`);
    console.log(`Transactions with cartId as String: ${transWithStringId}`);

    if (orderWithObjectId !== orderWithString || transWithObjectId !== transWithStringId) {
      console.log("\n⚠️ WARNING: cartId format inconsistency detected!");
      console.log("Some records use ObjectId, others use String");
      console.log("This can cause query mismatches");
    }

    console.log("\n" + "=".repeat(70));
    console.log("SUMMARY");
    console.log("=".repeat(70));
    console.log(`Sales: ₹${totalSales.toFixed(2)} (${totalSales > 0 ? '✅' : '❌'})`);
    console.log(`Food Cost: ₹${totalFoodCost.toFixed(2)} (${totalFoodCost > 0 ? '✅' : '❌'})`);
    console.log(`Food Cost %: ${foodCostPercent}% (${foodCostPercent > 0 ? '✅' : '❌'})`);
    console.log(`Transactions: ${transactionCount} (${transactionCount > 0 ? '✅' : '❌'})`);
    console.log("=".repeat(70));

  } catch (error) {
    console.error("❌ Error:", error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

debugFoodCostQuery();


