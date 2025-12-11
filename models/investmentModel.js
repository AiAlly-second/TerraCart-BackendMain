const mongoose = require("mongoose");

const investmentSchema = new mongoose.Schema(
  {
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    kioskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      required: true,
      enum: [
        "Equipment",
        "Infrastructure",
        "Marketing",
        "Technology",
        "Furniture",
        "License",
        "Other",
      ],
    },
    description: {
      type: String,
      default: "",
    },
    purchaseDate: {
      type: Date,
      required: true,
    },
    vendor: {
      type: String,
      default: "",
    },
    invoicePath: {
      type: String,
      default: null,
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
investmentSchema.index({ franchiseId: 1, purchaseDate: -1 });
investmentSchema.index({ kioskId: 1, purchaseDate: -1 });
investmentSchema.index({ category: 1 });

module.exports = mongoose.model("Investment", investmentSchema);

















