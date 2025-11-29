const mongoose = require("mongoose");

const franchiseSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    franchiseAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    address: { type: String },
    phone: { type: String },
    email: { type: String },
    // Menu tracking
    menuInitialized: { type: Boolean, default: false },
    menuInitializedAt: { type: Date },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Indexes
franchiseSchema.index({ franchiseAdminId: 1 });
franchiseSchema.index({ isActive: 1 });

module.exports = mongoose.model("Franchise", franchiseSchema);















