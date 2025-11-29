const mongoose = require("mongoose");

const globalMenuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 }, // Percentage
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
    // Created by
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Indexes for performance
globalMenuItemSchema.index({ category: 1, isAvailable: 1 });
globalMenuItemSchema.index({ createdBy: 1 });
globalMenuItemSchema.index({ sortOrder: 1 });

module.exports = mongoose.model("GlobalMenuItem", globalMenuItemSchema);















