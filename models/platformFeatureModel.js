const mongoose = require("mongoose");

const platformFeatureSchema = new mongoose.Schema({
  featureKey: { type: String, required: true, trim: true, lowercase: true, unique: true },
  enabled: { type: Boolean, required: true, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

module.exports = mongoose.model("PlatformFeature", platformFeatureSchema);
