const mongoose = require("mongoose");

const revenueHistorySchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },
    periodType: {
      type: String,
      enum: ["daily", "monthly"],
      required: true,
      index: true,
    },
    // Total revenue for the period
    totalRevenue: {
      type: Number,
      required: true,
      default: 0,
    },
    // Revenue breakdown by franchise
    franchiseRevenue: [
      {
        franchiseId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        franchiseName: String,
        revenue: {
          type: Number,
          default: 0,
        },
        cafeCount: {
          type: Number,
          default: 0,
        },
        cartCount: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Revenue breakdown by cart (changed from cafeRevenue to cartRevenue, cafeId to cartId)
    cartRevenue: [
      {
        cartId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        cartName: String,
        franchiseId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        franchiseName: String,
        revenue: {
          type: Number,
          default: 0,
        },
        orderCount: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Statistics
    totalOrders: {
      type: Number,
      default: 0,
    },
    totalPayments: {
      type: Number,
      default: 0,
    },
    // Metadata
    calculatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
revenueHistorySchema.index({ date: 1, periodType: 1 }, { unique: true });

module.exports = mongoose.model("RevenueHistory", revenueHistorySchema);

