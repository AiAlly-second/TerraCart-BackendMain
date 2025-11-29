const mongoose = require("mongoose");

const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING", "MERGED"];

const tableSchema = new mongoose.Schema(
  {
    number: {
      type: Number,
      required: true,
      min: 1,
    },
    tableNumber: {
      type: String,
      sparse: true,
    },
    name: {
      type: String,
      trim: true,
    },
    capacity: {
      type: Number,
      default: 2,
      min: 1,
    },
    status: {
      type: String,
      enum: TABLE_STATUSES,
      default: "AVAILABLE",
    },
    qrSlug: {
      type: String,
      required: true,
      unique: true,
    },
    qrToken: {
      type: String,
      unique: true,
      sparse: true,
    },
    sessionToken: {
      type: String,
      index: true,
      sparse: true,
    },
    currentOrder: {
      type: String,
      ref: "Order",
      default: null,
    },
    lastAssignedAt: Date,
    notes: {
      type: String,
      trim: true,
    },
    // Cafe admin association for data isolation
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Franchise association - tables belong to franchises through cafes
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Table merging functionality
    mergedWith: { type: mongoose.Schema.Types.ObjectId, ref: "Table", default: null }, // Table this is merged with
    mergedTables: [{ type: mongoose.Schema.Types.ObjectId, ref: "Table" }], // Tables merged into this one
  },
  { timestamps: true }
);

tableSchema.index({ sessionToken: 1 }, { sparse: true, name: "sessionToken_1" });

// Compound unique index: number must be unique per cartId
// For cafe admins: { number: 1, cartId: 1 } must be unique
// For non-cafe admins: number must be globally unique (cartId is null/undefined)
tableSchema.index({ number: 1, cartId: 1 }, { unique: true, sparse: true });

module.exports = {
  Table: mongoose.model("Table", tableSchema),
  TABLE_STATUSES,
};



