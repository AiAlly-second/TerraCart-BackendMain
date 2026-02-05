/**
 * Setup Menu Items for Inventory Consumption
 * 
 * This script helps identify which menu items from orders need to be added to the costing system.
 * It analyzes existing orders and shows what's missing.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const MenuItemV2 = require("../models/costing-v2/menuItemModel");
const RecipeV2 = require("../models/costing-v2/recipeModel");

async function analyzeMenuItems() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Get all unique menu items from orders
    const orders = await Order.find({
      status: { $in: ["Confirmed", "Preparing", "Ready", "Served", "Paid", "Finalized"] }
    }).lean();

    console.log(`📊 Analyzing ${orders.length} orders...\n`);

    const itemCounts = new Map();
    const cartItems = new Map(); // cartId -> Set of items

    // Collect all items from all orders
    orders.forEach(order => {
      const cartId = order.cartId?.toString() || order.cafeId?.toString();
      if (!cartId) return;

      if (!cartItems.has(cartId)) {
        cartItems.set(cartId, new Set());
      }

      order.kotLines?.forEach(kot => {
        kot.items?.forEach(item => {
          if (item.returned) return;
          
          const itemName = item.name?.trim();
          if (!itemName) return;

          // Count per cart
          const key = `${cartId}:${itemName}`;
          const current = itemCounts.get(key) || { cartId, itemName, count: 0, orders: new Set() };
          current.count += (item.quantity || 1);
          current.orders.add(order._id.toString());
          itemCounts.set(key, current);

          cartItems.get(cartId).add(itemName);
        });
      });
    });

    console.log(`📦 Found ${itemCounts.size} unique item-cart combinations\n`);

    // Check which items exist in costing system
    const missingItems = [];
    const existingItems = [];
    const itemsWithoutRecipes = [];

    for (const [key, data] of itemCounts.entries()) {
      const menuItem = await MenuItemV2.findOne({
        name: data.itemName,
        cartId: data.cartId
      }).lean();

      if (!menuItem) {
        missingItems.push({
          cartId: data.cartId,
          itemName: data.itemName,
          orderCount: data.orders.size,
          totalQuantity: data.count
        });
      } else if (!menuItem.recipeId) {
        itemsWithoutRecipes.push({
          cartId: data.cartId,
          itemName: data.itemName,
          menuItemId: menuItem._id.toString(),
          orderCount: data.orders.size,
          totalQuantity: data.count
        });
      } else {
        const recipe = await RecipeV2.findById(menuItem.recipeId).lean();
        if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) {
          itemsWithoutRecipes.push({
            cartId: data.cartId,
            itemName: data.itemName,
            menuItemId: menuItem._id.toString(),
            recipeId: menuItem.recipeId.toString(),
            orderCount: data.orders.size,
            totalQuantity: data.count,
            issue: "Recipe has no ingredients"
          });
        } else {
          existingItems.push({
            cartId: data.cartId,
            itemName: data.itemName,
            menuItemId: menuItem._id.toString(),
            recipeId: menuItem.recipeId.toString(),
            ingredientCount: recipe.ingredients.length
          });
        }
      }
    }

    // Print summary
    console.log("═══════════════════════════════════════════════════════");
    console.log("📊 MENU ITEMS ANALYSIS FOR INVENTORY CONSUMPTION");
    console.log("═══════════════════════════════════════════════════════\n");

    console.log(`✅ Items Ready for Consumption: ${existingItems.length}`);
    if (existingItems.length > 0) {
      console.log("\n   These items are configured correctly:");
      existingItems.slice(0, 10).forEach(item => {
        console.log(`   - ${item.itemName} (Cart: ${item.cartId.substring(0, 8)}...)`);
      });
      if (existingItems.length > 10) {
        console.log(`   ... and ${existingItems.length - 10} more`);
      }
    }

    console.log(`\n❌ Missing Menu Items: ${missingItems.length}`);
    if (missingItems.length > 0) {
      console.log("\n   These items need to be added to Costing V2:");
      missingItems.slice(0, 20).forEach(item => {
        console.log(`   - ${item.itemName}`);
        console.log(`     Cart ID: ${item.cartId}`);
        console.log(`     Used in ${item.orderCount} orders, ${item.totalQuantity} total quantity`);
      });
      if (missingItems.length > 20) {
        console.log(`   ... and ${missingItems.length - 20} more`);
      }
    }

    console.log(`\n⚠️  Items Without Recipes: ${itemsWithoutRecipes.length}`);
    if (itemsWithoutRecipes.length > 0) {
      console.log("\n   These items exist but need recipes linked:");
      itemsWithoutRecipes.slice(0, 20).forEach(item => {
        console.log(`   - ${item.itemName}`);
        console.log(`     Menu Item ID: ${item.menuItemId}`);
        if (item.issue) {
          console.log(`     Issue: ${item.issue}`);
        } else {
          console.log(`     Status: No recipe linked`);
        }
      });
      if (itemsWithoutRecipes.length > 20) {
        console.log(`   ... and ${itemsWithoutRecipes.length - 20} more`);
      }
    }

    // Group by cart
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("📦 SUMMARY BY CART");
    console.log("═══════════════════════════════════════════════════════\n");

    const cartSummary = new Map();
    missingItems.forEach(item => {
      if (!cartSummary.has(item.cartId)) {
        cartSummary.set(item.cartId, { missing: 0, withoutRecipes: 0, ready: 0 });
      }
      cartSummary.get(item.cartId).missing++;
    });

    itemsWithoutRecipes.forEach(item => {
      if (!cartSummary.has(item.cartId)) {
        cartSummary.set(item.cartId, { missing: 0, withoutRecipes: 0, ready: 0 });
      }
      cartSummary.get(item.cartId).withoutRecipes++;
    });

    existingItems.forEach(item => {
      if (!cartSummary.has(item.cartId)) {
        cartSummary.set(item.cartId, { missing: 0, withoutRecipes: 0, ready: 0 });
      }
      cartSummary.get(item.cartId).ready++;
    });

    cartSummary.forEach((summary, cartId) => {
      console.log(`Cart: ${cartId.substring(0, 8)}...`);
      console.log(`  ✅ Ready: ${summary.ready}`);
      console.log(`  ❌ Missing: ${summary.missing}`);
      console.log(`  ⚠️  Without Recipes: ${summary.withoutRecipes}`);
      console.log();
    });

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("📝 ACTION REQUIRED");
    console.log("═══════════════════════════════════════════════════════\n");

    if (missingItems.length === 0 && itemsWithoutRecipes.length === 0) {
      console.log("✅ All menu items are configured! Inventory consumption should work.");
    } else {
      console.log("To enable inventory consumption:\n");
      console.log("1. Go to Finances Panel → Menu Items");
      console.log("2. Add missing menu items (see list above)");
      console.log("3. Go to Finances Panel → Recipes");
      console.log("4. Create recipes for menu items");
      console.log("5. Link recipes to menu items");
      console.log("\nOnce done, inventory will be consumed automatically when orders are placed!");
    }

  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

analyzeMenuItems();


