const mongoose = require("mongoose");

const cartSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    cartAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    location: { type: String },
    // Menu tracking
    menuInitialized: { type: Boolean, default: false },
    menuInitializedAt: { type: Date },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Compound index for efficient queries
cartSchema.index({ franchiseId: 1, isActive: 1 });
cartSchema.index({ cartAdminId: 1 });

module.exports = mongoose.model("Cart", cartSchema);















