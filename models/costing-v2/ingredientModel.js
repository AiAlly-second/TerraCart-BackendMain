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
    },
    category: {
      type: String,
      required: true,
      trim: true,
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
    leadTimeDays: {
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

// Indexes
ingredientSchema.index({ name: 1 });
ingredientSchema.index({ category: 1 });
ingredientSchema.index({ storageLocation: 1 });
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

// Method to convert quantity from one unit to base unit
ingredientSchema.methods.convertToBaseUnit = function (qty, fromUom) {
  if (fromUom === this.baseUnit) return qty;
  const factor = this.conversionFactors.get(fromUom);
  if (!factor) {
    throw new Error(`Conversion factor not found for ${fromUom} to ${this.baseUnit}`);
  }
  return qty * factor;
};

// Method to convert quantity from base unit to target unit
ingredientSchema.methods.convertFromBaseUnit = function (qty, toUom) {
  if (toUom === this.baseUnit) return qty;
  const factor = this.conversionFactors.get(toUom);
  if (!factor) {
    throw new Error(`Conversion factor not found for ${this.baseUnit} to ${toUom}`);
  }
  return qty / factor;
};

module.exports = mongoose.model("IngredientV2", ingredientSchema);

