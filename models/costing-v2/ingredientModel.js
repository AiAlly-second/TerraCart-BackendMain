const mongoose = require("mongoose");

/**
 * Ingredient Model - v2
 * Supports weighted average costing, unit conversions, and reorder management
 * Base units: g (for weight), ml (for volume), pcs (for count)
 */
const ingredientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      index: true,
      enum: [
        // Raw Ingredients
        "Vegetables",
        "Dairy",
        "Meat & Poultry",
        "Grains & Staples",
        "Spices & Seasoning",
        "Cooking Oils & Ghee",
        "Bread, Buns & Rotis",
        "Snacks Ingredients",
        "Packaged Items",
        "Beverages",
        // Consumables & Non-Food Items
        "Tissue & Paper Products",
        "Packaging Materials",
        "Disposable Items",
        "Cleaning Supplies",
        "Safety & Hygiene",
        "Gas & Fuel",
        // Prepared Items / Pre-mixes
        "Prepared Items",
        "Pre-mixes",
        // Other
        "Other",
      ],
      default: "Other",
      index: true,
    },
    storageLocation: {
      type: String,
      enum: ["Dry Storage", "Cold Storage", "Frozen Storage", "Vegetables Section", "Cleaning Supplies", "Packaging Supplies", "Other"],
      default: "Dry Storage",
      index: true,
    },
    uom: {
      type: String,
      required: true,
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
    },
    baseUnit: {
      type: String,
      required: true,
      enum: ["g", "ml", "pcs"], // Only lowest level units allowed
      default: function() {
        // Auto-determine base unit from uom
        if (['kg', 'g'].includes(this.uom)) return 'g';
        if (['l', 'ml'].includes(this.uom)) return 'ml';
        if (['pcs', 'pack', 'box', 'bottle', 'dozen'].includes(this.uom)) return 'pcs';
        return 'pcs'; // Default fallback
      },
    },
    // Conversion factors: { "kg": 1, "g": 1000, "l": 0.001 }
    conversionFactors: {
      type: Map,
      of: Number,
      default: function() {
        const factors = new Map();
        factors.set(this.baseUnit, 1);
        return factors;
      },
    },
    reorderLevel: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    shelfTimeDays: {
      type: Number,
      min: 0,
      default: 7,
    },
    /** When stock was last received (return/purchase). Used with shelfTimeDays to compute expiry. */
    lastReceivedAt: {
      type: Date,
      default: null,
    },
    /** Optional explicit expiry date from purchase. If set, takes precedence over shelfTimeDays. */
    expiryDate: {
      type: Date,
      default: null,
    },
    preferredSupplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    // Weighted Average Cost (in base unit)
    currentCostPerBaseUnit: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      // This is the weighted average cost per base unit (g, ml, or pcs)
    },
    // Quantity on hand in base unit
    qtyOnHand: {
      type: Number,
      required: true,
      default: 0,
      // Always stored in base unit (g, ml, or pcs)
    },
    // Legacy FIFO layers - kept for backward compatibility during migration
    // Will be deprecated in favor of weighted average
    fifoLayers: [
      {
        qty: { type: Number, required: true, min: 0 },
        uom: { type: String, required: true },
        unitCost: { type: Number, required: true, min: 0 },
        remainingQty: { type: Number, required: true, min: 0 },
        purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase" },
        date: { type: Date, required: true, default: Date.now },
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    // Cart association (null = shared/global ingredient)
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

// Indexes (name, category, and storageLocation already indexed in schema with index: true)
ingredientSchema.index({ preferredSupplierId: 1 });
ingredientSchema.index({ isActive: 1 });

// Pre-save: ensure baseUnit is set to lowest level and conversion factors are initialized
ingredientSchema.pre("save", function (next) {
  // Auto-determine base unit if not set or if it's not a base unit
  if (!this.baseUnit || !['g', 'ml', 'pcs'].includes(this.baseUnit)) {
    if (['kg', 'g'].includes(this.uom)) {
      this.baseUnit = 'g';
    } else if (['l', 'ml'].includes(this.uom)) {
      this.baseUnit = 'ml';
    } else {
      this.baseUnit = 'pcs';
    }
  }
  
  // Initialize conversion factors with standard conversions
  if (!this.conversionFactors || this.conversionFactors.size === 0) {
    const factors = new Map();
    factors.set(this.baseUnit, 1);
    
    // Add standard conversion factors based on base unit
    if (this.baseUnit === 'g') {
      factors.set('kg', 1000); // 1 kg = 1000 g
      factors.set('g', 1);
    } else if (this.baseUnit === 'ml') {
      factors.set('l', 1000); // 1 l = 1000 ml
      factors.set('ml', 1);
    } else if (this.baseUnit === 'pcs') {
      factors.set('pcs', 1);
      factors.set('dozen', 12); // 1 dozen = 12 pcs
      factors.set('pack', 1); // Default 1:1, can be customized
      factors.set('box', 1); // Default 1:1, can be customized
      factors.set('bottle', 1); // Default 1:1, can be customized
    }
    
    this.conversionFactors = factors;
  }
  next();
});

/**
 * Get standard conversion factor between two units
 * Returns the factor to convert from 'fromUom' to 'toUom'
 * This is used as a fallback when conversionFactors map doesn't have the factor
 */
function getStandardConversionFactor(fromUom, toUom) {
  if (fromUom === toUom) return 1;
  
  // Standard weight conversions (kg <-> g)
  // Base unit is always g, so kg -> g: multiply by 1000
  if (fromUom === 'kg' && toUom === 'g') return 1000;
  if (fromUom === 'g' && toUom === 'kg') return 0.001;
  
  // Standard volume conversions (l <-> ml)
  // Base unit is always ml, so l -> ml: multiply by 1000
  if (fromUom === 'l' && toUom === 'ml') return 1000;
  if (fromUom === 'ml' && toUom === 'l') return 0.001;
  
  // Count-based units - base unit is always pcs
  // Dozen to pieces: 1 dozen = 12 pieces
  if (fromUom === 'dozen' && toUom === 'pcs') return 12;
  if (fromUom === 'pcs' && toUom === 'dozen') return 1/12;
  
  // Pack, box, bottle default to 1:1 with pcs (can be customized per ingredient)
  const countUnits = ['pcs', 'pack', 'box', 'bottle'];
  if (countUnits.includes(fromUom) && countUnits.includes(toUom)) {
    return 1; // Default 1:1, should be customized per ingredient if needed
  }
  
  return null; // No standard conversion available
}

// Method to convert quantity from one unit to base unit
ingredientSchema.methods.convertToBaseUnit = function (qty, fromUom) {
  if (fromUom === this.baseUnit) return qty;
  
  // First try to get factor from conversionFactors map
  let factor = this.conversionFactors.get(fromUom);
  
  // If not found, try standard conversion factors
  if (!factor) {
    factor = getStandardConversionFactor(fromUom, this.baseUnit);
  }
  
  // If still not found, throw error
  if (!factor) {
    throw new Error(`Conversion factor not found for ${fromUom} to ${this.baseUnit}. Please set conversion factors for this ingredient.`);
  }
  
  return qty * factor;
};

// Method to convert quantity from base unit to target unit
ingredientSchema.methods.convertFromBaseUnit = function (qty, toUom) {
  if (toUom === this.baseUnit) return qty;
  
  // First try to get factor from conversionFactors map
  let factor = this.conversionFactors.get(toUom);
  
  // If not found, try standard conversion factors
  if (!factor) {
    factor = getStandardConversionFactor(this.baseUnit, toUom);
  }
  
  // If still not found, throw error
  if (!factor) {
    throw new Error(`Conversion factor not found for ${this.baseUnit} to ${toUom}. Please set conversion factors for this ingredient.`);
  }
  
  return qty / factor;
};

module.exports = mongoose.model("IngredientV2", ingredientSchema);
