const Ingredient = require("../../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");
const Purchase = require("../../models/costing-v2/purchaseModel");

/**
 * FIFO Service
 * Handles First-In-First-Out inventory valuation and consumption
 */
class FIFOService {
  /**
   * Add a new FIFO layer when receiving a purchase
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} qty - Quantity in base unit
   * @param {Number} unitCost - Cost per base unit
   * @param {String} purchaseId - Purchase document ID
   * @returns {Promise<Object>} Updated ingredient
   */
  static async addLayer(ingredientId, qty, unitCost, purchaseId) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    // Add new FIFO layer
    ingredient.fifoLayers.push({
      qty,
      uom: ingredient.baseUnit,
      unitCost,
      remainingQty: qty,
      purchaseId,
      date: new Date(),
    });

    // Update qty on hand
    ingredient.qtyOnHand += qty;

    // Update current cost (use latest purchase price)
    ingredient.currentCostPerBaseUnit = unitCost;

    await ingredient.save();
    return ingredient;
  }

  /**
   * Consume ingredient using FIFO
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} qtyToConsume - Quantity to consume in base unit
   * @param {String} refType - Reference type (recipe, waste, etc.)
   * @param {String} refId - Reference ID
   * @param {String} userId - User recording the transaction
   * @param {String} cartId - Optional cart ID (matches cartId in database)
   * @returns {Promise<Object>} { costAllocated, remainingQty }
   */
  static async consume(
    ingredientId,
    qtyToConsume,
    refType,
    refId,
    userId,
    cartId = null
  ) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    // For cart-specific consumption, check available quantity from cart's layers only
    // cartId matches cartId in database (cart admin user ID = cartId)
    if (cartId) {
      // If ingredient is cart-specific and belongs to this cart, use qtyOnHand directly
      if (
        ingredient.cartId &&
        ingredient.cartId.toString() === cartId.toString()
      ) {
        if (ingredient.qtyOnHand < qtyToConsume) {
          throw new Error(
            `Insufficient stock. Available: ${ingredient.qtyOnHand}, Required: ${qtyToConsume}`
          );
        }
      } else {
        // For shared ingredients, calculate available quantity from this cart's FIFO layers
        // Check purchases that belong to this cart (cartId = cartId in purchase)
        let availableQty = 0;
        if (ingredient.fifoLayers && Array.isArray(ingredient.fifoLayers)) {
          for (const layer of ingredient.fifoLayers) {
            if (layer.remainingQty > 0 && layer.purchaseId) {
              // Check if this purchase belongs to the cart (cartId in purchase = cartId)
              const purchase = await Purchase.findById(layer.purchaseId);
              if (
                purchase &&
                purchase.cartId &&
                purchase.cartId.toString() === cartId.toString()
              ) {
                availableQty += layer.remainingQty;
              }
            }
          }
        }

        // If no cart-specific stock found, fall back to global stock for shared ingredients
        // This allows cart admins to use shared ingredients that haven't been purchased cart-specifically yet
        if (availableQty === 0 && ingredient.qtyOnHand > 0) {
          // No cart-specific stock, but global stock exists - allow consumption from global stock
          availableQty = ingredient.qtyOnHand || 0;
          console.log(
            `[FIFO] No cart-specific stock for ${ingredient.name}, falling back to global stock: ${availableQty}`
          );
        }

        if (availableQty < qtyToConsume) {
          let errorMessage = `Insufficient stock for this cart. Available: ${availableQty}, Required: ${qtyToConsume}`;
          if (availableQty === 0 && ingredient.qtyOnHand === 0) {
            errorMessage += `. Please make a purchase for ${ingredient.name} first.`;
          } else if (availableQty === 0 && ingredient.qtyOnHand > 0) {
            errorMessage += `. Note: This is a shared ingredient. You may need to make a purchase for your cart first, or the ingredient may need to be assigned to your cart.`;
          }
          throw new Error(errorMessage);
        }
      }
    } else {
      // Global consumption - use total qtyOnHand
      if (ingredient.qtyOnHand < qtyToConsume) {
        throw new Error(
          `Insufficient stock. Available: ${ingredient.qtyOnHand}, Required: ${qtyToConsume}`
        );
      }
    }

    let remainingToConsume = qtyToConsume;
    let totalCostAllocated = 0;
    let cartSpecificQtyConsumed = 0;

    console.log(
      `[FIFO] Consuming ${qtyToConsume} ${ingredient.baseUnit} of ${
        ingredient.name
      }${cartId ? ` for cart ${cartId}` : " (global)"}`
    );

    // First pass: Try to consume from cart-specific layers first (if cartId provided)
    // If cartId is provided, prioritize cart-specific layers first, then fall back to global layers
    // cartId matches cartId in purchases/ingredients
    for (
      let i = 0;
      i < ingredient.fifoLayers.length && remainingToConsume > 0;
      i++
    ) {
      const layer = ingredient.fifoLayers[i];

      if (layer.remainingQty <= 0) continue; // Skip empty layers

      // If cartId is specified, prioritize cart-specific layers first
      let shouldConsumeFromLayer = false;
      if (cartId) {
        if (
          ingredient.cartId &&
          ingredient.cartId.toString() === cartId.toString()
        ) {
          // Cart-specific ingredient - all layers belong to this cart
          shouldConsumeFromLayer = true;
        } else if (layer.purchaseId) {
          // Shared ingredient - check if purchase belongs to this cart (cartId = cartId)
          const purchase = await Purchase.findById(layer.purchaseId);
          if (
            purchase &&
            purchase.cartId &&
            purchase.cartId.toString() === cartId.toString()
          ) {
            shouldConsumeFromLayer = true;
          }
        }
      } else {
        // No cartId - consume from any layer (global consumption)
        shouldConsumeFromLayer = true;
      }

      if (!shouldConsumeFromLayer) {
        continue; // Skip layers that don't belong to this cart (for now)
      }

      const consumeFromLayer = Math.min(remainingToConsume, layer.remainingQty);
      const costFromLayer = consumeFromLayer * layer.unitCost;

      layer.remainingQty -= consumeFromLayer;
      remainingToConsume -= consumeFromLayer;
      totalCostAllocated += costFromLayer;
      cartSpecificQtyConsumed += consumeFromLayer;
    }

    // Second pass: If still remaining and we have global stock, consume from any available layers
    // This handles the case where cart-specific stock is insufficient but global stock exists
    if (remainingToConsume > 0 && cartId) {
      // Calculate actual remaining quantity in all layers after first pass
      let totalRemainingInLayers = 0;
      for (const layer of ingredient.fifoLayers) {
        if (layer.remainingQty > 0) {
          totalRemainingInLayers += layer.remainingQty;
        }
      }

      // Check if we have enough stock (either in layers or in qtyOnHand)
      // qtyOnHand is the source of truth, but we need to consume from layers
      // If layers are out of sync with qtyOnHand, we should still allow consumption
      const hasEnoughStock = ingredient.qtyOnHand >= remainingToConsume;
      
      if (hasEnoughStock && totalRemainingInLayers > 0) {
        console.log(
          `[FIFO] Cart-specific stock insufficient (consumed ${cartSpecificQtyConsumed}), consuming remaining ${remainingToConsume} from global stock for ${ingredient.name}. Available in layers: ${totalRemainingInLayers}, qtyOnHand: ${ingredient.qtyOnHand}`
        );
        // Consume from any available layers (global fallback)
        // Go through all layers again, consuming from any that have remaining quantity
        for (
          let i = 0;
          i < ingredient.fifoLayers.length && remainingToConsume > 0;
          i++
        ) {
          const layer = ingredient.fifoLayers[i];
          if (layer.remainingQty <= 0) continue;

          const consumeFromLayer = Math.min(remainingToConsume, layer.remainingQty);
          const costFromLayer = consumeFromLayer * layer.unitCost;

          layer.remainingQty -= consumeFromLayer;
          remainingToConsume -= consumeFromLayer;
          totalCostAllocated += costFromLayer;
        }
      } else if (hasEnoughStock) {
        // qtyOnHand shows stock but layers might be empty or insufficient
        // This handles edge cases where layers might be out of sync with qtyOnHand
        // Allow consumption using current cost
        console.log(
          `[FIFO] Warning: qtyOnHand (${ingredient.qtyOnHand}) shows sufficient stock but layers have ${totalRemainingInLayers}. Allowing consumption with current cost.`
        );
        // Use current cost per base unit for the remaining quantity
        const costForRemaining = remainingToConsume * (ingredient.currentCostPerBaseUnit || 0);
        totalCostAllocated += costForRemaining;
        remainingToConsume = 0; // Mark as consumed
      } else {
        console.log(
          `[FIFO] Insufficient global stock. Cart-specific consumed: ${cartSpecificQtyConsumed}, Remaining needed: ${remainingToConsume}, Available in layers: ${totalRemainingInLayers}, qtyOnHand: ${ingredient.qtyOnHand}`
        );
      }
    }

    if (remainingToConsume > 0) {
      // Calculate actual remaining quantity in all layers for better error message
      let totalRemainingInLayers = 0;
      for (const layer of ingredient.fifoLayers) {
        if (layer.remainingQty > 0) {
          totalRemainingInLayers += layer.remainingQty;
        }
      }

      let errorMessage = `FIFO consumption error: Could not consume full quantity. Remaining: ${remainingToConsume} ${ingredient.baseUnit}`;
      
      if (cartId) {
        errorMessage += `. Cart-specific stock consumed: ${cartSpecificQtyConsumed} ${ingredient.baseUnit}`;
        if (totalRemainingInLayers > 0) {
          errorMessage += `. Available in global stock: ${totalRemainingInLayers} ${ingredient.baseUnit}`;
        } else {
          errorMessage += `. No additional stock available in layers. Total qtyOnHand: ${ingredient.qtyOnHand} ${ingredient.baseUnit}`;
        }
        errorMessage += `. Please ensure sufficient stock is available for this cart.`;
      } else {
        errorMessage += `. Available in layers: ${totalRemainingInLayers} ${ingredient.baseUnit}, Total qtyOnHand: ${ingredient.qtyOnHand} ${ingredient.baseUnit}`;
      }

      throw new Error(errorMessage);
    }

    // Update qty on hand
    ingredient.qtyOnHand -= qtyToConsume;

    // Clean up empty layers (optional - can keep for audit)
    // ingredient.fifoLayers = ingredient.fifoLayers.filter(l => l.remainingQty > 0);

    await ingredient.save();

    // Create inventory transaction record
    // Store cartId as cartId in transaction (cartId = cartId in database)
    // qtyToConsume is already in base unit, so qtyInBaseUnit = qtyToConsume
    const transaction = new InventoryTransaction({
      ingredientId,
      type: "OUT",
      qty: qtyToConsume,
      uom: ingredient.baseUnit,
      qtyInBaseUnit: qtyToConsume, // Required field - qtyToConsume is already in base unit
      refType,
      refId,
      date: new Date(),
      costAllocated: totalCostAllocated,
      recordedBy: userId,
      cartId: cartId, // cartId stored as cartId in database
    });

    await transaction.save();

    return {
      costAllocated: totalCostAllocated,
      remainingQty: ingredient.qtyOnHand,
      transactionId: transaction._id,
    };
  }

  /**
   * Get current FIFO layers for an ingredient
   * @param {String} ingredientId - Ingredient ID
   * @returns {Promise<Array>} FIFO layers
   */
  static async getLayers(ingredientId) {
    const ingredient = await Ingredient.findById(ingredientId).select(
      "fifoLayers"
    );
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }
    return ingredient.fifoLayers.filter((l) => l.remainingQty > 0);
  }

  /**
   * Calculate average cost from FIFO layers
   * @param {String} ingredientId - Ingredient ID
   * @returns {Promise<Number>} Average cost per base unit
   */
  static async getAverageCost(ingredientId) {
    const ingredient = await Ingredient.findById(ingredientId).select(
      "fifoLayers"
    );
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    const activeLayers = ingredient.fifoLayers.filter(
      (l) => l.remainingQty > 0
    );
    if (activeLayers.length === 0) {
      return ingredient.currentCostPerBaseUnit || 0;
    }

    let totalQty = 0;
    let totalValue = 0;

    for (const layer of activeLayers) {
      totalQty += layer.remainingQty;
      totalValue += layer.remainingQty * layer.unitCost;
    }

    return totalQty > 0 ? totalValue / totalQty : 0;
  }
}

module.exports = FIFOService;
