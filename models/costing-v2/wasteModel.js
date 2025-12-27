const mongoose = require("mongoose");

/**
 * Waste Model - v2
 * Records ingredient waste with reasons
 */
const wasteSchema = new mongoose.Schema(
  {
    ingredientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IngredientV2",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 0,
    },
    uom: {
      type: String,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      enum: [
        "spoilage",
        "overcooking",
        "expired",
        "damaged",
        "spillage",
        "portion_error",
        "other",
      ],
    },
    reasonDetails: {
      type: String,
      default: "",
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
      default: 0, // Cost from FIFO
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
wasteSchema.index({ ingredientId: 1, date: -1 });
wasteSchema.index({ date: -1 });
wasteSchema.index({ cartId: 1 });

module.exports = mongoose.model("Waste", wasteSchema);




