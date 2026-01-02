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
    // Cart association (null = shared/global recipe)
    cartId: {
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
recipeSchema.index({ name: 1, cartId: 1 }, { unique: true });

// Method to calculate recipe cost
// @param {String} cartId - Optional cart ID to check for cart-specific purchases
recipeSchema.methods.calculateCost = async function (cartId = null) {
  // #region agent log
  logDebug(
    "recipeModel.js:89",
    "calculateCost called",
    {
      recipeId: this._id,
      recipeName: this.name,
      cartId: cartId,
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

    // Check if ingredient has actual purchases for this cart (or any cart if cartId not specified)
    // For Cart Admin, we need to check cart-specific purchases
    let hasPurchases = false;
    if (cartId) {
      // Check for cart-specific purchase transactions
      // CRITICAL: Only count purchases that belong to THIS cart, not other carts
      const purchaseTransaction = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        cartId: cartId,
        type: "IN",
        refType: "purchase",
      });

      // Only consider purchases if they belong to THIS cart
      // Use transactions to check for purchases (not FIFO layers)
      hasPurchases = purchaseTransaction != null;

      // #region agent log
      logDebug(
        "recipeModel.js:110",
        "Checking cart purchases (cart-specific)",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          cartId: cartId,
          hasPurchases: hasPurchases,
          hasTransaction: purchaseTransaction != null,
        },
        "C"
      );
      // #endregion
    } else {
      // Check if ingredient has any purchase transactions (global check)
      const anyPurchaseTransaction = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        type: "IN",
        refType: "purchase",
      });
      hasPurchases = anyPurchaseTransaction != null;
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
          cartId: cartId,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient in cost calculation
    }

    // Check if ingredient has available inventory for this cart
    // BOM cost should only show if ingredient is actually available in inventory
    // IMPORTANT: For cart-wise management, each cart should only see their own inventory
    let hasAvailableInventory = false;
    let cartSpecificQty = 0;

    if (cartId) {
      // For cart-specific ingredients, check qtyOnHand directly
      if (
        ingredient.cartId &&
        ingredient.cartId.toString() === cartId.toString()
      ) {
        // Ingredient belongs to this cart - use qtyOnHand directly
        cartSpecificQty = ingredient.qtyOnHand || 0;
        hasAvailableInventory = cartSpecificQty > 0;
      } else {
        // For shared ingredients, calculate cart-specific quantity from transactions
        // This uses weighted average costing (same as inventory calculation)
        const cartTransactions = await InventoryTransactionV2.find({
          ingredientId: item.ingredientId,
          cartId: cartId,
        }).sort({ date: 1 }); // Sort by date ascending to calculate weighted average

        let totalQty = 0;
        for (const txn of cartTransactions) {
          const txnQty = txn.qtyInBaseUnit || txn.qty;
          if (txn.type === "IN" || txn.type === "RETURN") {
            totalQty += txnQty;
          } else if (txn.type === "OUT" || txn.type === "WASTE") {
            totalQty -= txnQty;
            if (totalQty < 0) totalQty = 0;
          }
        }
        cartSpecificQty = Math.max(0, totalQty);
        // Has inventory if there are any purchase transactions (even if stock is now 0)
        // This allows BOM to show cost based on purchases, not just current stock
        hasAvailableInventory = cartTransactions.some(txn => txn.type === "IN" && txn.refType === "purchase");
        // #region agent log
        logDebug(
          "recipeModel.js:220",
          "Checking shared ingredient inventory (cart-specific)",
          {
            ingredientId: item.ingredientId,
            ingredientName: ingredient.name,
            cartId: cartId,
            cartSpecificQty: cartSpecificQty,
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
          cartId: cartId,
          ingredientCartId: ingredient.cartId,
          cartSpecificQty: cartSpecificQty,
          globalQtyOnHand: ingredient.qtyOnHand,
          hasAvailableInventory: hasAvailableInventory,
        },
        "C"
      );
      // #endregion
    } else {
      // For global/franchise-level, check qtyOnHand or FIFO layers
      cartSpecificQty = ingredient.qtyOnHand || 0;
      hasAvailableInventory =
        cartSpecificQty > 0 ||
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
          cartId: cartId,
          qtyOnHand: ingredient.qtyOnHand,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient in cost calculation
    }

    // Get last purchase cost per base unit (matching inventory calculation)
    // This ensures BOM cost matches what's shown in inventory
    let ingredientCost = 0;
    
    if (cartId && ingredient.cartId && ingredient.cartId.toString() === cartId.toString()) {
      // Cart-specific ingredient - find last purchase transaction
      const lastPurchase = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        cartId: cartId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 }); // Sort by date descending to get most recent
      
      if (lastPurchase) {
        const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
        const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
        if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
          ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
        }
      }
      
      // Fallback to ingredient's currentCostPerBaseUnit if no purchase found
      if (ingredientCost <= 0) {
        ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
      }
    } else if (cartId) {
      // Shared ingredient with cartId - find last purchase for this cart
      const lastPurchase = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        cartId: cartId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 }); // Sort by date descending to get most recent
      
      if (lastPurchase) {
        const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
        const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
        if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
          ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
        }
      }
      
      // Fallback to global cost if no cart-specific purchase found
      if (ingredientCost <= 0) {
        ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
      }
    } else {
      // Global/shared ingredient - find last purchase (any cart)
      const lastPurchase = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 }); // Sort by date descending to get most recent
      
      if (lastPurchase) {
        const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
        const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
        if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
          ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
        }
      }
      
      // Fallback to ingredient's currentCostPerBaseUnit if no purchase found
      if (ingredientCost <= 0) {
        ingredientCost = Number(ingredient.currentCostPerBaseUnit) || 0;
      }
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
    let qtyInBaseUnit;
    try {
      qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
    } catch (conversionError) {
      // Handle unit conversion errors gracefully
      ingredientsWithoutPurchases.push(
        `${ingredient.name || item.ingredientId?.toString()} (invalid unit conversion: ${item.uom} to ${ingredient.baseUnit})`
      );
      // #region agent log
      logDebug(
        "recipeModel.js:388",
        "Unit conversion error - skipping ingredient",
        {
          ingredientId: item.ingredientId,
          ingredientName: ingredient.name,
          recipeUom: item.uom,
          ingredientBaseUnit: ingredient.baseUnit,
          error: conversionError.message,
        },
        "C"
      );
      // #endregion
      continue; // Skip this ingredient
    }
    
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
        cartId: cartId,
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
      cartId: cartId,
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
