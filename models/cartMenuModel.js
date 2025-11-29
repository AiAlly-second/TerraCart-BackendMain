const mongoose = require("mongoose");

const cartMenuItemSchema = new mongoose.Schema(
  {
    // Cart reference
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cart",
      required: true,
      index: true,
    },
    // Franchise reference (for validation)
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    // Source tracking (for reference, not dependency)
    sourceFranchiseMenuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FranchiseMenuItem",
    },
    // Item data (independent copy)
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    isAvailable: { type: Boolean, default: true }, // Cart admin can toggle this
    image: { type: String },
    // Metadata
    tags: [{ type: String }],
    allergens: [{ type: String }],
    calories: { type: Number, min: 0 },
    spiceLevel: {
      type: String,
      enum: ["NONE", "MILD", "MEDIUM", "HOT", "EXTREME"],
      default: "NONE",
    },
    sortOrder: { type: Number, default: 0 },
    // Availability override (cart-specific)
    cartAvailabilityOverride: { type: Boolean }, // null = use franchise setting
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
cartMenuItemSchema.index({ cartId: 1, category: 1 });
cartMenuItemSchema.index({ cartId: 1, isAvailable: 1 });
cartMenuItemSchema.index({ franchiseId: 1, cartId: 1 }); // For validation
cartMenuItemSchema.index({ cartId: 1, sortOrder: 1 });

module.exports = mongoose.model("CartMenuItem", cartMenuItemSchema);















