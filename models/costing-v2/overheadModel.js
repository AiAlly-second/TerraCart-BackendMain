const mongoose = require("mongoose");

/**
 * Overhead Model - v2
 * Tracks overhead costs with allocation methods
 */
const overheadSchema = new mongoose.Schema(
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
      // For revenue_percent: { percent: 10 }
      // For item_count: { costPerItem: 2 }
      // For fixed_period: {}
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: new Map(),
    },
    category: {
      type: String,
      enum: [
        "rent",
        "utilities",
        "insurance",
        "marketing",
        "maintenance",
        "depreciation",
        "other",
      ],
      default: "other",
    },
    description: {
      type: String,
      default: "",
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // Required - overheads are cart-specific
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
overheadSchema.index({ periodFrom: 1, periodTo: 1 });
overheadSchema.index({ cartId: 1 });
overheadSchema.index({ category: 1 });

module.exports = mongoose.model("Overhead", overheadSchema);

