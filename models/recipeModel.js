const mongoose = require("mongoose");

const recipeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    plateCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    overheadPerPlate: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Link to MenuItem/Dish
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuItem",
      default: null,
      index: true,
    },
    // Alternative: dish name if not linked to menu item
    dishName: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "",
    },
    defaultSellingPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Note: sku field has unique: true which automatically creates an index
// Index for efficient queries by name
recipeSchema.index({ name: 1 });

module.exports = mongoose.model("Recipe", recipeSchema);




