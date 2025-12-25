const mongoose = require("mongoose");

const customerRequestSchema = new mongoose.Schema(
  {
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      index: true,
    },
    orderId: {
      type: String,
      ref: "Order",
      index: true,
    },
    requestType: {
      type: String,
      enum: [
        "water",
        "bill",
        "menu",
        "cutlery",
        "napkins",
        "assistance",
        "complaint",
        "other",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "acknowledged", "resolved", "cancelled"],
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
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    notes: { type: String },
    customerNotes: { type: String }, // Notes from customer
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
customerRequestSchema.index({ cartId: 1, status: 1 }); // Changed from cafeId to cartId
customerRequestSchema.index({ assignedTo: 1, status: 1 });
customerRequestSchema.index({ assignedToUser: 1, status: 1 });
customerRequestSchema.index({ franchiseId: 1, status: 1 });
customerRequestSchema.index({ tableId: 1, status: 1 });
customerRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("CustomerRequest", customerRequestSchema);

