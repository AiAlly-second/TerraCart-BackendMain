/**
 * Check Full Food Costing Consumption Flow
 * This script checks every step of the food costing flow
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const MenuItemV2 = require("../models/costing-v2/menuItemModel");
const RecipeV2 = require("../models/costing-v2/recipeModel");
const IngredientV2 = require("../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../models/costing-v2/inventoryTransactionModel");
const User = require("../models/userModel");

async function checkConsumptionFlow() {
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
    console.log("🛒 CART ADMIN INFO");
    console.log("=".repeat(70));
    console.log(`Name: ${cartAdmin.cartName || cartAdmin.name}`);
    console.log(`Cart ID: ${cartId}`);
    console.log(`Email: ${cartAdmin.email}`);
    console.log("=".repeat(70));

    // Step 1: Check recent finalized orders
    console.log("\n📦 STEP 1: CHECK RECENT FINALIZED ORDERS");
    console.log("-".repeat(70));
    
    const finalizedOrders = await Order.find({
      cartId: cartId,
      status: { $in: ["Paid", "Finalized", "Exit"] },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    console.log(`Total finalized orders: ${finalizedOrders.length}`);
    
    if (finalizedOrders.length === 0) {
      console.log("⚠️ No finalized orders found. Create and finalize an order first.");
      return;
    }

    const recentOrder = finalizedOrders[0];
    console.log(`\nMost recent finalized order:`);
    console.log(`  Order ID: ${recentOrder._id}`);
    console.log(`  Status: ${recentOrder.status}`);
    console.log(`  Date: ${new Date(recentOrder.createdAt).toLocaleString()}`);
    console.log(`  KOT Lines: ${recentOrder.kotLines?.length || 0}`);
    
    if (!recentOrder.kotLines || recentOrder.kotLines.length === 0) {
      console.log("⚠️ Order has no KOT lines (no items)");
      return;
    }

    // Step 2: Extract items from order
    console.log("\n📋 STEP 2: ITEMS IN ORDER");
    console.log("-".repeat(70));
    
    const orderItems = [];
    recentOrder.kotLines.forEach((kot, kotIndex) => {
      if (kot.items && kot.items.length > 0) {
        kot.items.forEach((item) => {
          orderItems.push({
            kotIndex,
            name: item.name,
            quantity: item.quantity || 1,
            price: item.price,
            returned: item.returned || false,
          });
        });
      }
    });

    console.log(`Total items: ${orderItems.length}`);
    orderItems.forEach((item, idx) => {
      console.log(
        `  ${idx + 1}. ${item.name} (x${item.quantity}) - ₹${item.price}${item.returned ? " [RETURNED]" : ""}`
      );
    });

    // Step 3: Check if items exist in MenuItemV2
    console.log("\n🍽️ STEP 3: CHECK MENU ITEMS IN COSTING V2");
    console.log("-".repeat(70));
    
    const totalMenuItems = await MenuItemV2.countDocuments({
      $or: [{ cartId: cartId }, { cartId: null }],
    });
    
    console.log(`Total menu items in Costing V2 for this cart: ${totalMenuItems}`);
    
    if (totalMenuItems === 0) {
      console.log("❌ NO MENU ITEMS FOUND IN COSTING V2!");
      console.log("\n🔧 SOLUTION:");
      console.log("  1. Go to Finances → Menu Items");
      console.log("  2. Click '+ New Menu Item'");
      console.log("  3. Create menu items for:");
      orderItems.forEach((item) => {
        console.log(`     - ${item.name}`);
      });
      console.log("  4. Link each to a recipe");
      console.log("  5. Place a NEW order to test\n");
      return;
    }

    // Check each order item
    console.log("\nChecking if order items exist in Costing V2:");
    const itemMatches = [];
    
    for (const orderItem of orderItems) {
      if (orderItem.returned) continue;
      
      const menuItem = await MenuItemV2.findOne({
        name: { $regex: new RegExp(`^${orderItem.name.trim()}$`, "i") },
        $or: [{ cartId: cartId }, { cartId: null }],
      });

      const exists = !!menuItem;
      itemMatches.push({
        orderItem: orderItem.name,
        exists,
        menuItemId: menuItem?._id,
        hasRecipe: !!menuItem?.recipeId,
        recipeId: menuItem?.recipeId,
      });

      console.log(
        `  ${exists ? "✅" : "❌"} "${orderItem.name}" ${exists ? `(ID: ${menuItem._id})` : "NOT FOUND"}`
      );
      if (exists && !menuItem.recipeId) {
        console.log(`     ⚠️ Menu item has NO RECIPE linked!`);
      }
    }

    const unmatchedItems = itemMatches.filter((m) => !m.exists);
    if (unmatchedItems.length > 0) {
      console.log(`\n❌ ${unmatchedItems.length} items NOT found in Costing V2:`);
      unmatchedItems.forEach((item) => {
        console.log(`   - "${item.orderItem}"`);
      });
      console.log("\n🔧 SOLUTION: Create menu items for these items");
      return;
    }

    const itemsWithoutRecipes = itemMatches.filter((m) => m.exists && !m.hasRecipe);
    if (itemsWithoutRecipes.length > 0) {
      console.log(`\n⚠️ ${itemsWithoutRecipes.length} menu items have NO RECIPE:`);
      itemsWithoutRecipes.forEach((item) => {
        console.log(`   - "${item.orderItem}"`);
      });
      console.log("\n🔧 SOLUTION: Link these menu items to recipes");
    }

    // Step 4: Check recipes
    console.log("\n🧾 STEP 4: CHECK RECIPES (BOMs)");
    console.log("-".repeat(70));
    
    const itemsWithRecipes = itemMatches.filter((m) => m.hasRecipe);
    
    for (const item of itemsWithRecipes) {
      const recipe = await RecipeV2.findById(item.recipeId);
      if (!recipe) {
        console.log(`❌ Recipe ${item.recipeId} not found for "${item.orderItem}"`);
        continue;
      }

      console.log(`\n  📋 Recipe: ${recipe.name}`);
      console.log(`     Portions: ${recipe.portions}`);
      console.log(`     Cost per portion: ₹${recipe.costPerPortion?.toFixed(2) || 0}`);
      console.log(`     Ingredients: ${recipe.ingredients?.length || 0}`);

      if (!recipe.ingredients || recipe.ingredients.length === 0) {
        console.log(`     ⚠️ Recipe has NO INGREDIENTS!`);
        continue;
      }

      // Check each ingredient
      for (const recipeIng of recipe.ingredients) {
        const ingredient = await IngredientV2.findById(recipeIng.ingredientId);
        if (ingredient) {
          console.log(
            `     - ${ingredient.name}: ${recipeIng.qty} ${recipeIng.uom} (Stock: ${ingredient.qtyOnHand} ${ingredient.baseUnit})`
          );
        } else {
          console.log(`     - ❌ Ingredient ${recipeIng.ingredientId} not found`);
        }
      }
    }

    // Step 5: Check inventory transactions
    console.log("\n📝 STEP 5: CHECK INVENTORY TRANSACTIONS");
    console.log("-".repeat(70));
    
    const orderTransactions = await InventoryTransaction.find({
      refType: "order",
      refId: recentOrder._id,
    })
      .populate("ingredientId", "name")
      .lean();

    console.log(
      `Transactions for order ${recentOrder._id}: ${orderTransactions.length}`
    );

    if (orderTransactions.length === 0) {
      console.log("❌ NO TRANSACTIONS FOUND!");
      console.log("\n🔍 POSSIBLE CAUSES:");
      console.log("  1. Menu items not in Costing V2");
      console.log("  2. Menu items not linked to recipes");
      console.log("  3. Recipes have no ingredients");
      console.log("  4. Consumption service failed silently");
      console.log("  5. Order was placed BEFORE menu items were created");
      console.log("\n🔧 SOLUTION: Place a NEW order and finalize it");
    } else {
      console.log("\n✅ Transactions found:");
      orderTransactions.forEach((txn) => {
        console.log(
          `  - ${txn.ingredientId?.name || "Unknown"}: ${txn.qty} ${txn.uom} (Cost: ₹${txn.costAllocated?.toFixed(2) || 0})`
        );
      });
    }

    // Step 6: Summary
    console.log("\n📊 SUMMARY");
    console.log("=".repeat(70));
    
    const allMenuItemsExist = unmatchedItems.length === 0;
    const allHaveRecipes = itemsWithoutRecipes.length === 0;
    const transactionsExist = orderTransactions.length > 0;

    console.log(`✅ Menu items in Costing V2: ${allMenuItemsExist ? "YES" : "NO"}`);
    console.log(`✅ Menu items have recipes: ${allHaveRecipes ? "YES" : "NO"}`);
    console.log(`✅ Consumption transactions: ${transactionsExist ? "YES" : "NO"}`);

    if (!allMenuItemsExist || !allHaveRecipes) {
      console.log("\n🎯 ACTION REQUIRED:");
      if (!allMenuItemsExist) {
        console.log("  1. Create menu items in Costing V2 for missing items");
      }
      if (!allHaveRecipes) {
        console.log("  2. Link menu items to recipes");
      }
      console.log("  3. Place a NEW order to test");
      console.log("  4. Finalize the order");
      console.log("  5. Check Finances Dashboard");
    } else if (!transactionsExist) {
      console.log("\n⚠️ Setup looks correct but no transactions found.");
      console.log("🎯 ACTION: This order was placed BEFORE setup.");
      console.log("  → Place a NEW order now to test");
    } else {
      console.log("\n✅ FOOD COSTING IS WORKING CORRECTLY!");
    }

    console.log("=".repeat(70));
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

checkConsumptionFlow();


