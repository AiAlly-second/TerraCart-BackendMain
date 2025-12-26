const Ingredient = require("../../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");

/**
 * Weighted Average Costing Service
 * Handles weighted average inventory valuation and cost calculations
 * All calculations are performed at base unit level (g, ml, pcs)
 */
class WeightedAverageService {
  /**
   * Calculate weighted average cost when receiving a new purchase
   * Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (existing stock qty + new purchase qty)
   * All quantities and costs must be in base unit
   * 
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} newPurchaseQty - New purchase quantity in base unit
   * @param {Number} newPurchaseCostPerBaseUnit - New purchase cost per base unit
   * @param {String} outletId - Optional outlet ID for cart-specific calculations
   * @returns {Promise<Object>} { newAverageCost, updatedQtyOnHand }
   */
  static async updateWeightedAverage(
    ingredientId,
    newPurchaseQty,
    newPurchaseCostPerBaseUnit,
    outletId = null
  ) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    // Fix baseUnit if it's invalid (should be g, ml, or pcs)
    if (!['g', 'ml', 'pcs'].includes(ingredient.baseUnit)) {
      if (['kg', 'g'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'g';
      } else if (['l', 'ml'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'ml';
      } else {
        ingredient.baseUnit = 'pcs';
      }
    }

    // Validate inputs
    if (newPurchaseQty <= 0) {
      throw new Error("Purchase quantity must be greater than 0");
    }
    if (newPurchaseCostPerBaseUnit < 0) {
      throw new Error("Purchase cost cannot be negative");
    }

    // Get existing stock quantity and average cost
    // For cart-specific ingredients, use outlet-specific values
    let existingQty = 0;
    let existingAvgCost = 0;

    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient - use values directly
      existingQty = ingredient.qtyOnHand || 0;
      existingAvgCost = ingredient.currentCostPerBaseUnit || 0;
    } else if (outletId) {
      // Shared ingredient - calculate outlet-specific values from transactions
      // Need to recalculate weighted average by processing transactions chronologically
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        outletId: outletId,
      }).sort({ date: 1 }); // Sort ascending to process chronologically

      // Calculate outlet-specific quantity and weighted average from transactions
      let totalQty = 0;
      let weightedAvgCost = 0;

      for (const txn of outletTransactions) {
        const txnQty = txn.qtyInBaseUnit || txn.qty;
        if (txn.type === "IN" || txn.type === "RETURN") {
          // Add to inventory - recalculate weighted average
          const txnCost = txn.costAllocated || 0;
          if (totalQty > 0 && txnQty > 0) {
            // Weighted average: (existing total value + new value) / (existing qty + new qty)
            const existingTotalValue = totalQty * weightedAvgCost;
            weightedAvgCost = (existingTotalValue + txnCost) / (totalQty + txnQty);
          } else if (txnQty > 0) {
            // First purchase
            weightedAvgCost = txnCost / txnQty;
          }
          totalQty += txnQty;
        } else if (txn.type === "OUT" || txn.type === "WASTE") {
          // Remove from inventory (cost already allocated, just reduce quantity)
          totalQty -= txnQty;
          if (totalQty < 0) totalQty = 0;
          // Weighted average cost doesn't change on consumption
        }
      }

