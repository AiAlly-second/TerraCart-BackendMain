const Ingredient = require("../../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");

const getSafeConversionFactor = (ingredient, fromUom) => {
  const normalizedFrom = (fromUom || ingredient?.uom || ingredient?.baseUnit || "")
    .toString()
    .trim()
    .toLowerCase();
  const baseUnit = (ingredient?.baseUnit || "")
    .toString()
    .trim()
    .toLowerCase();

  try {
    if (ingredient && typeof ingredient.convertToBaseUnit === "function") {
      const factor = Number(ingredient.convertToBaseUnit(1, normalizedFrom));
      if (Number.isFinite(factor) && factor > 0) {
        return factor;
      }
    }
  } catch (error) {
    // Fallback below handles legacy/unknown unit values.
  }

  if (!normalizedFrom || !baseUnit || normalizedFrom === baseUnit) return 1;
  if (baseUnit === "g") {
    if (normalizedFrom === "kg") return 1000;
    if (normalizedFrom === "g") return 1;
  } else if (baseUnit === "ml") {
    if (normalizedFrom === "l") return 1000;
    if (normalizedFrom === "ml") return 1;
  } else if (baseUnit === "pcs") {
    if (["pcs", "pack", "box", "bottle"].includes(normalizedFrom)) return 1;
    if (normalizedFrom === "dozen") return 12;
  }

  return 1;
};

/**
 * Inventory Costing Service
 * WEIGHTED AVERAGE LOGIC: Calculates weighted average cost when new purchases are received
 * Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (Existing Stock Qty + New Purchase Qty)
 * All calculations are performed at base unit level (g, ml, pcs)
 * When purchase is received: calculate weighted average of existing stock and new purchase
 * Inventory and BOM: use weighted average cost per base unit
 */
