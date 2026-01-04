const mongoose = require("mongoose");

const ingredientPurchaseSchema = new mongoose.Schema(
  {
    purchaseId: {
      type: String,
      unique: true,
      required: true,
      trim: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Kiosk/Cafe reference
      required: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      required: true,
      index: true,
    },
    qtyPurchased: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      required: true,
      enum: ["kg", "g", "l", "ml", "pcs", "pack", "box", "bottle", "dozen"],
    },
    totalCost: {
      type: Number,
      required: true,
      min: 0,
    },
    unitCost: {
      type: Number,
      required: true,
      min: 0,
    },
    purchaseDate: {
      type: Date,
      required: true,
      index: true,
    },
    vendor: {
      type: String,
      default: "",
    },
    invoicePath: {
      type: String,
      default: null,
    },
    remarks: {
      type: String,
      default: "",
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

// Indexes for efficient queries
ingredientPurchaseSchema.index({ cartId: 1, purchaseDate: -1 });
ingredientPurchaseSchema.index({ ingredientId: 1, purchaseDate: -1 });
ingredientPurchaseSchema.index({ franchiseId: 1, purchaseDate: -1 });
ingredientPurchaseSchema.index({ purchaseDate: -1 });

// Auto-generate purchaseId before save
ingredientPurchaseSchema.pre("save", async function (next) {
  if (!this.purchaseId) {
    const count = await mongoose.model("IngredientPurchase").countDocuments();
    this.purchaseId = `PUR-${Date.now()}-${count + 1}`;
  }
  // Calculate unitCost
  if (this.qtyPurchased > 0) {
    this.unitCost = this.totalCost / this.qtyPurchased;
  }
  next();
});

module.exports = mongoose.model("IngredientPurchase", ingredientPurchaseSchema);





