const mongoose = require("mongoose");

/**
 * Global Add-ons Model
 * These are add-ons that can be selected with any order (not item-specific)
 * Examples: Extra Napkins, Extra Spicy, Special Packaging, etc.
 */
const addonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    icon: {
      type: String, // Emoji or icon identifier
      default: "",
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    // Cart admin association for data isolation
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    // Franchise association
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
addonSchema.index({ cartId: 1, isAvailable: 1 });
addonSchema.index({ franchiseId: 1, isAvailable: 1 });
addonSchema.index({ cartId: 1, sortOrder: 1 });

const Addon = mongoose.model("Addon", addonSchema);

module.exports = Addon;

