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

    // For outlet-specific cost, we need to get the cost from the most recent purchase for this outlet
    let ingredientCost = 0;
    if (outletId) {
      // Get the most recent purchase transaction for this outlet
      const latestTransaction = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        outletId: outletId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 });

      if (latestTransaction && latestTransaction.refId) {
        // Get the purchase to find the unit price for this ingredient
        const purchase = await Purchase.findById(latestTransaction.refId);
        // CRITICAL: Verify this purchase belongs to the current outlet
        if (
          purchase &&
          purchase.outletId &&
          purchase.outletId.toString() === outletId.toString() &&
          purchase.items
        ) {
          // Find the item in the purchase that matches this ingredient
          const purchaseItem = purchase.items.find(
            (pi) => pi.ingredientId.toString() === item.ingredientId.toString()
          );
          if (purchaseItem && purchaseItem.unitPrice > 0) {
            // Convert purchase item unit price to base unit
            const purchaseQtyInBaseUnit = ingredient.convertToBaseUnit(
              purchaseItem.qty,
              purchaseItem.uom
            );
            if (purchaseQtyInBaseUnit > 0) {
              // Calculate cost per base unit: total / qty in base unit
              ingredientCost = purchaseItem.total / purchaseQtyInBaseUnit;
              // #region agent log
              logDebug(
                "recipeModel.js:355",
                "Using purchase cost from current outlet",
                {
                  ingredientId: item.ingredientId,
                  ingredientName: ingredient.name,
                  outletId: outletId,
                  purchaseId: purchase._id,
                  purchaseOutletId: purchase.outletId,
                  ingredientCost: ingredientCost,
                  purchaseItemUnitPrice: purchaseItem.unitPrice,
                },
                "C"
              );
              // #endregion
            }
          }
        } else if (
          purchase &&
          purchase.outletId &&
          purchase.outletId.toString() !== outletId.toString()
        ) {
          // #region agent log
          logDebug(
            "recipeModel.js:375",
            "Purchase belongs to different outlet - skipping",
            {
              ingredientId: item.ingredientId,
              ingredientName: ingredient.name,
              currentOutletId: outletId,
              purchaseId: purchase._id,
              purchaseOutletId: purchase.outletId,
            },
            "C"
          );
          // #endregion
        }
      }

      // If still no cost found, fallback to transaction cost (only if transaction belongs to this outlet)
      if (ingredientCost <= 0) {
        if (
          latestTransaction &&
          latestTransaction.outletId &&
          latestTransaction.outletId.toString() === outletId.toString() &&
          latestTransaction.costAllocated > 0 &&
          latestTransaction.qty > 0
        ) {
          ingredientCost =
            latestTransaction.costAllocated / latestTransaction.qty;
          // #region agent log
          logDebug(
            "recipeModel.js:390",
            "Using transaction cost from current outlet",
            {
              ingredientId: item.ingredientId,
              ingredientName: ingredient.name,
              outletId: outletId,
              ingredientCost: ingredientCost,
              transactionOutletId: latestTransaction.outletId,
            },
            "C"
          );
          // #endregion
        } else {
          // Don't use global ingredient cost - it might be from another outlet
          ingredientCost = 0;
          // #region agent log
          logDebug(
            "recipeModel.js:405",
            "No valid cost found for this outlet - setting to 0",
            {
              ingredientId: item.ingredientId,
              ingredientName: ingredient.name,
              outletId: outletId,
              hasTransaction: !!latestTransaction,
              transactionOutletId: latestTransaction?.outletId,
            },
            "C"
          );
          // #endregion
        }
      }
      // #region agent log
      logDebug(
        "recipeModel.js:420",
        "Final outlet-specific cost calculated",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          outletId: outletId,
          ingredientCost: ingredientCost,
          hasTransaction: !!latestTransaction,
        },
        "C"
      );
      // #endregion
    } else {
      // Use ingredient's currentCostPerBaseUnit (for global/franchise-level)
      ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
      // #region agent log
      logDebug(
        "recipeModel.js:175",
        "Global cost used",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          ingredientCost: ingredientCost,
        },
        "C"
      );
      // #endregion
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
