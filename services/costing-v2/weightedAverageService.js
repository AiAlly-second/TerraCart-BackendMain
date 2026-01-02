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
   * @param {String} cartId - Optional outlet ID for cart-specific calculations
   * @returns {Promise<Object>} { newAverageCost, updatedQtyOnHand }
   */
  static async updateWeightedAverage(
    ingredientId,
    newPurchaseQty,
    newPurchaseCostPerBaseUnit,
    cartId = null
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
    // IMPORTANT LOGIC:
    // 1. For cart-specific ingredients: Use ingredient.qtyOnHand directly
    // 2. For shared ingredients:
    //    - If purchase has NO cartId: Use global qtyOnHand (global purchase)
    //    - If purchase HAS cartId: Calculate from outlet-specific transactions (outlet-specific purchase)
    //    This ensures that outlet-specific purchases don't affect global stock
    let existingQty = 0;
    let existingAvgCost = 0;

    if (ingredient.cartId) {
      // Cart-specific ingredient
      if (cartId && ingredient.cartId.toString() === cartId.toString()) {
        // Same outlet - use ingredient values directly
        existingQty = ingredient.qtyOnHand || 0;
        existingAvgCost = ingredient.currentCostPerBaseUnit || 0;
      } else {
        // Different outlet - don't update this ingredient's stock
        // Return existing values without updating
        return {
          newAverageCost: ingredient.currentCostPerBaseUnit || 0,
          updatedQtyOnHand: ingredient.qtyOnHand || 0,
          previousQty: ingredient.qtyOnHand || 0,
          previousAvgCost: ingredient.currentCostPerBaseUnit || 0,
        };
      }
    } else {
      // Shared ingredient
      if (!cartId) {
        // Global purchase (no cartId) - use global qtyOnHand
        existingQty = ingredient.qtyOnHand || 0;
        existingAvgCost = ingredient.currentCostPerBaseUnit || 0;
      } else {
        // Outlet-specific purchase - calculate existing stock from outlet-specific transactions
        // This ensures we don't mix global stock with outlet-specific purchases
        const outletTransactions = await InventoryTransaction.find({
          ingredientId: ingredientId,
          cartId: cartId,
        }).sort({ date: 1 }); // Sort ascending to process chronologically

        let totalQty = 0;
        let weightedAvgCost = 0;

        for (const txn of outletTransactions) {
          const txnQty = txn.qtyInBaseUnit || txn.qty;
          if (txn.type === "IN" || txn.type === "RETURN") {
            // Add to inventory - recalculate weighted average
            const txnCost = txn.costAllocated || 0;
            if (totalQty > 0 && txnQty > 0 && txnCost > 0) {
              // Weighted average: (existing total value + new value) / (existing qty + new qty)
              const existingTotalValue = totalQty * weightedAvgCost;
              weightedAvgCost = (existingTotalValue + txnCost) / (totalQty + txnQty);
            } else if (txnQty > 0 && txnCost > 0) {
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
      }
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

    // Update ingredient stock
    // IMPORTANT LOGIC:
    // 1. For cart-specific ingredients: Only update if cartId matches
    // 2. For shared ingredients:
    //    - If purchase has NO cartId: Update global stock (global purchase)
    //    - If purchase HAS cartId: DON'T update global stock (outlet-specific purchase, stock tracked via transactions)
    //    This ensures that:
    //    - Global stock only reflects global purchases
    //    - Outlet-specific purchases are tracked via transactions only
    //    - Cart admins see stock calculated from their outlet's transactions
    if (ingredient.cartId) {
      // Cart-specific ingredient - only update if cartId matches
      if (cartId && ingredient.cartId.toString() === cartId.toString()) {
        ingredient.qtyOnHand = totalQty;
        ingredient.currentCostPerBaseUnit = newAverageCost;
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Stock Update] Cart-specific ingredient ${ingredient.name}: ${existingQty} → ${totalQty} ${ingredient.baseUnit}`);
        }
      } else {
        // Different cart's ingredient - don't update
        // But we should still save the ingredient in case baseUnit was fixed
        await ingredient.save();
        return {
          newAverageCost,
          updatedQtyOnHand: existingQty, // Return existing qty since we didn't update
          previousQty: existingQty,
          previousAvgCost: existingAvgCost,
        };
      }
    } else {
      // Shared ingredient
      if (!cartId) {
        // Global purchase (no cartId) - update global stock
        ingredient.qtyOnHand = totalQty;
        ingredient.currentCostPerBaseUnit = newAverageCost;
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Stock Update] Shared ingredient ${ingredient.name}: Global purchase - ${existingQty} → ${totalQty} ${ingredient.baseUnit}`);
        }
      } else {
        // Outlet-specific purchase for shared ingredient - DON'T update global stock
        // Stock will be calculated from transactions for each outlet
        // Only update the cost if it's better (higher) than current, but don't update qtyOnHand
        // This ensures global stock reflects only global purchases
        if (newAverageCost > 0 && (!ingredient.currentCostPerBaseUnit || newAverageCost > ingredient.currentCostPerBaseUnit)) {
          ingredient.currentCostPerBaseUnit = newAverageCost;
        }
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Stock Update] Shared ingredient ${ingredient.name}: Outlet-specific purchase (cartId: ${cartId}) - NOT updating global stock. Stock tracked via transactions. Existing: ${existingQty}, New purchase: ${newPurchaseQty}, Total: ${totalQty}`);
        }
        // Save ingredient (for cost update if applicable)
        await ingredient.save();
        // Return the calculated totalQty (existingQty + newPurchaseQty) for this outlet
        // This represents the outlet-specific stock after this purchase
        // NOTE: For shared ingredients with cartId, stock is NOT stored in ingredient.qtyOnHand
        // It's calculated from transactions when viewing inventory
        return {
          newAverageCost,
          updatedQtyOnHand: totalQty, // Outlet-specific stock after purchase (calculated, not stored)
          previousQty: existingQty, // Outlet-specific stock before purchase
          previousAvgCost: existingAvgCost,
        };
      }
    }

    // For cart-specific ingredients or global purchases, update and save ingredient
    await ingredient.save();

    return {
      newAverageCost,
      updatedQtyOnHand: totalQty, // This is the actual updated qtyOnHand in the database
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
   * @param {String} cartId - Optional outlet ID for cart-specific consumption
   * @param {Boolean} allowNegativeStock - Allow consumption even if it exceeds available stock (for waste tracking)
   * @returns {Promise<Object>} { costAllocated, remainingQty }
   */
  static async consume(
    ingredientId,
    qtyToConsume,
    refType,
    refId,
    userId,
    cartId = null,
    allowNegativeStock = false
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

    if (cartId && ingredient.cartId && ingredient.cartId.toString() === cartId.toString()) {
      // Cart-specific ingredient - use values directly
      availableQty = ingredient.qtyOnHand || 0;
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    } else if (cartId) {
      // Shared ingredient - calculate outlet-specific values from transactions
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        cartId: cartId,
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
      // Global/shared ingredient - no cartId specified
      availableQty = ingredient.qtyOnHand || 0;
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    }

    // Validate sufficient stock (unless allowNegativeStock is true for waste tracking)
    if (availableQty < qtyToConsume && !allowNegativeStock) {
      let errorMessage = `Insufficient stock for ${ingredient.name}. Available: ${availableQty} ${ingredient.baseUnit}, Required: ${qtyToConsume} ${ingredient.baseUnit}`;
      
      if (cartId && availableQty === 0) {
        // Check if ingredient has global stock but no outlet-specific stock
        if (ingredient.qtyOnHand > 0 && (!ingredient.cartId || ingredient.cartId.toString() !== cartId.toString())) {
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

    // Update ingredient stock (validate no negative stock unless allowNegativeStock is true)
    const newQty = availableQty - qtyToConsume;
    if (newQty < 0 && !allowNegativeStock) {
      throw new Error(
        `Stock update would result in negative quantity. Available: ${availableQty} ${ingredient.baseUnit}, Consuming: ${qtyToConsume} ${ingredient.baseUnit}`
      );
    }

    // IMPORTANT: Only update ingredient.qtyOnHand for:
    // 1. Cart-specific ingredients (when cartId matches)
    // 2. Shared ingredients with NO cartId (global consumption)
    // For shared ingredients with cartId, stock is tracked via transactions only
    if (cartId && ingredient.cartId && ingredient.cartId.toString() === cartId.toString()) {
      // Cart-specific ingredient - update directly
      ingredient.qtyOnHand = newQty;
    } else if (!ingredient.cartId && !cartId) {
      // Shared ingredient with NO cartId - global consumption, update global stock
      ingredient.qtyOnHand = newQty;
    } else if (!ingredient.cartId && cartId) {
      // Shared ingredient with cartId - outlet-specific consumption
      // DON'T update global stock, stock is tracked via transactions
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Consume] Shared ingredient ${ingredient.name}: Outlet-specific consumption (cartId: ${cartId}) - NOT updating global stock. Stock tracked via transactions.`);
      }
    }
    // For shared ingredients with cartId, stock is tracked via transactions only

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
   * @param {String} cartId - Optional outlet ID
   * @returns {Promise<Object>} { costAllocated, updatedQtyOnHand }
   */
  static async returnToInventory(
    ingredientId,
    qtyToReturn,
    refType,
    refId,
    userId,
    cartId = null
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

    if (cartId && ingredient.cartId && ingredient.cartId.toString() === cartId.toString()) {
      // Cart-specific ingredient
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    } else if (cartId) {
      // Shared ingredient - calculate outlet-specific average from transactions
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        cartId: cartId,
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
    // IMPORTANT: Only update ingredient.qtyOnHand for:
    // 1. Cart-specific ingredients (when cartId matches)
    // 2. Shared ingredients with NO cartId (global return)
    // For shared ingredients with cartId, stock is tracked via transactions only
    if (cartId && ingredient.cartId && ingredient.cartId.toString() === cartId.toString()) {
      // Cart-specific ingredient - update directly
      ingredient.qtyOnHand = (ingredient.qtyOnHand || 0) + qtyToReturn;
    } else if (!ingredient.cartId && !cartId) {
      // Shared ingredient with NO cartId - global return, update global stock
      ingredient.qtyOnHand = (ingredient.qtyOnHand || 0) + qtyToReturn;
    } else if (!ingredient.cartId && cartId) {
      // Shared ingredient with cartId - outlet-specific return
      // DON'T update global stock, stock is tracked via transactions
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Return] Shared ingredient ${ingredient.name}: Outlet-specific return (cartId: ${cartId}) - NOT updating global stock. Stock tracked via transactions.`);
      }
    }

    await ingredient.save();

    // Calculate updated stock for return value
    let updatedQtyOnHand = ingredient.qtyOnHand;
    if (!ingredient.cartId && cartId) {
      // For shared ingredients with cartId, calculate from transactions
      const outletTransactions = await InventoryTransaction.find({
        ingredientId: ingredientId,
        cartId: cartId,
      }).sort({ date: 1 });

      let totalQty = 0;
      for (const txn of outletTransactions) {
        const txnQty = txn.qtyInBaseUnit || txn.qty;
        if (txn.type === "IN" || txn.type === "RETURN") {
          totalQty += txnQty;
        } else if (txn.type === "OUT" || txn.type === "WASTE") {
          totalQty -= txnQty;
          if (totalQty < 0) totalQty = 0;
        }
      }
      updatedQtyOnHand = Math.max(0, totalQty);
    }

    return {
      costAllocated,
      updatedQtyOnHand: updatedQtyOnHand,
      avgCostUsed: avgCost,
    };
  }
}

module.exports = WeightedAverageService;

