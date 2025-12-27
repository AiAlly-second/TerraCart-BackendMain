const mongoose = require("mongoose");

/**
 * Labour Cost Model - v2
 * Tracks labour costs with allocation methods
 */
const labourCostSchema = new mongoose.Schema(
  {
    periodFrom: {
      type: Date,
      required: true,
    },
    periodTo: {
      type: Date,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    allocationMethod: {
      type: String,
      enum: ["revenue_percent", "item_count", "fixed_period"],
      required: true,
    },
    meta: {
      // For revenue_percent: { percent: 15 }
      // For item_count: { costPerItem: 5 }
      // For fixed_period: {}
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: new Map(),
    },
    description: {
      type: String,
      default: "",
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // Required - labour costs are cart-specific
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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

// Indexes
labourCostSchema.index({ periodFrom: 1, periodTo: 1 });
labourCostSchema.index({ cartId: 1 });

module.exports = mongoose.model("LabourCost", labourCostSchema);

