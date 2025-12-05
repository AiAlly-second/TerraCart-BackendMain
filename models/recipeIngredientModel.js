const mongoose = require("mongoose");

const recipeIngredientSchema = new mongoose.Schema(
  {
    recipeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recipe",
      required: true,
      index: true,
    },
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // QtyPerDish - alias for quantity (quantity per dish)
    qtyPerDish: {
      type: Number,
      min: 0,
    },
    unit: {
      type: String,
      required: true,
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
    },
  },
  {
    timestamps: true,
  }
);

// Set qtyPerDish to match quantity before save
recipeIngredientSchema.pre("save", function (next) {
  if (!this.qtyPerDish) {
    this.qtyPerDish = this.quantity;
  }
  if (!this.quantity && this.qtyPerDish) {
    this.quantity = this.qtyPerDish;
  }
  next();
});

// Compound index for efficient queries
recipeIngredientSchema.index({ recipeId: 1, ingredientId: 1 });

module.exports = mongoose.model("RecipeIngredient", recipeIngredientSchema);




