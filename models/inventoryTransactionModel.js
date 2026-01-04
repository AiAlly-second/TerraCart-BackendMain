const mongoose = require("mongoose");

const inventoryTransactionSchema = new mongoose.Schema(
  {
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ingredient",
      required: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Kiosk/Cafe reference
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    changeQty: {
      type: Number,
      required: true,
    },
    changeType: {
      type: String,
      required: true,
      enum: ["purchase", "adjustment", "wastage", "consumption"],
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    cost: {
      type: Number,
      required: true,
      min: 0,
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
inventoryTransactionSchema.index({ ingredientId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ cartId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ franchiseId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ changeType: 1 });
inventoryTransactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model("InventoryTransaction", inventoryTransactionSchema);




