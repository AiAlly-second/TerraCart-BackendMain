/**
 * Order Consumption Service
 * Automatically consumes ingredients from inventory when orders are ready/paid/completed
 * Handles both DINE_IN and TAKEAWAY orders, including items converted from dine-in to takeaway
 * Uses ONLY the NEW costing-v2 system (Finances Panel)
 */

const mongoose = require("mongoose");

// Costing V2 System Models (NEW Finances Panel)
const MenuItemV2 = require("../../models/costing-v2/menuItemModel");
const RecipeV2 = require("../../models/costing-v2/recipeModel");
const IngredientV2 = require("../../models/costing-v2/ingredientModel");
const WeightedAverageService = require("./weightedAverageService");
const InventoryTransactionV2 = require("../../models/costing-v2/inventoryTransactionModel");
const { MenuItem } = require("../../models/menuItemModel");
const MenuCategory = require("../../models/menuCategoryModel");
const User = require("../../models/userModel");

/**
 * Consume ingredients for an order when it's marked as Preparing, Ready, Paid, Finalized, or Completed
 * Processes all items in the order (dine-in, takeaway, and converted-to-takeaway items)
 * Uses ONLY the NEW costing-v2 system (Finances Panel)
 * @param {Object} order - Order document (can be DINE_IN or TAKEAWAY)
 * @param {String} userId - User ID who triggered the consumption
 * @returns {Promise<Object>} Consumption summary
 */
