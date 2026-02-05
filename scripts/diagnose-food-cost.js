/**
 * Food Cost Diagnosis Script
 * Checks if inventory transactions are being created properly for food cost calculation
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const InventoryTransaction = require("../models/costing-v2/inventoryTransactionModel");
const User = require("../models/userModel");

async function diagnoseFoodCost() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Get a sample cart admin
    const cartAdmin = await User.findOne({ role: "admin", isActive: true });
    if (!cartAdmin) {
      console.log("❌ No active cart admin found");
      return;
    }

    console.log("\n📊 FOOD COST DIAGNOSIS");
    console.log("=".repeat(60));
    console.log(`Cart Admin: ${cartAdmin.cartName || cartAdmin.name}`);
    console.log(`Cart ID: ${cartAdmin._id}`);
    console.log("=".repeat(60));

    // Check orders for this cart
    const totalOrders = await Order.countDocuments({ cartId: cartAdmin._id });
    const finalizedOrders = await Order.countDocuments({
      cartId: cartAdmin._id,
      status: { $in: ["Paid", "Finalized", "Exit"] },
    });

    console.log(`\n📦 ORDERS:`);
    console.log(`  Total Orders: ${totalOrders}`);
    console.log(`  Finalized Orders: ${finalizedOrders}`);

    // Check recent orders
    const recentOrders = await Order.find({ cartId: cartAdmin._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("_id status totalAmount createdAt kotLines");

    console.log(`\n  Recent 5 Orders:`);
    for (const order of recentOrders) {
      const kotCount = order.kotLines?.length || 0;
      const itemCount = order.kotLines?.reduce(
        (sum, kot) => sum + (kot.quantity || 0),
        0
      );
      console.log(
        `    - Order ${order._id.toString().slice(-8)}: ${order.status} | ₹${order.totalAmount || 0} | ${kotCount} KOTs | ${itemCount} items | ${order.createdAt.toLocaleString()}`
      );
    }

    // Check inventory transactions
    const totalTransactions = await InventoryTransaction.countDocuments({
      cartId: cartAdmin._id,
    });
    const outTransactions = await InventoryTransaction.countDocuments({
      cartId: cartAdmin._id,
      type: "OUT",
    });
    const wasteTransactions = await InventoryTransaction.countDocuments({
      cartId: cartAdmin._id,
      type: "WASTE",
    });

    console.log(`\n📝 INVENTORY TRANSACTIONS:`);
    console.log(`  Total Transactions: ${totalTransactions}`);
    console.log(`  OUT Transactions: ${outTransactions}`);
    console.log(`  WASTE Transactions: ${wasteTransactions}`);

    // Check recent consumption transactions
    const recentConsumption = await InventoryTransaction.find({
      cartId: cartAdmin._id,
      type: { $in: ["OUT", "WASTE"] },
    })
      .sort({ date: -1 })
      .limit(5)
      .populate("ingredientId", "name");

    console.log(`\n  Recent 5 Consumption Transactions:`);
    if (recentConsumption.length === 0) {
      console.log(`    ⚠️ NO CONSUMPTION TRANSACTIONS FOUND!`);
      console.log(
        `    This means ingredients are NOT being consumed when orders are finalized.`
      );
    } else {
      for (const txn of recentConsumption) {
        const ingredientName = txn.ingredientId?.name || "Unknown";
        console.log(
          `    - ${txn.type}: ${ingredientName} | ${txn.qty} ${txn.uom} | Cost: ₹${txn.costAllocated?.toFixed(2) || 0} | ${txn.date.toLocaleString()}`
        );
      }
    }

    // Calculate food cost
    const consumptionData = await InventoryTransaction.aggregate([
      {
        $match: {
          cartId: cartAdmin._id,
          type: { $in: ["OUT", "WASTE"] },
        },
      },
      {
        $group: {
          _id: null,
          totalFoodCost: { $sum: "$costAllocated" },
        },
      },
    ]);

    const totalFoodCost = consumptionData[0]?.totalFoodCost || 0;

    // Calculate sales
    const salesData = await Order.aggregate([
      {
        $match: {
          cartId: cartAdmin._id,
          status: { $in: ["Paid", "Finalized", "Exit"] },
        },
      },
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
        },
      },
    ]);

    const totalSales = salesData[0]?.totalSales || 0;
    const foodCostPercent =
      totalSales > 0 ? (totalFoodCost / totalSales) * 100 : 0;

    console.log(`\n💰 FOOD COST CALCULATION:`);
    console.log(`  Total Sales: ₹${totalSales.toFixed(2)}`);
    console.log(`  Total Food Cost: ₹${totalFoodCost.toFixed(2)}`);
    console.log(`  Food Cost %: ${foodCostPercent.toFixed(2)}%`);

    // DIAGNOSIS
    console.log(`\n🔍 DIAGNOSIS:`);
    if (finalizedOrders > 0 && outTransactions === 0) {
      console.log(`  ❌ ISSUE FOUND: Orders are finalized but NO consumption transactions exist!`);
      console.log(`  📋 POSSIBLE CAUSES:`);
      console.log(`     1. consumeIngredientsForOrder() is not being called`);
      console.log(`     2. Menu items are not linked to recipes`);
      console.log(`     3. Recipes are not linked to ingredients`);
      console.log(`     4. Ingredients have insufficient stock`);
      console.log(`     5. Consumption service is failing silently`);
      
      // Check if menu items have recipes
      const MenuItemV2 = require("../models/costing-v2/menuItemModel");
      const menuItemsCount = await MenuItemV2.countDocuments({ cartId: cartAdmin._id });
      const menuItemsWithRecipes = await MenuItemV2.countDocuments({
        cartId: cartAdmin._id,
        recipeId: { $exists: true, $ne: null },
      });
      
      console.log(`\n📋 MENU ITEMS CHECK:`);
      console.log(`  Total Menu Items: ${menuItemsCount}`);
      console.log(`  Menu Items with Recipes: ${menuItemsWithRecipes}`);
      console.log(`  Menu Items without Recipes: ${menuItemsCount - menuItemsWithRecipes}`);
      
      if (menuItemsWithRecipes === 0) {
        console.log(`  ⚠️ NO MENU ITEMS ARE LINKED TO RECIPES!`);
        console.log(`     → Solution: Link menu items to recipes in the Costing V2 > Menu Items panel`);
      }
    } else if (finalizedOrders === 0) {
      console.log(`  ⚠️ No finalized orders found. Orders need to be finalized for consumption to occur.`);
    } else if (outTransactions > 0) {
      console.log(`  ✅ Consumption transactions are being created properly!`);
      if (foodCostPercent === 0) {
        console.log(`  ⚠️ But food cost is 0. Check if cost is allocated correctly in transactions.`);
      } else {
        console.log(`  ✅ Food cost calculation is working correctly!`);
      }
    }

    console.log("\n" + "=".repeat(60));
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

diagnoseFoodCost();


