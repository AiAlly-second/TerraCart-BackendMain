const mongoose = require("mongoose");

const franchiseMenuItemSchema = new mongoose.Schema(
  {
    // Franchise reference
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    // Source tracking (for reference, not dependency)
    sourceGlobalMenuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GlobalMenuItem",
    },
    // Item data (independent copy)
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    isAvailable: { type: Boolean, default: true },
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
    // Custom flag (true if added by franchise admin, not from global)
    isCustom: { type: Boolean, default: false },
    // Updated by
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
franchiseMenuItemSchema.index({ franchiseId: 1, category: 1 });
franchiseMenuItemSchema.index({ franchiseId: 1, isAvailable: 1 });
franchiseMenuItemSchema.index({ franchiseId: 1, isCustom: 1 });
franchiseMenuItemSchema.index({ franchiseId: 1, sortOrder: 1 });

module.exports = mongoose.model("FranchiseMenuItem", franchiseMenuItemSchema);















