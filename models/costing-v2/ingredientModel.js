const mongoose = require("mongoose");

/**
 * Ingredient Model - v2
 * Supports FIFO layers, unit conversions, and reorder management
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
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
      default: function() {
        return this.uom;
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
    preferredSupplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    currentCostPerBaseUnit: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    qtyOnHand: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    // FIFO layers for cost tracking
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
    // Kiosk/Outlet association (null = shared/global ingredient)
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

// Indexes (name, category, and storageLocation already indexed in schema with index: true)
ingredientSchema.index({ preferredSupplierId: 1 });
ingredientSchema.index({ isActive: 1 });

// Pre-save: ensure baseUnit matches uom if not set
ingredientSchema.pre("save", function (next) {
  if (!this.baseUnit) {
    this.baseUnit = this.uom;
  }
  if (!this.conversionFactors || this.conversionFactors.size === 0) {
    const factors = new Map();
    factors.set(this.baseUnit, 1);
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
  // To convert from g to kg: multiply by 0.001 (1 g = 0.001 kg)
  // To convert from kg to g: multiply by 1000 (1 kg = 1000 g)
  if (fromUom === 'kg' && toUom === 'g') return 1000;
  if (fromUom === 'g' && toUom === 'kg') return 0.001;
  
  // Standard volume conversions (l <-> ml)
  // To convert from ml to l: multiply by 0.001 (1 ml = 0.001 l)
  // To convert from l to ml: multiply by 1000 (1 l = 1000 ml)
  if (fromUom === 'l' && toUom === 'ml') return 1000;
  if (fromUom === 'ml' && toUom === 'l') return 0.001;
  
  // Count-based units - treat as 1:1 for same category
  // (pack, box, bottle are typically 1:1 with pcs, but can be customized)
  const countUnits = ['pcs', 'pack', 'box', 'bottle'];
  if (countUnits.includes(fromUom) && countUnits.includes(toUom)) {
    return 1; // Default 1:1, should be customized per ingredient if needed
  }
  
  // Dozen to pieces: 1 dozen = 12 pieces
  if (fromUom === 'dozen' && toUom === 'pcs') return 12;
  if (fromUom === 'pcs' && toUom === 'dozen') return 1/12;
  
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

