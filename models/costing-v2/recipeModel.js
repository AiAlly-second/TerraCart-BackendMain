const mongoose = require("mongoose");

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

// Method to calculate recipe cost
recipeSchema.methods.calculateCost = async function () {
  const Ingredient = mongoose.model("IngredientV2");
  let totalCost = 0;

  for (const item of this.ingredients) {
    const ingredient = await Ingredient.findById(item.ingredientId);
    if (!ingredient) continue;

    // Convert to base unit
    const qtyInBaseUnit = ingredient.convertToBaseUnit(item.qty, item.uom);
    const cost = qtyInBaseUnit * ingredient.currentCostPerBaseUnit;
    totalCost += cost;
  }

  // Apply yield percent
  const adjustedCost = totalCost / (this.yieldPercent / 100);
  this.totalCostCached = adjustedCost;
  this.costPerPortion = adjustedCost / this.portions;
  this.lastCostUpdate = new Date();

  return {
    totalCost: adjustedCost,
    costPerPortion: this.costPerPortion,
  };
};

module.exports = mongoose.model("RecipeV2", recipeSchema);