class WeightedAverageService {
  /**
   * Calculate weighted average cost when receiving a new purchase
   * Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (existing stock qty + new purchase qty)
   * All quantities and costs must be in base unit
   * 
   * Example: If 1 dozen (12 pieces) is at ₹5 per piece and next intake is 2 dozen (24 pieces) at ₹6 per piece:
   * - Existing: 12 pieces × ₹5 = ₹60
   * - New: 24 pieces × ₹6 = ₹144
   * - Weighted Average = (₹60 + ₹144) / (12 + 24) = ₹204 / 36 = ₹5.67 per piece
   * 
   * @param {String} ingredientId - Ingredient ID
   * @param {Number} newPurchaseQty - New purchase quantity in base unit
   * @param {Number} newPurchaseCostPerBaseUnit - New purchase cost per base unit
   * @param {String} cartId - Optional outlet ID for cart-specific calculations
   * @returns {Promise<Object>} { newAverageCost, updatedQtyOnHand, previousQty, previousAvgCost }
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

    // WEIGHTED AVERAGE LOGIC: Get existing stock quantity and average cost
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
        await ingredient.save();
        return {
          newAverageCost: newPurchaseCostPerBaseUnit, // Use exact purchase price for different outlet
          updatedQtyOnHand: ingredient.qtyOnHand || 0,
          previousQty: ingredient.qtyOnHand || 0,
          previousAvgCost: ingredient.currentCostPerBaseUnit || 0,
        };
      }
    } else {
      // Shared ingredient
      if (!cartId) {
        // Global purchase (no cartId) - use global qtyOnHand and currentCostPerBaseUnit
        existingQty = ingredient.qtyOnHand || 0;
        existingAvgCost = ingredient.currentCostPerBaseUnit || 0;
      } else {
        // Outlet-specific purchase - calculate existing stock and weighted average from transactions
        const outletTransactions = await InventoryTransaction.find({
          ingredientId: ingredientId,
          cartId: cartId,
        }).sort({ date: 1 });

        let totalQty = 0;
        let totalValue = 0; // Total value of inventory in base unit
        
        // Calculate weighted average from all transactions
        for (const txn of outletTransactions) {
          const txnQty = txn.qtyInBaseUnit || txn.qty;
          if (txn.type === "IN" || txn.type === "RETURN") {
            // Add to inventory - calculate weighted average
            // Calculate cost per base unit for this transaction
            let txnCostPerBaseUnit = 0;
            if (txn.unitPrice != null && txn.unitPrice > 0) {
              // Use exact purchase price - convert to base unit
              const conversionFactor = getSafeConversionFactor(
                ingredient,
                txn.uom || ingredient.uom
              );
              txnCostPerBaseUnit = txn.unitPrice / conversionFactor;
            } else if (txn.costAllocated > 0 && txnQty > 0) {
              // Fallback: calculate from costAllocated
              txnCostPerBaseUnit = txn.costAllocated / txnQty;
            }
            
            if (txnQty > 0 && txnCostPerBaseUnit > 0) {
              // Weighted average: (existing total value + new value) / (existing qty + new qty)
              const newValue = txnQty * txnCostPerBaseUnit;
              totalValue = totalValue + newValue; // Add new value to existing total value
              totalQty += txnQty;
              // Calculate average cost from total value and total quantity
              existingAvgCost = totalQty > 0 ? totalValue / totalQty : 0;
            }
          } else if (txn.type === "OUT" || txn.type === "WASTE") {
            // Remove from inventory (cost already allocated, just reduce quantity)
            // Weighted average cost doesn't change on consumption - just reduce quantity
            // But we need to reduce the total value proportionally
            if (totalQty > 0 && existingAvgCost > 0) {
              // Reduce total value by the consumed quantity's value
              const consumedValue = txnQty * existingAvgCost;
              totalValue = Math.max(0, totalValue - consumedValue);
            }
            totalQty -= txnQty;
            if (totalQty < 0) {
              totalQty = 0;
              totalValue = 0;
              existingAvgCost = 0;
            } else if (totalQty > 0) {
              // Recalculate average cost from remaining total value and quantity
              existingAvgCost = totalValue / totalQty;
            } else {
              existingAvgCost = 0;
            }
          }
        }
        
        existingQty = Math.max(0, totalQty);
        // existingAvgCost is already calculated above from transactions
      }
    }

    // Calculate weighted average cost
    // Formula: (Existing Stock Qty × Existing Avg Cost + New Purchase Qty × New Purchase Cost) / (Existing Stock Qty + New Purchase Qty)
    let newAverageCost = 0;
    const totalQty = existingQty + newPurchaseQty;
    
    // Log calculation inputs for debugging
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Weighted Average Calc] ${ingredient.name}: existingQty=${existingQty} ${ingredient.baseUnit}, existingAvgCost=₹${existingAvgCost.toFixed(6)}/${ingredient.baseUnit}, newPurchaseQty=${newPurchaseQty} ${ingredient.baseUnit}, newPurchaseCost=₹${newPurchaseCostPerBaseUnit.toFixed(6)}/${ingredient.baseUnit}`);
    }
    
    if (totalQty > 0) {
      if (existingQty > 0) {
        // We have existing stock - calculate weighted average
        // Even if existingAvgCost is 0, we should still calculate (though this shouldn't happen normally)
        const existingTotalValue = existingQty * (existingAvgCost || 0);
        const newPurchaseValue = newPurchaseQty * newPurchaseCostPerBaseUnit;
        const totalValue = existingTotalValue + newPurchaseValue;
        newAverageCost = totalValue / totalQty;
        
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Weighted Average Calc] ${ingredient.name}: Calculated weighted average - existingTotalValue=₹${existingTotalValue.toFixed(6)}, newPurchaseValue=₹${newPurchaseValue.toFixed(6)}, totalValue=₹${totalValue.toFixed(6)}, totalQty=${totalQty}, newAverageCost=₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
        }
      } else {
        // First purchase (no existing stock) - use new purchase cost as average
        newAverageCost = newPurchaseCostPerBaseUnit;
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Weighted Average Calc] ${ingredient.name}: First purchase - using new purchase cost as average: ₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
        }
      }
    } else {
      // No stock - use new purchase cost
      newAverageCost = newPurchaseCostPerBaseUnit;
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Weighted Average Calc] ${ingredient.name}: No stock - using new purchase cost: ₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
      }
    }

    // Update ingredient stock with weighted average cost
    if (ingredient.cartId) {
      // Cart-specific ingredient - only update if cartId matches
      if (cartId && ingredient.cartId.toString() === cartId.toString()) {
        ingredient.qtyOnHand = totalQty;
        ingredient.currentCostPerBaseUnit = newAverageCost; // Use weighted average cost
        ingredient.lastReceivedAt = new Date();
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Weighted Average] Cart-specific ingredient ${ingredient.name}: ${existingQty} → ${totalQty} ${ingredient.baseUnit}, existing cost=₹${existingAvgCost.toFixed(6)}, new purchase cost=₹${newPurchaseCostPerBaseUnit.toFixed(6)}, weighted avg=₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
        }
      } else {
        await ingredient.save();
        return {
          newAverageCost: newPurchaseCostPerBaseUnit, // Use exact purchase price for different outlet
          updatedQtyOnHand: existingQty,
          previousQty: existingQty,
          previousAvgCost: ingredient.currentCostPerBaseUnit || 0,
        };
      }
    } else {
      // Shared ingredient
      if (!cartId) {
        // Global purchase (no cartId) - update global stock
        ingredient.qtyOnHand = totalQty;
        ingredient.currentCostPerBaseUnit = newAverageCost; // Use weighted average cost
        ingredient.lastReceivedAt = new Date();
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Weighted Average] Shared ingredient ${ingredient.name}: Global purchase - ${existingQty} → ${totalQty} ${ingredient.baseUnit}, existing cost=₹${existingAvgCost.toFixed(6)}, new purchase cost=₹${newPurchaseCostPerBaseUnit.toFixed(6)}, weighted avg=₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
        }
      } else {
        // Outlet-specific purchase for shared ingredient - DON'T update global stock
        // Stock tracked via transactions, but update cost to weighted average
        // Note: For shared ingredients with cartId, we store the weighted average in the ingredient
        // but stock is calculated from transactions
        ingredient.currentCostPerBaseUnit = newAverageCost; // Use weighted average cost
        ingredient.lastReceivedAt = new Date();
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Weighted Average] Shared ingredient ${ingredient.name}: Outlet-specific purchase (cartId: ${cartId}) - NOT updating global stock. Stock tracked via transactions. Existing: ${existingQty}, New purchase: ${newPurchaseQty}, Total: ${totalQty}, existing cost=₹${existingAvgCost.toFixed(6)}, new purchase cost=₹${newPurchaseCostPerBaseUnit.toFixed(6)}, weighted avg=₹${newAverageCost.toFixed(6)}/${ingredient.baseUnit}`);
        }
        await ingredient.save();
        return {
          newAverageCost: newAverageCost,
          updatedQtyOnHand: totalQty, // Outlet-specific stock after purchase
          previousQty: existingQty,
          previousAvgCost: existingAvgCost,
        };
      }
    }

    // Save ingredient
    await ingredient.save();

    return {
      newAverageCost: newAverageCost, // Return weighted average cost
      updatedQtyOnHand: totalQty,
      previousQty: existingQty,
      previousAvgCost: existingAvgCost,
    };
  }

  /**
   * SIMPLE: Consume ingredient using last purchase price (exact price, no averaging)
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

      // SIMPLE: Calculate stock from transactions (no weighted average)
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

      availableQty = Math.max(0, totalQty);
      
      // SIMPLE: Use last purchase price (exact price, no averaging)
      // Find the most recent purchase transaction to get exact purchase price
      const lastPurchaseTxn = await InventoryTransaction.findOne({
        ingredientId: ingredientId,
        cartId: cartId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 }); // Most recent purchase
      
      if (lastPurchaseTxn && lastPurchaseTxn.unitPrice != null && lastPurchaseTxn.unitPrice > 0) {
        // Use exact purchase price - convert to base unit
        const conversionFactor = getSafeConversionFactor(
          ingredient,
          lastPurchaseTxn.uom || ingredient.uom
        );
        avgCost = lastPurchaseTxn.unitPrice / conversionFactor;
      } else {
        // Fallback to ingredient's stored cost
        avgCost = ingredient.currentCostPerBaseUnit || 0;
      }
      
      // If no outlet-specific transactions found, fall back to global stock for shared ingredients
      // This allows cart admins to use shared ingredients that haven't been purchased outlet-specifically yet
      if (availableQty === 0 && outletTransactions.length === 0 && ingredient.qtyOnHand > 0) {
        // No outlet-specific stock, but global stock exists - allow consumption from global stock
        availableQty = ingredient.qtyOnHand || 0;
        avgCost = ingredient.currentCostPerBaseUnit || 0;
      }
      // When no purchase history exists, avgCost uses ingredient.currentCostPerBaseUnit (set via Purchases or manual) for food cost.
    } else {
      // Global/shared ingredient - no cartId specified
      availableQty = ingredient.qtyOnHand || 0;
      avgCost = ingredient.currentCostPerBaseUnit || 0;
    }

    // Validate sufficient stock (unless allowNegativeStock is true for waste tracking)
    // Relaxed check: Allow consumption for shared ingredients even if local stock is 0
    // Validate sufficient stock (unless allowNegativeStock is true for waste tracking)
    // Relaxed check: Allow consumption for shared ingredients even if local stock is 0
    if (availableQty < qtyToConsume && !allowNegativeStock) {
       console.warn(`[WeightedAverage] Insufficient stock for ${ingredient.name}. Available: ${availableQty}, Required: ${qtyToConsume}.`);
       let errorMessage = `Insufficient stock for ${ingredient.name}. Available: ${availableQty} ${ingredient.baseUnit}, Required: ${qtyToConsume} ${ingredient.baseUnit}`;
       
       if (availableQty === 0) {
         errorMessage += `. Please make a purchase for this ingredient first.`;
       }
       
       throw new Error(errorMessage);
    }

    // SIMPLE: Calculate cost allocated using last purchase price (exact price, no averaging)
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
   * SIMPLE: Returns are valued at last purchase price (exact price, no averaging)
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
      ingredient.lastReceivedAt = new Date();
    } else if (!ingredient.cartId && !cartId) {
      // Shared ingredient with NO cartId - global return, update global stock
      ingredient.qtyOnHand = (ingredient.qtyOnHand || 0) + qtyToReturn;
      ingredient.lastReceivedAt = new Date();
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
