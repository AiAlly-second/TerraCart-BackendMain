const mongoose = require("mongoose");

/**
 * Menu Item Model - v2
 * Links to recipes and calculates food cost %
 */
const menuItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    recipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RecipeV2",
      default: null, // Optional - menu items can exist without a recipe
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Cached values (updated when recipe cost changes)
    costPerPortion: {
      type: Number,
      min: 0,
      default: 0,
    },
    foodCostPercent: {
      type: Number,
      min: 0,
      default: 0,
      // Note: Can exceed 100% if cost > selling price (loss-making items)
    },
    contributionMargin: {
      type: Number,
      default: 0,
    },
    lastCostUpdate: {
      type: Date,
      default: Date.now,
    },
    // Link to default menu item
    defaultMenuFranchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    defaultMenuCategoryName: {
      type: String,
      default: null,
    },
    defaultMenuItemName: {
      type: String,
      default: null,
    },
    // Store the full path for easy lookup: franchiseId/categoryName/itemName
    defaultMenuPath: {
      type: String,
      default: null,
      index: true,
    },
    // Cart association (required - menu items are cart-specific)
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
menuItemSchema.index({ name: 1 });
menuItemSchema.index({ category: 1 });
menuItemSchema.index({ recipeId: 1 });
menuItemSchema.index({ isActive: 1 });

// Method to calculate food cost metrics
menuItemSchema.methods.calculateMetrics = function (recipeCostPerPortion) {
  this.costPerPortion = recipeCostPerPortion;
  this.foodCostPercent = this.sellingPrice > 0 
    ? (recipeCostPerPortion / this.sellingPrice) * 100 
    : 0;
  this.contributionMargin = this.sellingPrice - recipeCostPerPortion;
  this.lastCostUpdate = new Date();
  return {
    costPerPortion: this.costPerPortion,
    foodCostPercent: this.foodCostPercent,
    contributionMargin: this.contributionMargin,
  };
};

module.exports = mongoose.model("MenuItemV2", menuItemSchema);

