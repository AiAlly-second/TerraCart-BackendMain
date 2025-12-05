const Ingredient = require("../../models/costing-v2/ingredientModel");
const InventoryTransaction = require("../../models/costing-v2/inventoryTransactionModel");

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
   * @param {String} outletId - Optional outlet ID
   * @returns {Promise<Object>} { costAllocated, remainingQty }
   */
  static async consume(ingredientId, qtyToConsume, refType, refId, userId, outletId = null) {
    const ingredient = await Ingredient.findById(ingredientId);
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    if (ingredient.qtyOnHand < qtyToConsume) {
      throw new Error(`Insufficient stock. Available: ${ingredient.qtyOnHand}, Required: ${qtyToConsume}`);
    }

    let remainingToConsume = qtyToConsume;
    let totalCostAllocated = 0;

    // Consume from oldest layers first (FIFO)
    for (let i = 0; i < ingredient.fifoLayers.length && remainingToConsume > 0; i++) {
      const layer = ingredient.fifoLayers[i];
      
      if (layer.remainingQty <= 0) continue; // Skip empty layers

      const consumeFromLayer = Math.min(remainingToConsume, layer.remainingQty);
      const costFromLayer = consumeFromLayer * layer.unitCost;

      layer.remainingQty -= consumeFromLayer;
      remainingToConsume -= consumeFromLayer;
      totalCostAllocated += costFromLayer;
    }

    if (remainingToConsume > 0) {
      throw new Error("FIFO consumption error: Could not consume full quantity");
    }

    // Update qty on hand
    ingredient.qtyOnHand -= qtyToConsume;

    // Clean up empty layers (optional - can keep for audit)
    // ingredient.fifoLayers = ingredient.fifoLayers.filter(l => l.remainingQty > 0);

    await ingredient.save();

    // Create inventory transaction record
    const transaction = new InventoryTransaction({
      ingredientId,
      type: "OUT",
      qty: qtyToConsume,
      uom: ingredient.baseUnit,
      refType,
      refId,
      date: new Date(),
      costAllocated: totalCostAllocated,
      recordedBy: userId,
      outletId,
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
    const ingredient = await Ingredient.findById(ingredientId).select("fifoLayers");
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }
    return ingredient.fifoLayers.filter(l => l.remainingQty > 0);
  }

  /**
   * Calculate average cost from FIFO layers
   * @param {String} ingredientId - Ingredient ID
   * @returns {Promise<Number>} Average cost per base unit
   */
  static async getAverageCost(ingredientId) {
    const ingredient = await Ingredient.findById(ingredientId).select("fifoLayers");
    if (!ingredient) {
      throw new Error("Ingredient not found");
    }

    const activeLayers = ingredient.fifoLayers.filter(l => l.remainingQty > 0);
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