async function consumeIngredientsForOrder(order, userId) {
  try {
    // Get cart ID from order - ONLY use cartId (not cafeId)
    // Handle both ObjectId and string formats
    let cartId = order.cartId;
    if (cartId && typeof cartId === "object" && cartId._id) {
      cartId = cartId._id;
    }
    if (cartId && typeof cartId === "object" && cartId.toString) {
      cartId = cartId.toString();
    }

    // Use ObjectId for Mongoose queries (MongoDB does not match ObjectId fields with string)
    const cartIdObj =
      cartId && mongoose.Types.ObjectId.isValid(cartId)
        ? new mongoose.Types.ObjectId(cartId)
        : null;

    if (!cartId) {
      console.warn(
        `[COSTING] Order ${order._id} has no cartId, skipping consumption`
      );
      console.warn(`[COSTING] Order data:`, {
        cartId: order.cartId,
        franchiseId: order.franchiseId,
      });
      return {
        success: false,
        message: "Order has no cartId association",
      };
    }

    // recordedBy must be valid ObjectId (required by InventoryTransactionV2) - use cartId as fallback
    const recordedById =
      userId && mongoose.Types.ObjectId.isValid(String(userId))
        ? new mongoose.Types.ObjectId(String(userId))
        : cartIdObj;

    if (!recordedById) {
      console.warn(
        `[COSTING] Order ${order._id}: no valid userId or cartId for recordedBy, skipping consumption`
      );
      return {
        success: false,
        message: "No valid user/cart ID for recording consumption",
      };
    }

    console.log(`[COSTING] Processing order ${order._id} for cart ${cartId}`);

    // Check existing transactions to determine which KOTs are processed (Idempotency + Incremental)
    // Only check new costing-v2 system transactions
    const existingTransactions = await InventoryTransactionV2.find({
      refType: "order",
      refId: order._id,
    }).select('notes').lean();

    const processedKotIds = new Set();
    let hasLegacyTransactions = false;

    existingTransactions.forEach(t => {
      if (t.notes && t.notes.startsWith("KOT:")) {
        const id = t.notes.split(":")[1];
        if (id) processedKotIds.add(id);
      } else {
        hasLegacyTransactions = true;
      }
    });

    // Handle legacy transactions (assume KOT 0 is processed if legacy transaction exists)
    // This allows backward compatibility for orders processed before this update
    if (hasLegacyTransactions) {
        processedKotIds.add("0");
    }

    const consumptionSummary = {
      orderId: order._id,
      itemsProcessed: 0,
      ingredientsConsumed: [],
      totalCost: 0,
      errors: [],
    };

    // Process each KOT line
    if (!order.kotLines || order.kotLines.length === 0) {
      return {
        success: true,
        message: "Order has no items",
        summary: consumptionSummary,
      };
    }

    let anythingProcessed = false;

    // Iterate through KOTs using index as stable ID (since KOTs are append-only)
    for (let i = 0; i < order.kotLines.length; i++) {
      const kotLine = order.kotLines[i];
      const kotId = i.toString();

      if (processedKotIds.has(kotId)) {
        // Already processed this KOT
        continue;
      }

      if (!kotLine.items || kotLine.items.length === 0) continue;

      anythingProcessed = true;
      console.log(`[COSTING] Processing KOT ${kotId} for order ${order._id}`);

      for (const orderItem of kotLine.items) {
        // Skip returned items (takeaway items and converted-to-takeaway items are still processed)
        if (orderItem.returned) continue;

        const itemQuantity = orderItem.quantity || 1;
        const itemName = orderItem.name;

        // Log if item is takeaway for debugging
        if (orderItem.convertedToTakeaway || order.serviceType === "TAKEAWAY") {
          console.log(
            `[COSTING] Processing ${
              orderItem.convertedToTakeaway
                ? "converted-to-takeaway"
                : "takeaway"
            } item: ${itemName} (qty: ${itemQuantity})`
          );
        }

        try {
          // Normalize item name for matching (trim and lowercase)
          const normalizedItemName = itemName.trim();
          const nameRegex = new RegExp(
            `^${normalizedItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "i"
          );

          // Find menu item in NEW costing-v2 system (Finances Panel)
          console.log(`[COSTING] Checking NEW costing-v2 system (Finances Panel) for "${itemName}"...`);

          let menuItem = null;

          // Strategy 1: Direct lookup by menuItemId if provided (from frontend)
          const menuItemId = orderItem.menuItemId || orderItem.costingMenuItemId;
          if (menuItemId) {
            menuItem = await MenuItemV2.findOne({
              _id: menuItemId,
              isActive: true,
              $or: [{ cartId: cartIdObj || cartId }, { cartId: null }],
            });
          }

          // Strategy 2: Lookup by name + cartId (cart-specific)
          if (!menuItem) {
            menuItem = await MenuItemV2.findOne({
              $or: [
                { name: normalizedItemName, cartId: cartIdObj || cartId, isActive: true },
                {
                  name: { $regex: nameRegex },
                  cartId: cartIdObj || cartId,
                  isActive: true,
                },
                { defaultMenuItemName: normalizedItemName, cartId: cartIdObj || cartId, isActive: true },
                {
                  defaultMenuItemName: { $regex: nameRegex },
                  cartId: cartIdObj || cartId,
                  isActive: true,
                },
              ],
            });
          }

          // Strategy 3: Lookup by name with cartId (prefer cart-specific in shared query)
          if (!menuItem) {
            menuItem = await MenuItemV2.findOne({
              cartId: cartIdObj || cartId,
              $or: [
                { name: normalizedItemName, isActive: true },
                { name: { $regex: nameRegex }, isActive: true },
                { defaultMenuItemName: normalizedItemName, isActive: true },
                { defaultMenuItemName: { $regex: nameRegex }, isActive: true },
              ],
            });
          }

          // Strategy 4: Fallback via cart MenuItem - get canonical name from cart menu
          let cartMenuItem = null;
          if (!menuItem) {
            cartMenuItem = await MenuItem.findOne({
              $or: [{ cafeId: cartIdObj || cartId }, { cartId: cartIdObj || cartId }],
              name: { $regex: nameRegex },
            }).lean();
            if (cartMenuItem && cartMenuItem.name) {
              const canonicalName = cartMenuItem.name.trim();
              menuItem = await MenuItemV2.findOne({
                cartId: cartIdObj || cartId,
                isActive: true,
                $or: [
                  { name: canonicalName },
                  { name: { $regex: new RegExp(`^${canonicalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
                  { defaultMenuItemName: canonicalName },
                  { defaultMenuItemName: { $regex: new RegExp(`^${canonicalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
                ],
              });
            }
          }

          // Strategy 4.5: Auto-create MenuItemV2 when cart item found but not in Finances (connects BOM to orders)
          // Works for both franchise and standalone cart admins (franchiseId can be null)
          if (!menuItem && cartMenuItem && cartMenuItem.name && cartIdObj) {
            let franchiseId = order.franchiseId;
            if (!franchiseId) {
              const cartUser = await User.findById(cartId).select("franchiseId").lean();
              franchiseId = cartUser?.franchiseId;
            }
            // Allow auto-create for standalone carts (franchiseId null) - use cartId-only scope for recipes
            {
              const createItemName = cartMenuItem.name.trim();
              const newPrice = Number(cartMenuItem.price) || 0;
              if (newPrice > 0) {
                try {
                  let categoryName = "General";
                  if (cartMenuItem.category) {
                    const cat = await MenuCategory.findById(cartMenuItem.category).select("name").lean();
                    if (cat?.name) categoryName = cat.name;
                  }
                  let recipeId = null;
                  const nameNormalized = createItemName.replace(/\s+/g, " ").toLowerCase();
                  const recipeRegex = new RegExp(
                    `^${createItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i"
                  );
                  const matchingRecipe = await RecipeV2.findOne({
                    isActive: true,
                    $and: [
                      { $or: [{ nameNormalized }, { name: { $regex: recipeRegex } }] },
                      {
                        $or: [
                          { cartId: cartIdObj },
                          { cartId: null, franchiseId },
                          { franchiseId },
                        ],
                      },
                    ],
                  }).lean();
                  if (matchingRecipe) recipeId = matchingRecipe._id;

                  const newCostingItem = new MenuItemV2({
                    name: createItemName,
                    category: categoryName,
                    sellingPrice: newPrice,
                    recipeId,
                    cartId: cartIdObj,
                    franchiseId,
                    defaultMenuItemName: createItemName,
                    defaultMenuCategoryName: categoryName,
                  });
                  await newCostingItem.save();
                  console.log(
                    `[COSTING] Auto-created costing menu item "${createItemName}" for cart ${cartId} (BOM linked: ${!!recipeId})`,
                  );
                  menuItem = newCostingItem;
                } catch (createErr) {
                  console.error(
                    `[COSTING] Error auto-creating MenuItemV2 for "${createItemName}":`,
                    createErr.message,
                  );
                }
              }
            }
          }

          // Strategy 5: Shared menu items (no cartId filter) as last resort
          if (!menuItem) {
            menuItem = await MenuItemV2.findOne({
              $or: [
                { name: normalizedItemName, isActive: true },
                { name: { $regex: nameRegex }, isActive: true },
                { defaultMenuItemName: normalizedItemName, isActive: true },
                { defaultMenuItemName: { $regex: nameRegex }, isActive: true },
              ],
            });
          }

          if (!menuItem) {
            console.warn(
              `[COSTING] Menu item not found in costing-v2 system (Finances Panel): "${itemName}" for cart ${cartId}`
            );
            consumptionSummary.errors.push({
              item: itemName,
              error:
                "Menu item not found in Finances Panel. Please add this item to Finances → Menu Items.",
            });
            continue;
          }

          // If menu item has no recipe, try to auto-link by name (same cart/franchise)
          if (!menuItem.recipeId) {
            const nameNorm = (menuItem.name || normalizedItemName).trim().replace(/\s+/g, " ").toLowerCase();
            const recipeRegex = new RegExp(
              `^${(menuItem.name || normalizedItemName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              "i"
            );
            const matchingRecipe = await RecipeV2.findOne({
              isActive: true,
              $and: [
                {
                  $or: [
                    { nameNormalized: nameNorm },
                    { name: { $regex: recipeRegex } },
                  ],
                },
                {
                  $or: [
                    { cartId: cartIdObj || cartId },
                    { cartId: null, franchiseId: menuItem.franchiseId },
                    { franchiseId: menuItem.franchiseId },
                  ],
                },
              ],
            });
            if (matchingRecipe) {
              menuItem.recipeId = matchingRecipe._id;
              await menuItem.save();
              console.log(
                `[COSTING] Auto-linked BOM "${matchingRecipe.name}" to menu item "${menuItem.name}"`
              );
            }
          }

          // Skip if menu item still has no recipe
          if (!menuItem.recipeId) {
            console.warn(
              `[COSTING] Menu item "${itemName}" has no recipe linked. Skipping consumption. (ID: ${menuItem._id})`
            );
            consumptionSummary.errors.push({
              item: itemName,
              error:
                `Menu item "${itemName}" exists in Finances but has no recipe linked.`,
            });
            continue;
          }

          console.log(`[COSTING] ✅ Found "${itemName}" in costing-v2 system (Finances Panel), consuming ingredients...`);

          // Get recipe
          const recipe = await RecipeV2.findById(menuItem.recipeId);
          if (
            !recipe ||
            !recipe.ingredients ||
            recipe.ingredients.length === 0
          ) {
            console.warn(
              `[COSTING] Recipe not found or empty for menu item: ${itemName}`
            );
            consumptionSummary.errors.push({
              item: itemName,
              error: "Recipe not found or empty",
            });
            continue;
          }

          // Calculate scaling factor based on quantity ordered
          // Recipe is for 'portions', so we need to scale ingredients
          const scaleFactor = itemQuantity / recipe.portions;

          // Consume each ingredient in the recipe
          for (const recipeIngredient of recipe.ingredients) {
            try {
              const ingredient = await IngredientV2.findById(
                recipeIngredient.ingredientId
              );
              if (!ingredient) {
                console.warn(
                  `[COSTING] Ingredient not found: ${recipeIngredient.ingredientId}`
                );
                continue;
              }

              // Calculate quantity to consume (scaled by order quantity)
              const qtyPerPortion = recipeIngredient.qty;
              const totalQtyToConsume = qtyPerPortion * scaleFactor;

              // Convert to base unit
              let qtyInBaseUnit;
              try {
                qtyInBaseUnit = ingredient.convertToBaseUnit(
                  totalQtyToConsume,
                  recipeIngredient.uom
                );
              } catch (conversionError) {
                console.error(
                  `[COSTING] Unit conversion error for ${ingredient.name}:`,
                  conversionError.message
                );
                // Try to add conversion factor if missing
                if (!ingredient.conversionFactors.has(recipeIngredient.uom)) {
                  console.warn(
                    `[COSTING] Adding missing conversion factor for ${recipeIngredient.uom} to ${ingredient.baseUnit}`
                  );
                  // Assume 1:1 if same unit type, otherwise skip
                  if (recipeIngredient.uom === ingredient.baseUnit) {
                    ingredient.conversionFactors.set(recipeIngredient.uom, 1);
                    await ingredient.save();
                    qtyInBaseUnit = totalQtyToConsume;
                  } else {
                    throw conversionError;
                  }
                } else {
                  throw conversionError;
                }
              }

              // BRUTE FORCE: Skip stock check and force consumption
              // if (ingredient.qtyOnHand < qtyInBaseUnit) { ... } -> Removed checks
              
              console.log(`[COSTING] Consuming ${qtyInBaseUnit} ${ingredient.baseUnit} of ${ingredient.name} (Available: ${ingredient.qtyOnHand}) - Brute force mode`);

              // Consume using weighted average
              const consumeResult = await WeightedAverageService.consume(
                recipeIngredient.ingredientId,
                qtyInBaseUnit,
                "order",
                order._id,
                recordedById,
                cartId,
                true // allowNegativeStock: true (Brute Force)
              );

              // Create inventory transaction regarding this KOT (V2 system)
              const transaction = new InventoryTransactionV2({
                ingredientId: recipeIngredient.ingredientId,
                type: "OUT",
                qty: totalQtyToConsume, // Original quantity
                uom: recipeIngredient.uom, // Original unit
                qtyInBaseUnit: qtyInBaseUnit, // Quantity in base unit
                refType: "order",
                refId: order._id,
                date: new Date(),
                costAllocated: consumeResult.costAllocated,
                recordedBy: recordedById,
                cartId: cartIdObj || null,
                notes: `KOT:${kotId}`, // Mark which KOT this belongs to
              });
              await transaction.save();

              consumptionSummary.ingredientsConsumed.push({
                ingredient: ingredient.name,
                quantity: qtyInBaseUnit,
                unit: ingredient.baseUnit,
                cost: consumeResult.costAllocated,
              });

              consumptionSummary.totalCost += consumeResult.costAllocated;
            } catch (ingredientError) {
              console.error(
                `[COSTING] Error consuming ingredient ${recipeIngredient.ingredientId} for order ${order._id}:`,
                ingredientError.message
              );
              consumptionSummary.errors.push({
                item: itemName,
                ingredient: recipeIngredient.ingredientId,
                error: ingredientError.message,
              });
            }
          }

          consumptionSummary.itemsProcessed++;
          console.log(`[COSTING] ✅ Successfully consumed "${itemName}" from costing-v2 system (Finances Panel)`);
        } catch (itemError) {
          console.error(
            `[COSTING] Error processing item ${itemName} for order ${order._id}:`,
            itemError.message
          );
          consumptionSummary.errors.push({
            item: itemName,
            error: itemError.message,
          });
        }
      }
    }

    if (!anythingProcessed) {
        console.log(`[COSTING] Order ${order._id} - No new KOTs to process`);
        return {
            success: true,
            alreadyProcessed: true,
            message: "No new items to process",
            summary: consumptionSummary
        };
    }

    console.log(`[COSTING] Order ${order._id} consumption complete:`, {
      itemsProcessed: consumptionSummary.itemsProcessed,
      ingredientsConsumed: consumptionSummary.ingredientsConsumed.length,
      totalCost: consumptionSummary.totalCost,
      errors: consumptionSummary.errors.length,
    });

    if (consumptionSummary.errors.length > 0) {
      console.warn(
        `[COSTING] Order ${order._id} consumption had ${consumptionSummary.errors.length} error(s):`,
        consumptionSummary.errors,
      );
    }

    return {
      success: consumptionSummary.errors.length === 0,
      summary: consumptionSummary,
    };
  } catch (error) {
    console.error(
      `[COSTING] Error consuming ingredients for order ${order._id}:`,
      error
    );
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  consumeIngredientsForOrder,
};
