const mongoose = require("mongoose");

/**
 * Inventory Transaction Model - v2
 * Tracks all inventory movements with FIFO cost allocation
 */
const inventoryTransactionSchema = new mongoose.Schema(
  {
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IngredientV2",
      required: true,
    },
    type: {
      type: String,
      enum: ["IN", "OUT", "WASTE", "ADJUSTMENT"],
      required: true,
    },
    qty: {
      type: Number,
      required: true,
    },
    uom: {
      type: String,
      required: true,
    },
    refType: {
      type: String,
      enum: ["purchase", "recipe", "waste", "adjustment", "manual", "order"],
      default: "manual",
    },
    refId: {
      type: mongoose.Schema.Types.Mixed, // Can be ObjectId (for purchases) or String (for orders)
      default: null,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    costAllocated: {
      type: Number,
      required: true,
      min: 0,
      default: 0, // Cost allocated using FIFO
    },
    notes: {
      type: String,
      default: "",
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
inventoryTransactionSchema.index({ ingredientId: 1, date: -1 });
inventoryTransactionSchema.index({ type: 1 });
inventoryTransactionSchema.index({ date: -1 });
inventoryTransactionSchema.index({ refType: 1, refId: 1 });
inventoryTransactionSchema.index({ outletId: 1 });

module.exports = mongoose.model("InventoryTransactionV2", inventoryTransactionSchema);


