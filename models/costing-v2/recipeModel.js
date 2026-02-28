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
    // Normalized name for duplicate prevention (case/space insensitive)
    // Example: "  Milk  Tea " -> "milk tea"
    nameNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
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
    addonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Addon",
      default: null,
      index: true,
    },
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
recipeSchema.index({ addonId: 1, cartId: 1, franchiseId: 1 });
// Unique index: prevent duplicate BOM names for the same outlet (case-insensitive via nameNormalized)
recipeSchema.index({ nameNormalized: 1, cartId: 1 }, { unique: true });

// Keep nameNormalized in sync
recipeSchema.pre("validate", function (next) {
  try {
    const raw = typeof this.name === "string" ? this.name : "";
    const normalized = raw.trim().replace(/\s+/g, " ").toLowerCase();
    this.name = raw.trim().replace(/\s+/g, " ");
    this.nameNormalized = normalized;
    next();
  } catch (err) {
    next(err);
  }
});

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

    // RELAXED CHECK: Don't skip if no purchases found. 
    // We should still calculate cost based on currentCostPerBaseUnit (Opening Stock / Standard Cost)
    /*
    if (!hasPurchases) {
      // No purchases made for this ingredient (for this outlet) - skip this ingredient
      ingredientsWithoutPurchases.push(
        ingredient.name || item.ingredientId?.toString()
      );
      // ... log ...
      continue; // Skip this ingredient in cost calculation
    }
    */

    // RELAXED CHECK: Don't skip if no available inventory.
    // BOM cost should reflect "theoretical cost" even if currently out of stock.
    /*
    if (!hasAvailableInventory) {
      // Ingredient is not available in inventory - skip this ingredient
      ingredientsWithoutPurchases.push(
        ingredient.name || item.ingredientId?.toString() + " (out of stock)"
      );
      // ... log ...
      continue; // Skip this ingredient in cost calculation
    }
    */

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
        // CRITICAL: Validate purchase has actual cost data AND valid quantity
        const hasValidQty = (lastPurchase.qty != null && lastPurchase.qty > 0) ||
                           (lastPurchase.qtyInBaseUnit != null && lastPurchase.qtyInBaseUnit > 0);
        const hasValidCost = (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) ||
                             (lastPurchase.costAllocated != null && lastPurchase.costAllocated > 0);
        
        if (!hasValidQty || !hasValidCost) {
          // Purchase transaction exists but has no valid cost or quantity - treat as no purchase
          console.log(`[BOM COST] Purchase transaction found but invalid (qty: ${hasValidQty}, cost: ${hasValidCost}) for ingredient ${ingredient.name}, cartId: ${cartId}`);
          ingredientCost = 0;
        } else {
        // CRITICAL: Use exact unitPrice from purchase if available, otherwise calculate from costAllocated
        // This ensures BOM cost matches purchase price exactly (same as inventory)
        if (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) {
          // Use exact purchase price - convert to base unit
          try {
            const purchaseUom = lastPurchase.uom || ingredient.uom;
            const conversionFactor = ingredient.convertToBaseUnit(1, purchaseUom);
            ingredientCost = lastPurchase.unitPrice / conversionFactor;
          } catch (conversionError) {
            ingredientsWithoutPurchases.push(
              `${ingredient.name || item.ingredientId?.toString()} (invalid purchase unit conversion: ${lastPurchase.uom || ingredient.uom} to ${ingredient.baseUnit})`
            );
            ingredientCost = 0;
          }
        } else {
          // Fallback: calculate from costAllocated
          const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
          const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
          if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
            ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
            } else {
              ingredientCost = 0; // Invalid purchase data
            }
          }
        }
      } else {
        // No purchase transaction found - cost remains 0
        ingredientCost = 0;
      }
      
      // CART ISOLATION: Do NOT fall back to global cost for cart-specific ingredients
      // If this cart has no purchases for its own ingredients, cost should remain 0
      // This ensures strict cart-level cost isolation
    } else if (cartId) {
      // Shared ingredient with cartId - find last purchase for this cart
      // CRITICAL CART ISOLATION: Only use cart's own purchases, never fall back to global costs
      const lastPurchase = await InventoryTransactionV2.findOne({
        ingredientId: item.ingredientId,
        cartId: cartId,
        type: "IN",
        refType: "purchase",
      }).sort({ date: -1 }); // Sort by date descending to get most recent
      
      if (lastPurchase) {
        // CRITICAL: Validate purchase has actual cost data AND valid quantity
        const hasValidQty = (lastPurchase.qty != null && lastPurchase.qty > 0) ||
                           (lastPurchase.qtyInBaseUnit != null && lastPurchase.qtyInBaseUnit > 0);
        const hasValidCost = (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) ||
                             (lastPurchase.costAllocated != null && lastPurchase.costAllocated > 0);
        
        if (!hasValidQty || !hasValidCost) {
          // Purchase transaction exists but has no valid cost or quantity - treat as no purchase
          console.log(`[BOM COST] Purchase transaction found but invalid (qty: ${hasValidQty}, cost: ${hasValidCost}) for ingredient ${ingredient.name}, cartId: ${cartId}`);
          ingredientCost = 0;
        } else {
        // CRITICAL: Use exact unitPrice from purchase if available, otherwise calculate from costAllocated
        // This ensures BOM cost matches purchase price exactly (same as inventory)
        if (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) {
          // Use exact purchase price - convert to base unit
          try {
            const purchaseUom = lastPurchase.uom || ingredient.uom;
            const conversionFactor = ingredient.convertToBaseUnit(1, purchaseUom);
            ingredientCost = lastPurchase.unitPrice / conversionFactor;
          } catch (conversionError) {
            ingredientsWithoutPurchases.push(
              `${ingredient.name || item.ingredientId?.toString()} (invalid purchase unit conversion: ${lastPurchase.uom || ingredient.uom} to ${ingredient.baseUnit})`
            );
            ingredientCost = 0;
          }
        } else {
          // Fallback: calculate from costAllocated
          const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
          const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
          if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
            ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
            } else {
              ingredientCost = 0; // Invalid purchase data
            }
          }
        }
      } else {
        // No purchase transaction found - cost remains 0
        ingredientCost = 0;
      }
      
      // CART ISOLATION: Do NOT fall back to global cost
      // If this cart has no purchases, cost should remain 0 (ingredient will be skipped)
      // This ensures each cart only sees costs from their own purchases
    } else {
      // Global/shared ingredient - find last purchase
      // CRITICAL: If cartId is provided (cart admin), only use purchases from that cart
      // If cartId is null (super admin viewing global), use any purchase
      const purchaseFilter = {
        ingredientId: item.ingredientId,
        type: "IN",
        refType: "purchase",
      };
      
      // For cart admin, only use their own purchases even for shared ingredients
      if (cartId) {
        purchaseFilter.cartId = cartId;
      }
      
      const lastPurchase = await InventoryTransactionV2.findOne(purchaseFilter)
        .sort({ date: -1 }); // Sort by date descending to get most recent
      
      if (lastPurchase) {
        // CRITICAL: Validate purchase has actual cost data AND valid quantity
        const hasValidQty = (lastPurchase.qty != null && lastPurchase.qty > 0) ||
                           (lastPurchase.qtyInBaseUnit != null && lastPurchase.qtyInBaseUnit > 0);
        const hasValidCost = (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) ||
                             (lastPurchase.costAllocated != null && lastPurchase.costAllocated > 0);
        
        if (!hasValidQty || !hasValidCost) {
          // Purchase transaction exists but has no valid cost or quantity - treat as no purchase
          console.log(`[BOM COST] Purchase transaction found but invalid (qty: ${hasValidQty}, cost: ${hasValidCost}) for ingredient ${ingredient.name}, cartId: ${cartId || 'global'}`);
          ingredientCost = 0;
        } else {
        // CRITICAL: Use exact unitPrice from purchase if available, otherwise calculate from costAllocated
        // This ensures BOM cost matches purchase price exactly (same as inventory)
        if (lastPurchase.unitPrice != null && lastPurchase.unitPrice > 0) {
          // Use exact purchase price - convert to base unit
          try {
            const purchaseUom = lastPurchase.uom || ingredient.uom;
            const conversionFactor = ingredient.convertToBaseUnit(1, purchaseUom);
            ingredientCost = lastPurchase.unitPrice / conversionFactor;
          } catch (conversionError) {
            ingredientsWithoutPurchases.push(
              `${ingredient.name || item.ingredientId?.toString()} (invalid purchase unit conversion: ${lastPurchase.uom || ingredient.uom} to ${ingredient.baseUnit})`
            );
            ingredientCost = 0;
          }
        } else {
          // Fallback: calculate from costAllocated
          const lastPurchaseQty = lastPurchase.qtyInBaseUnit || lastPurchase.qty;
          const lastPurchaseCostAllocated = lastPurchase.costAllocated || 0;
          if (lastPurchaseQty > 0 && lastPurchaseCostAllocated > 0) {
            ingredientCost = lastPurchaseCostAllocated / lastPurchaseQty;
            } else {
              ingredientCost = 0; // Invalid purchase data
        }
      }
        }
      } else {
        // No purchase transaction found - cost remains 0
        ingredientCost = 0;
      }
      
      // CRITICAL FIX: For cart admin (cartId provided), NEVER use fallback to currentCostPerBaseUnit
      // Cart admin should only see costs from their own purchases
      // Only use fallback for super admin viewing global recipes (cartId is null)
      if (ingredientCost <= 0 && !cartId) {
        // Only fallback to currentCostPerBaseUnit if no cartId (super admin global view)
        // But only if ingredient actually has a valid currentCostPerBaseUnit (> 0)
        const fallbackCost = Number(ingredient.currentCostPerBaseUnit) || 0;
        if (fallbackCost > 0) {
          ingredientCost = fallbackCost;
        }
      }
      // If cartId is provided and no purchase found, ingredientCost remains 0 (will be skipped)
    }

    if (ingredientCost <= 0) {
      // Ingredient cost is 0 or invalid - skip this ingredient
      ingredientsWithoutPurchases.push(
        ingredient.name || item.ingredientId?.toString() + " (cost is 0)"
      );
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
    
    // Validate cost calculation
    if (isNaN(cost) || !isFinite(cost) || cost < 0) {
      console.error(`[BOM COST ERROR] Invalid cost for ingredient ${ingredient.name} in recipe ${this.name}: cost=${cost}, qtyInBaseUnit=${qtyInBaseUnit}, ingredientCost=${ingredientCost}`);
      ingredientsWithoutPurchases.push(
        `${ingredient.name} (invalid cost calculation)`
      );
      continue; // Skip this ingredient
    }
    
    totalCost += cost;
    hasAnyValidCosts = true; // Mark that we have at least one valid cost
  }

  // Validate totalCost before proceeding
  if (isNaN(totalCost) || !isFinite(totalCost) || totalCost < 0) {
    console.error(`[BOM COST ERROR] Invalid totalCost for recipe ${this.name}: ${totalCost}`);
    this.totalCostCached = 0;
    this.costPerPortion = 0;
    this.lastCostUpdate = new Date();
    return {
      totalCost: 0,
      costPerPortion: 0,
      hasValidCosts: false,
      ingredientsWithoutPurchases: ingredientsWithoutPurchases,
    };
  }

  // If no valid costs (no purchases made for any ingredients),
  // set BOM cost to 0 explicitly
  // Also treat very small costs (< 0.01) as zero to handle floating point precision issues
  if (!hasAnyValidCosts || totalCost === 0 || totalCost < 0.01) {
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
      ingredientsWithoutPurchases: ingredientsWithoutPurchases,
    };
  }

  // Apply yield percent only when we have valid costs from purchases
  // Prevent division by zero - if yieldPercent is 0 or invalid, use 100% (no waste)
  const yieldPercent = this.yieldPercent > 0 && this.yieldPercent <= 100 ? this.yieldPercent : 100;
  const adjustedCost = totalCost / (yieldPercent / 100);
  
  // Validate adjustedCost is a valid number
  if (isNaN(adjustedCost) || !isFinite(adjustedCost) || adjustedCost < 0) {
    console.error(`[BOM COST ERROR] Invalid adjustedCost for recipe ${this.name}: ${adjustedCost}. totalCost=${totalCost}, yieldPercent=${yieldPercent}`);
    this.totalCostCached = 0;
    this.costPerPortion = 0;
    this.lastCostUpdate = new Date();
    return {
      totalCost: 0,
      costPerPortion: 0,
      hasValidCosts: false,
      ingredientsWithoutPurchases: ingredientsWithoutPurchases,
    };
  }
  
  this.totalCostCached = adjustedCost;
  
  // Prevent division by zero for portions
  const portions = this.portions > 0 ? this.portions : 1;
  const costPerPortion = adjustedCost / portions;
  
  // Validate costPerPortion is a valid number
  if (isNaN(costPerPortion) || !isFinite(costPerPortion) || costPerPortion < 0) {
    console.error(`[BOM COST ERROR] Invalid costPerPortion for recipe ${this.name}: ${costPerPortion}. adjustedCost=${adjustedCost}, portions=${portions}`);
    this.costPerPortion = 0;
  } else {
    this.costPerPortion = costPerPortion;
  }
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
    ingredientsWithoutPurchases: ingredientsWithoutPurchases.length > 0 ? ingredientsWithoutPurchases : [],
  };
};

module.exports = mongoose.model("RecipeV2", recipeSchema);
