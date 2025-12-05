const mongoose = require("mongoose");

const customerRequestSchema = new mongoose.Schema(
  {
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      index: true,
    },
    requestType: {
      type: String,
      required: true,
      enum: ["service", "bill", "complaint", "assistance", "menu", "water", "cutlery", "other"],
      default: "service",
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "acknowledged", "in_progress", "resolved", "cancelled"],
      default: "pending",
      index: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      index: true,
    },
    assignedToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },
    acknowledgedAt: {
      type: Date,
    },
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    resolvedAt: {
      type: Date,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    resolutionNotes: {
      type: String,
      trim: true,
    },
    // Hierarchy relationships for data isolation
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
customerRequestSchema.index({ cafeId: 1, status: 1, createdAt: -1 });
customerRequestSchema.index({ assignedTo: 1, status: 1 });
customerRequestSchema.index({ tableId: 1, status: 1 });
customerRequestSchema.index({ requestType: 1, status: 1 });

module.exports = mongoose.model("CustomerRequest", customerRequestSchema);

