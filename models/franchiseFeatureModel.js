const mongoose = require("mongoose");

const franchiseFeatureSchema = new mongoose.Schema({
  franchiseAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  featureKey: { type: String, required: true, trim: true, lowercase: true },
  enabled: { type: Boolean, required: true, default: false },
  reconciliationRequired: { type: Boolean, default: false },
  disabledAt: { type: Date, default: null },
  enabledAt: { type: Date, default: null },
  reconciledAt: { type: Date, default: null },
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  surfaces: {
    adminWeb: { type: Boolean, required: true, default: false },
    staffMobile: { type: Boolean, required: true, default: false },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

franchiseFeatureSchema.index({ franchiseAdminId: 1, featureKey: 1 }, { unique: true });

module.exports = mongoose.model("FranchiseFeature", franchiseFeatureSchema);