      existingQty = Math.max(0, totalQty);
      existingAvgCost = weightedAvgCost > 0 ? weightedAvgCost : ingredient.currentCostPerBaseUnit || 0;
    } else {
      // Global/shared ingredient - use ingredient values directly
      existingQty = ingredient.qtyOnHand || 0;
      existingAvgCost = ingredient.currentCostPerBaseUnit || 0;
    }

    // Calculate new weighted average cost
    // Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (existing stock qty + new purchase qty)
    const totalExistingCost = existingQty * existingAvgCost;
    const totalNewCost = newPurchaseQty * newPurchaseCostPerBaseUnit;
    const totalQty = existingQty + newPurchaseQty;
    
    let newAverageCost = 0;
    if (totalQty > 0) {
      newAverageCost = (totalExistingCost + totalNewCost) / totalQty;
    } else {
      // No existing stock, use new purchase cost
      newAverageCost = newPurchaseCostPerBaseUnit;
    }

    // Update ingredient
    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient - update directly
      ingredient.qtyOnHand = totalQty;
      ingredient.currentCostPerBaseUnit = newAverageCost;
    } else if (!outletId || !ingredient.outletId) {
      // Global/shared ingredient - update directly
      ingredient.qtyOnHand = totalQty;
      ingredient.currentCostPerBaseUnit = newAverageCost;
    }
    // For shared ingredients with outletId, we don't update the global values
    // The outlet-specific values are calculated from transactions

    await ingredient.save();

    return {
      newAverageCost,
      updatedQtyOnHand: totalQty,
      previousQty: existingQty,
      previousAvgCost: existingAvgCost,
    };
  }

  /**
   * Consume ingredient using weighted average cost
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} qtyToConsume - Quantity to consume in base unit
   * @param {String} refType - Reference type (recipe, waste, order, etc.)
   * @param {String} refId - Reference ID
   * @param {String} userId - User recording the transaction
   * @param {String} outletId - Optional outlet ID for cart-specific consumption
   * @returns {Promise<Object>} { costAllocated, remainingQty }
   */
  static async consume(
    ingredientId,
    qtyToConsume,
    refType,
    refId,
    userId,
    outletId = null
  ) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    // Fix baseUnit if it's invalid (should be g, ml, or pcs)
    if (!['g', 'ml', 'pcs'].includes(ingredient.baseUnit)) {
      if (['kg', 'g'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'g';
      } else if (['l', 'ml'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'ml';
      } else {
        ingredient.baseUnit = 'pcs';
      }
    }

    if (qtyToConsume <= 0) {
      throw new Error("Quantity to consume must be greater than 0");
    }

    // Get current stock and average cost
    let availableQty = 0;
    let avgCost = 0;

    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient - use values directly
      availableQty = ingredient.qtyOnHand || 0;
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    } else if (outletId) {
      // Shared ingredient - calculate outlet-specific values from transactions
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        outletId: outletId,
      }).sort({ date: 1 }); // Sort ascending to process chronologically

      let totalQty = 0;
      let weightedAvgCost = 0;

      for (const txn of outletTransactions) {
        const txnQty = txn.qtyInBaseUnit || txn.qty;
        if (txn.type === "IN" || txn.type === "RETURN") {
          // Add to inventory - recalculate weighted average
          const txnCost = txn.costAllocated || 0;
          if (totalQty > 0 && txnQty > 0) {
            // Weighted average: (existing total value + new value) / (existing qty + new qty)
            const existingTotalValue = totalQty * weightedAvgCost;
            weightedAvgCost = (existingTotalValue + txnCost) / (totalQty + txnQty);
          } else if (txnQty > 0) {
            // First purchase
            weightedAvgCost = txnCost / txnQty;
          }
          totalQty += txnQty;
        } else if (txn.type === "OUT" || txn.type === "WASTE") {
          // Remove from inventory (cost already allocated, just reduce quantity)
          totalQty -= txnQty;
          if (totalQty < 0) totalQty = 0;
          // Weighted average cost doesn't change on consumption
        }
      }

      availableQty = Math.max(0, totalQty);
      avgCost = weightedAvgCost > 0 ? weightedAvgCost : ingredient.currentCostPerBaseUnit || 0;
      
      // If no outlet-specific transactions found, fall back to global stock for shared ingredients
      // This allows cart admins to use shared ingredients that haven't been purchased outlet-specifically yet
      if (availableQty === 0 && outletTransactions.length === 0 && ingredient.qtyOnHand > 0) {
        // No outlet-specific stock, but global stock exists - allow consumption from global stock
        availableQty = ingredient.qtyOnHand || 0;
        avgCost = ingredient.currentCostPerBaseUnit || 0;
      }
    } else {
      // Global/shared ingredient - no outletId specified
      availableQty = ingredient.qtyOnHand || 0;
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    }

    // Validate sufficient stock
    if (availableQty < qtyToConsume) {
      let errorMessage = `Insufficient stock for ${ingredient.name}. Available: ${availableQty} ${ingredient.baseUnit}, Required: ${qtyToConsume} ${ingredient.baseUnit}`;
      
      if (outletId && availableQty === 0) {
        // Check if ingredient has global stock but no outlet-specific stock
        if (ingredient.qtyOnHand > 0 && (!ingredient.outletId || ingredient.outletId.toString() !== outletId.toString())) {
          errorMessage += `. Note: This is a shared ingredient. You need to make a purchase for your outlet first, or the ingredient may need to be assigned to your outlet.`;
        } else {
          errorMessage += `. Please make a purchase for this ingredient first.`;
        }
      } else if (availableQty === 0) {
        errorMessage += `. Please make a purchase for this ingredient first.`;
      }
      
      throw new Error(errorMessage);
    }

    // Calculate cost allocated using weighted average
    const costAllocated = qtyToConsume * avgCost;

    // Update ingredient stock (validate no negative stock)
    const newQty = availableQty - qtyToConsume;
    if (newQty < 0) {
      throw new Error(
        `Stock update would result in negative quantity. Available: ${availableQty} ${ingredient.baseUnit}, Consuming: ${qtyToConsume} ${ingredient.baseUnit}`
      );
    }

    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient - update directly
      ingredient.qtyOnHand = newQty;
    } else if (!outletId || !ingredient.outletId) {
      // Global/shared ingredient - update directly
      ingredient.qtyOnHand = newQty;
    }
    // For shared ingredients with outletId, stock is tracked via transactions

    await ingredient.save();

    return {
      costAllocated,
      remainingQty: availableQty - qtyToConsume,
      avgCostUsed: avgCost,
    };
  }

  /**
   * Return unused ingredient to inventory
   * Returns are valued at current weighted average cost without recalculating the average
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} qtyToReturn - Quantity to return in base unit
   * @param {String} refType - Reference type (recipe, order, etc.)
   * @param {String} refId - Reference ID (transaction ID being returned)
   * @param {String} userId - User recording the return
   * @param {String} outletId - Optional outlet ID
   * @returns {Promise<Object>} { costAllocated, updatedQtyOnHand }
   */
  static async returnToInventory(
    ingredientId,
    qtyToReturn,
    refType,
    refId,
    userId,
    outletId = null
  ) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    // Fix baseUnit if it's invalid (should be g, ml, or pcs)
    if (!['g', 'ml', 'pcs'].includes(ingredient.baseUnit)) {
      if (['kg', 'g'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'g';
      } else if (['l', 'ml'].includes(ingredient.uom)) {
        ingredient.baseUnit = 'ml';
      } else {
        ingredient.baseUnit = 'pcs';
      }
    }

    if (qtyToReturn <= 0) {
      throw new Error("Quantity to return must be greater than 0");
    }

    // Get current weighted average cost (don't recalculate)
    let avgCost = 0;

    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    } else if (outletId) {
      // Shared ingredient - calculate outlet-specific average from transactions
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        outletId: outletId,
      }).sort({ date: 1 }); // Sort ascending to process chronologically

      let totalQty = 0;
      let weightedAvgCost = 0;

      for (const txn of outletTransactions) {
        const txnQty = txn.qtyInBaseUnit || txn.qty;
        if (txn.type === "IN" || txn.type === "RETURN") {
          // Add to inventory - recalculate weighted average
          const txnCost = txn.costAllocated || 0;
          if (totalQty > 0 && txnQty > 0) {
            // Weighted average: (existing total value + new value) / (existing qty + new qty)
            const existingTotalValue = totalQty * weightedAvgCost;
            weightedAvgCost = (existingTotalValue + txnCost) / (totalQty + txnQty);
          } else if (txnQty > 0) {
            // First purchase
            weightedAvgCost = txnCost / txnQty;
          }
          totalQty += txnQty;
        } else if (txn.type === "OUT" || txn.type === "WASTE") {
          // Remove from inventory (cost already allocated, just reduce quantity)
          totalQty -= txnQty;
          if (totalQty < 0) totalQty = 0;
          // Weighted average cost doesn't change on consumption
        }
      }

      const availableQty = Math.max(0, totalQty);
      avgCost = weightedAvgCost > 0 ? weightedAvgCost : ingredient.currentCostPerBaseUnit || 0;
    } else {
      // Global/shared ingredient
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    }

    // If no cost available, use 0 cost for return (stock will be added but valued at 0)
    // This allows returning ingredients even if no purchases have been made yet
    if (avgCost <= 0) {
      avgCost = 0;
      console.warn(`[WeightedAverage] No cost available for ingredient ${ingredient.name}, returning with 0 cost`);
    }

    // Calculate cost at current average (don't recalculate average)
    const costAllocated = qtyToReturn * avgCost;

    // Update ingredient stock
    // Always update qtyOnHand for the ingredient, regardless of outletId
    // For shared ingredients, this represents the total available stock across all outlets
    // For outlet-specific ingredients, this represents the outlet's stock
    ingredient.qtyOnHand = (ingredient.qtyOnHand || 0) + qtyToReturn;

    await ingredient.save();

    return {
      costAllocated,
      updatedQtyOnHand: ingredient.qtyOnHand,
      avgCostUsed: avgCost,
    };
  }
}

module.exports = WeightedAverageService;

