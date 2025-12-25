/**
 * Order Consumption Service
 * Automatically consumes ingredients from inventory when orders are ready/paid/completed
 * Handles both DINE_IN and TAKEAWAY orders, including items converted from dine-in to takeaway
 */

const MenuItemV2 = require("../../models/costing-v2/menuItemModel");
const RecipeV2 = require("../../models/costing-v2/recipeModel");
const IngredientV2 = require("../../models/costing-v2/ingredientModel");
const FIFOService = require("./fifoService");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");

/**
 * Consume ingredients for an order when it's marked as Ready, Paid, Finalized, or Completed
 * Processes all items in the order (dine-in, takeaway, and converted-to-takeaway items)
 * @param {Object} order - Order document (can be DINE_IN or TAKEAWAY)
 * @param {String} userId - User ID who triggered the consumption
 * @returns {Promise<Object>} Consumption summary
 */
async function consumeIngredientsForOrder(order, userId) {
  try {
    // Check if order already has consumption recorded
    const existingConsumption = await InventoryTransaction.findOne({
      refType: "order",
      refId: order._id,
    });

    if (existingConsumption) {
      console.log(
        `[COSTING] Order ${order._id} already has ingredients consumed`
      );
      return {
        success: true,
        alreadyProcessed: true,
        message: "Order already processed",
      };
    }

    // Get cart ID from order - handle both ObjectId and string formats
    let cartId = order.cartId || order.cafeId;
    if (cartId && typeof cartId === "object" && cartId._id) {
      cartId = cartId._id;
    }
    if (cartId && typeof cartId === "object" && cartId.toString) {
      cartId = cartId.toString();
    }

    if (!cartId) {
      console.warn(
        `[COSTING] Order ${order._id} has no cartId/cafeId, skipping consumption`
      );
      console.warn(`[COSTING] Order data:`, {
        cartId: order.cartId,
        cafeId: order.cafeId,
        franchiseId: order.franchiseId,
      });
      return {
        success: false,
        message: "Order has no cart association",
      };
    }

    console.log(`[COSTING] Processing order ${order._id} for cart ${cartId}`);

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

    for (const kotLine of order.kotLines) {
      if (!kotLine.items || kotLine.items.length === 0) continue;

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

          // Find menu item by name - try multiple strategies
          // Use cartId to match against outletId in menu items (cartId = outletId for cart admin)
          let menuItem = await MenuItemV2.findOne({
            $or: [
              { name: normalizedItemName, outletId: cartId, isActive: true },
              {
                name: {
                  $regex: new RegExp(
                    `^${normalizedItemName.replace(
                      /[.*+?^${}()|[\]\\]/g,
                      "\\$&"
                    )}$`,
                    "i"
                  ),
                },
                outletId: cartId,
                isActive: true,
              },
            ],
          });

          // If not found, try without outletId filter (for shared menu items)
          if (!menuItem) {
            menuItem = await MenuItemV2.findOne({
              $or: [
                { name: normalizedItemName, isActive: true },
                {
                  name: {
                    $regex: new RegExp(
                      `^${normalizedItemName.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&"
                      )}$`,
                      "i"
                    ),
                  },
                  isActive: true,
                },
                { defaultMenuItemName: normalizedItemName, isActive: true },
                {
                  defaultMenuItemName: {
                    $regex: new RegExp(
                      `^${normalizedItemName.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&"
                      )}$`,
                      "i"
                    ),
                  },
                  isActive: true,
                },
              ],
            });
          }

          if (!menuItem) {
            console.warn(
              `[COSTING] Menu item not found in costing: "${itemName}" for cart ${cartId}`
            );
            console.warn(`[COSTING] Searched for: "${normalizedItemName}"`);
            console.warn(
              `[COSTING] Available menu items in costing:`,
              await MenuItemV2.find({ outletId: cartId, isActive: true })
                .select("name")
                .limit(10)
                .lean()
                .then((items) => items.map((i) => i.name))
            );
            consumptionSummary.errors.push({
              item: itemName,
              error:
                "Menu item not found in costing system. Please add this item to costing menu items.",
            });
            continue;
          }

          // Skip if menu item has no recipe
          if (!menuItem.recipeId) {
            console.warn(
              `[COSTING] Menu item "${itemName}" has no recipe linked. Skipping consumption.`
            );
            consumptionSummary.errors.push({
              item: itemName,
              error:
                "Menu item has no recipe linked. Please link a recipe to this menu item.",
            });
            continue;
          }

          console.log(
            `[COSTING] Found menu item: ${menuItem.name} (ID: ${menuItem._id}) for order item: ${itemName}`
          );

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

              // Check if sufficient stock available
              if (ingredient.qtyOnHand < qtyInBaseUnit) {
                const errorMsg = `Insufficient stock for ${ingredient.name}. Available: ${ingredient.qtyOnHand} ${ingredient.baseUnit}, Required: ${qtyInBaseUnit} ${ingredient.baseUnit}`;
                console.error(`[COSTING] ${errorMsg}`);
                consumptionSummary.errors.push({
                  item: itemName,
                  ingredient: ingredient.name,
                  error: errorMsg,
                });
                continue;
              }

              // Consume using FIFO - pass cartId (which matches outletId in purchases/ingredients)
              const consumeResult = await FIFOService.consume(
                recipeIngredient.ingredientId,
                qtyInBaseUnit,
                "order",
                order._id,
                userId,
                cartId // cartId from order matches outletId in database
              );

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

    console.log(`[COSTING] Order ${order._id} consumption complete:`, {
      itemsProcessed: consumptionSummary.itemsProcessed,
      ingredientsConsumed: consumptionSummary.ingredientsConsumed.length,
      totalCost: consumptionSummary.totalCost,
      errors: consumptionSummary.errors.length,
    });

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
