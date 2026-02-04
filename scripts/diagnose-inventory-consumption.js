/**
 * Diagnostic script to check why inventory is not being deducted
 * Checks:
 * 1. Recent orders and their consumption status
 * 2. Menu items in both costing systems
 * 3. Recipe/BOM configuration
 * 4. Inventory transactions created
 * 5. Inventory stock levels
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Order = require("../models/orderModel");
const { MenuItem } = require("../models/menuItemModel");
const MenuItemV2 = require("../models/costing-v2/menuItemModel");
const Recipe = require("../models/recipeModel");
const RecipeV2 = require("../models/costing-v2/recipeModel");
const RecipeIngredient = require("../models/recipeIngredientModel");
const InventoryTransaction = require("../models/inventoryTransactionModel");
const InventoryTransactionV2 = require("../models/costing-v2/inventoryTransactionModel");
const InventoryItem = require("../models/inventoryModel");
const Ingredient = require("../models/ingredientModel");
const IngredientV2 = require("../models/costing-v2/ingredientModel");

dotenv.config({ path: "./.env" });

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
};

const diagnoseInventoryConsumption = async () => {
  await connectDB();

  try {
    console.log("═══════════════════════════════════════════════════════");
    console.log("🔍 INVENTORY CONSUMPTION DIAGNOSIS");
    console.log("═══════════════════════════════════════════════════════\n");

    // Get recent orders (last 10)
    const recentOrders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    console.log(`📦 Found ${recentOrders.length} recent orders\n`);

    if (recentOrders.length === 0) {
      console.log("❌ No orders found. Please create an order first.\n");
      await mongoose.disconnect();
      return;
    }

    // Analyze each order
    for (const order of recentOrders) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`📋 Order ID: ${order._id}`);
      console.log(`   Status: ${order.status}`);
      console.log(`   Cart ID: ${order.cartId || order.cafeId || "N/A"}`);
      console.log(`   Created: ${order.createdAt}`);
      console.log(`${"=".repeat(60)}\n`);

      // Check for inventory transactions
      const transactionsV2 = await InventoryTransactionV2.find({
        refType: "order",
        refId: order._id,
      }).lean();

      // Old system referenceId might be ObjectId or string, try both
      let transactionsOld = [];
      try {
        // Try as ObjectId first (if order._id is ObjectId)
        transactionsOld = await InventoryTransaction.find({
          changeType: "consumption",
          referenceId: order._id,
        }).lean();
      } catch (err) {
        // If order._id is string, try string match
        try {
          transactionsOld = await InventoryTransaction.find({
            changeType: "consumption",
            $or: [
              { referenceId: order._id },
              { remarks: { $regex: order._id } },
            ],
          }).lean();
        } catch (err2) {
          console.log(`      ⚠️  Error querying old transactions: ${err2.message}`);
        }
      }

      console.log(`   📊 Inventory Transactions:`);
      console.log(`      V2 System: ${transactionsV2.length} transactions`);
      console.log(`      Old System: ${transactionsOld.length} transactions`);

      if (transactionsV2.length === 0 && transactionsOld.length === 0) {
        console.log(`      ⚠️  NO TRANSACTIONS FOUND - Consumption may not have occurred!\n`);
      } else {
        console.log(`      ✅ Transactions found\n`);
      }

      // Check KOT lines and items
      if (!order.kotLines || order.kotLines.length === 0) {
        console.log(`   ⚠️  Order has no KOT lines\n`);
        continue;
      }

      console.log(`   📝 KOT Lines: ${order.kotLines.length}\n`);

      // Analyze each item in the order
      for (let i = 0; i < order.kotLines.length; i++) {
        const kotLine = order.kotLines[i];
        if (!kotLine.items || kotLine.items.length === 0) continue;

        console.log(`   ┌─ KOT ${i}:`);
        for (const item of kotLine.items) {
          const itemName = item.name;
          const itemQty = item.quantity || 1;

          console.log(`   │  Item: ${itemName} (Qty: ${itemQty})`);

          // Check NEW costing-v2 system (Finances Panel) - this is the only system now
          // ONLY use cartId (not cafeId)
          const cartIdForLookup = order.cartId;
          
          // Try with cartId first
          let menuItemV2 = await MenuItemV2.findOne({
            $or: [
              { name: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }, cartId: cartIdForLookup, isActive: true },
              { name: itemName, cartId: cartIdForLookup, isActive: true },
            ],
          }).lean();

          // If not found, try without cartId (shared items)
          if (!menuItemV2) {
            menuItemV2 = await MenuItemV2.findOne({
              $or: [
                { name: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }, isActive: true },
                { name: itemName, isActive: true },
                { defaultMenuItemName: itemName, isActive: true },
              ],
            }).lean();
          }

          if (menuItemV2) {
            console.log(`   │  ✅ Found in NEW costing-v2 system (Finances Panel) (MenuItemV2 ID: ${menuItemV2._id})`);

            if (menuItemV2.recipeId) {
              const recipeV2 = await RecipeV2.findById(menuItemV2.recipeId).lean();

              if (recipeV2) {
                console.log(`   │  ✅ Recipe found (RecipeV2 ID: ${recipeV2._id})`);

                if (recipeV2.ingredients && recipeV2.ingredients.length > 0) {
                  console.log(`   │  ✅ Recipe has ${recipeV2.ingredients.length} ingredients`);
                  console.log(`   │  Ingredients:`);
                  for (const ri of recipeV2.ingredients) {
                    const ing = await IngredientV2.findById(ri.ingredientId).lean();
                    if (ing) {
                      const scaleFactor = itemQty / (recipeV2.portions || 1);
                      const totalQty = ri.qty * scaleFactor;
                      console.log(`   │     - ${ing.name}: ${ri.qty} ${ri.uom} per ${recipeV2.portions || 1} portions = ${totalQty.toFixed(2)} ${ri.uom} total`);

                      // Check inventory stock
                      console.log(`   │        Stock: ${ing.qtyOnHand || 0} ${ing.baseUnit}`);

                      // Check for transaction
                      const hasTransaction = transactionsV2.some(
                        (t) => t.ingredientId && t.ingredientId.toString() === ing._id.toString()
                      );
                      if (hasTransaction) {
                        console.log(`   │        ✅ Consumption transaction found`);
                      } else {
                        console.log(`   │        ❌ NO consumption transaction found`);
                      }
                    }
                  }
                } else {
                  console.log(`   │  ⚠️  Recipe has NO ingredients`);
                }
              } else {
                console.log(`   │  ❌ Recipe not found (recipeId: ${menuItemV2.recipeId})`);
              }
            } else {
              console.log(`   │  ❌ Menu item has NO recipeId linked`);
              console.log(`   │     Action: Go to Finances → Menu Items → Edit → Link a Recipe`);
            }
          } else {
            // Check OLD system for reference (but won't be used)
            const menuItemOld = await MenuItem.findOne({
              name: { $regex: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
              isAvailable: true,
            }).lean();

            if (menuItemOld) {
              console.log(`   │  ⚠️  Found in OLD costing system (but OLD system is disabled)`);
              console.log(`   │     Action: Add this item to Finances Panel → Menu Items`);
            } else {
              console.log(`   │  ❌ NOT FOUND in NEW costing-v2 system (Finances Panel)`);
              console.log(`   │     Action: Add this item to Finances Panel → Menu Items`);
            }
          }
        }
        console.log(`   └─`);
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("📊 SUMMARY");
    console.log(`${"=".repeat(60)}\n`);

    // Count orders with and without transactions
    let ordersWithTransactions = 0;
    let ordersWithoutTransactions = 0;

    for (const order of recentOrders) {
      const transactionsV2 = await InventoryTransactionV2.countDocuments({
        refType: "order",
        refId: order._id,
      });
      let transactionsOld = 0;
      try {
        transactionsOld = await InventoryTransaction.countDocuments({
          changeType: "consumption",
          referenceId: order._id,
        });
      } catch (err) {
        // If order._id is string, try string match
        try {
          transactionsOld = await InventoryTransaction.countDocuments({
            changeType: "consumption",
            $or: [
              { referenceId: order._id },
              { remarks: { $regex: order._id } },
            ],
          });
        } catch (err2) {
          // Ignore
        }
      }

      if (transactionsV2 > 0 || transactionsOld > 0) {
        ordersWithTransactions++;
      } else {
        ordersWithoutTransactions++;
      }
    }

    console.log(`Orders with consumption transactions: ${ordersWithTransactions}`);
    console.log(`Orders without consumption transactions: ${ordersWithoutTransactions}\n`);

    if (ordersWithoutTransactions > 0) {
      console.log("⚠️  ISSUES FOUND:");
      console.log("   1. Some orders have no consumption transactions");
      console.log("   2. Possible causes:");
      console.log("      - Menu items not found in costing systems");
      console.log("      - Recipes not linked to menu items");
      console.log("      - Recipes have no ingredients");
      console.log("      - Consumption service errors (check server logs)");
      console.log("      - Order cartId missing or incorrect\n");
    }

  } catch (error) {
    console.error("Error during diagnosis:", error);
  } finally {
    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB\n");
  }
};

diagnoseInventoryConsumption();

