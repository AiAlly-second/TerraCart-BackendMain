const mongoose = require("mongoose");

/**
 * Inventory Transaction Model - v2
 * Tracks all inventory movements with weighted average cost allocation
 * All quantities are stored in both original unit and base unit for accurate calculations
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
      enum: ["IN", "OUT", "WASTE", "ADJUSTMENT", "RETURN"], // Added RETURN type
      required: true,
    },
    // Original quantity and unit (as entered by user)
    qty: {
      type: Number,
      required: true,
    },
    uom: {
      type: String,
      required: true,
    },
    // Quantity in base unit (g, ml, or pcs) - for accurate calculations
    qtyInBaseUnit: {
      type: Number,
      required: true,
      // This is the converted quantity in base unit
    },
    // Reference to the original transaction if this is a return
    originalTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryTransactionV2",
      default: null,
      // Used to track which transaction is being returned
    },
    refType: {
      type: String,
      enum: ["purchase", "recipe", "waste", "adjustment", "manual", "order", "return"],
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
      default: 0, // Cost allocated using weighted average
    },
    // Store exact purchase price per unit (for purchase transactions)
    // This ensures inventory price matches purchase price exactly
    unitPrice: {
      type: Number,
      default: null, // Only set for purchase transactions (type: "IN", refType: "purchase")
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
    cartId: {
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
inventoryTransactionSchema.index({ cartId: 1 });
inventoryTransactionSchema.index({ originalTransactionId: 1 }); // For tracking returns

module.exports = mongoose.model("InventoryTransactionV2", inventoryTransactionSchema);


