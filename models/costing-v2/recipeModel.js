const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Purchase = require("./purchaseModel");
const InventoryTransactionV2 = require("./inventoryTransactionModel");

// Helper function for logging
const logDebug = (location, message, data, hypothesisId) => {
  try {
    const logEntry = {
      location,
      message,
      data,
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "pre-fix",
      hypothesisId,
    };
    const logPath = path.join(__dirname, "../../../.cursor/debug.log");
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    // Silently fail if logging fails
  }
};

/**
 * Recipe Model - v2
 * Bill of Materials (BOM) with cost calculation
 */
const recipeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    yieldPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 100, // 100% = no waste
    },
    portions: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    instructions: {
      type: String,
      default: "",
    },
    ingredients: [
      {
        ingredientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "IngredientV2",
          required: true,
        },
        qty: { type: Number, required: true, min: 0 },
        uom: { type: String, required: true },
      },
    ],
    totalCostCached: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    costPerPortion: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    lastCostUpdate: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Kiosk/Outlet association (null = shared/global recipe)
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
recipeSchema.index({ name: 1 });
recipeSchema.index({ isActive: 1 });
// Unique index: prevent duplicate BOM names for the same outlet
recipeSchema.index({ name: 1, outletId: 1 }, { unique: true });

// Method to calculate recipe cost
// @param {String} outletId - Optional outlet ID to check for outlet-specific purchases
recipeSchema.methods.calculateCost = async function (outletId = null) {
  // #region agent log
  logDebug(
    "recipeModel.js:89",
    "calculateCost called",
    {
      recipeId: this._id,
      recipeName: this.name,
      outletId: outletId,
      ingredientCount: this.ingredients.length,
    },
    "C"
  );
  // #endregion
  const Ingredient = mongoose.model("IngredientV2");
  let totalCost = 0;
  let hasAnyValidCosts = false; // Track if at least one ingredient has valid costs
  let ingredientsWithoutPurchases = []; // Track ingredients without purchases

  for (const item of this.ingredients) {
    // Refresh ingredient to get latest cost (important after purchases)
    const ingredient = await Ingredient.findById(item.ingredientId);
    if (!ingredient) {
      ingredientsWithoutPurchases.push(
        item.ingredientId?.toString() || "unknown"
      );
      continue;
    }

    // Check if ingredient has actual purchases for this outlet (or any outlet if outletId not specified)
    // For Cart Admin, we need to check outlet-specific purchases
    let hasPurchases = false;
    if (outletId) {
      // Check for outlet-specific purchase transactions
      // CRITICAL: Only count purchases that belong to THIS outlet, not other carts
      const purchaseTransaction = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        outletId: outletId,
        type: "IN",
        refType: "purchase",
      });

      // Check if ingredient has FIFO layers with purchaseId that belong to THIS outlet
      // IMPORTANT: We must verify each FIFO layer's purchase belongs to this outlet
      let hasFifoLayersForThisOutlet = false;
      if (
        ingredient.fifoLayers &&
        Array.isArray(ingredient.fifoLayers) &&
        ingredient.fifoLayers.length > 0
      ) {
        // Check each FIFO layer to see if its purchase belongs to this outlet
        for (const layer of ingredient.fifoLayers) {
          if (layer.purchaseId) {
            const purchase = await Purchase.findById(layer.purchaseId);
            if (
              purchase &&
              purchase.outletId &&
              purchase.outletId.toString() === outletId.toString()
            ) {
              hasFifoLayersForThisOutlet = true;
              break; // Found at least one purchase for this outlet
            }
          }
        }
      }

      // Only consider purchases if they belong to THIS outlet
      hasPurchases = purchaseTransaction != null || hasFifoLayersForThisOutlet;

      // #region agent log
      logDebug(
        "recipeModel.js:110",
        "Checking outlet purchases (outlet-specific)",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: outletId,
          hasPurchases: hasPurchases,
          hasTransaction: purchaseTransaction != null,
          hasFifoLayersForThisOutlet: hasFifoLayersForThisOutlet,
        },
        "C"
      );
      // #endregion
    } else {
      // Check if ingredient has any FIFO layers with purchaseId (global check)
      hasPurchases =
        ingredient.fifoLayers &&
        Array.isArray(ingredient.fifoLayers) &&
        ingredient.fifoLayers.length > 0 &&
        ingredient.fifoLayers.some((layer) => layer.purchaseId != null);
      // #region agent log
      logDebug(
        "recipeModel.js:120",
        "Checking global purchases",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          hasPurchases: hasPurchases,
          fifoLayersCount: ingredient.fifoLayers?.length || 0,
        },
        "C"
      );
      // #endregion
    }

    if (!hasPurchases) {
      // No purchases made for this ingredient (for this outlet) - skip this ingredient
      ingredientsWithoutPurchases.push(
        ingredient.name || item.ingredientId?.toString()
      );
      // #region agent log
      logDebug(
        "recipeModel.js:128",
        "No purchases found - skipping ingredient",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: outletId,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient in cost calculation
    }

    // Check if ingredient has available inventory for this outlet
    // BOM cost should only show if ingredient is actually available in inventory
    // IMPORTANT: For cart-wise management, each outlet should only see their own inventory
    let hasAvailableInventory = false;
    let outletSpecificQty = 0;

    if (outletId) {
      // For outlet-specific ingredients, check qtyOnHand directly
      if (
        ingredient.outletId &&
        ingredient.outletId.toString() === outletId.toString()
      ) {
        // Ingredient belongs to this outlet - use qtyOnHand directly
        outletSpecificQty = ingredient.qtyOnHand || 0;
        hasAvailableInventory = outletSpecificQty > 0;
      } else {
        // For shared ingredients, calculate outlet-specific quantity from FIFO layers
        // Sum up remainingQty from FIFO layers that came from this outlet's purchases
        // This ensures cart-wise inventory isolation
        if (ingredient.fifoLayers && Array.isArray(ingredient.fifoLayers)) {
          for (const layer of ingredient.fifoLayers) {
            if (layer.purchaseId && layer.remainingQty > 0) {
              // Check if this purchase belongs to this outlet
              const purchase = await Purchase.findById(layer.purchaseId);
              if (
                purchase &&
                purchase.outletId &&
                purchase.outletId.toString() === outletId.toString()
              ) {
                outletSpecificQty += layer.remainingQty || 0;
              }
            }
          }
        }
        hasAvailableInventory = outletSpecificQty > 0;
        // #region agent log
        logDebug(
          "recipeModel.js:220",
          "Checking shared ingredient inventory (outlet-specific)",
          {
            ingredientId: item.ingredientId,
            ingredientName: ingredient.name,
            outletId: outletId,
            outletSpecificQty: outletSpecificQty,
            hasAvailableInventory: hasAvailableInventory,
            globalQtyOnHand: ingredient.qtyOnHand,
          },
          "C"
        );
        // #endregion
      }
      // #region agent log
      logDebug(
        "recipeModel.js:235",
        "Inventory availability check (cart-wise)",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: outletId,
          ingredientOutletId: ingredient.outletId,
          outletSpecificQty: outletSpecificQty,
          globalQtyOnHand: ingredient.qtyOnHand,
          hasAvailableInventory: hasAvailableInventory,
        },
        "C"
      );
      // #endregion
    } else {
      // For global/franchise-level, check qtyOnHand or FIFO layers
      outletSpecificQty = ingredient.qtyOnHand || 0;
      hasAvailableInventory =
        outletSpecificQty > 0 ||
        (ingredient.fifoLayers &&
          Array.isArray(ingredient.fifoLayers) &&
          ingredient.fifoLayers.some((layer) => (layer.remainingQty || 0) > 0));
    }

    if (!hasAvailableInventory) {
      // Ingredient is not available in inventory - skip this ingredient
      ingredientsWithoutPurchases.push(
        ingredient.name || item.ingredientId?.toString() + " (out of stock)"
      );
      // #region agent log
      logDebug(
        "recipeModel.js:250",
        "Ingredient not available in inventory - skipping",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: outletId,
          qtyOnHand: ingredient.qtyOnHand,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient in cost calculation
    }

    // Get weighted average cost per base unit
    // For outlet-specific ingredients, use the ingredient's weighted average (already calculated)
    // For shared ingredients with outletId, calculate outlet-specific weighted average from transactions
    let ingredientCost = 0;
    
    if (outletId && ingredient.outletId && ingredient.outletId.toString() === outletId.toString()) {
      // Cart-specific ingredient - use weighted average directly
      ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
    } else if (outletId) {
      // Shared ingredient with outletId - calculate outlet-specific weighted average from transactions
      // But if no outlet-specific transactions exist, use global cost
      const outletTransactions = await InventoryTransactionV2.find({
        ingredientId: item.ingredientId,
        outletId: outletId,
      }).sort({ date: 1 }); // Sort by date ascending to calculate weighted average

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

      // Use calculated weighted average cost if we have outlet-specific transactions
      // Otherwise, use global cost (which includes purchases from all outlets for shared ingredients)
      if (outletTransactions.length > 0 && totalQty > 0 && weightedAvgCost > 0) {
        ingredientCost = weightedAvgCost;
      } else {
        // No outlet-specific transactions or stock - use global cost
        // This ensures shared ingredients reflect purchases from all outlets
        ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
      }
    } else {
      // Global/shared ingredient - use weighted average directly
      ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
    }

    if (ingredientCost <= 0) {
      hasValidCosts = false;
      // #region agent log
      logDebug(
        "recipeModel.js:182",
        "Ingredient cost is 0 - skipping",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          ingredientCost: ingredientCost,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient
    }

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
    const cost = qtyInBaseUnit * ingredientCost;
    totalCost += cost;
    hasAnyValidCosts = true; // Mark that we have at least one valid cost
  }

  // If no valid costs (no purchases made for any ingredients),
  // set BOM cost to 0 explicitly
  if (!hasAnyValidCosts || totalCost === 0) {
    this.totalCostCached = 0;
    this.costPerPortion = 0;
    this.lastCostUpdate = new Date();
    // #region agent log
    logDebug(
      "recipeModel.js:195",
      "BOM cost set to 0 - no valid purchases",
      {
        recipeId: this._id,
        recipeName: this.name,
        outletId: outletId,
        totalCost: 0,
        hasAnyValidCosts: false,
        ingredientsWithoutPurchases: ingredientsWithoutPurchases,
      },
      "C"
    );
    // #endregion
    return {
      totalCost: 0,
      costPerPortion: 0,
      hasValidCosts: false,
    };
  }

  // Apply yield percent only when we have valid costs from purchases
  const adjustedCost = totalCost / (this.yieldPercent / 100);
  this.totalCostCached = adjustedCost;
  this.costPerPortion = adjustedCost / this.portions;
  this.lastCostUpdate = new Date();
  // #region agent log
  logDebug(
    "recipeModel.js:207",
    "BOM cost calculated successfully",
    {
      recipeId: this._id,
      recipeName: this.name,
      outletId: outletId,
      totalCost: adjustedCost,
      costPerPortion: this.costPerPortion,
      hasAnyValidCosts: true,
      ingredientsWithoutPurchases:
        ingredientsWithoutPurchases.length > 0
          ? ingredientsWithoutPurchases
          : "none",
    },
    "C"
  );
  // #endregion

  return {
    totalCost: adjustedCost,
    costPerPortion: this.costPerPortion,
    hasValidCosts: true,
  };
};

module.exports = mongoose.model("RecipeV2", recipeSchema);
