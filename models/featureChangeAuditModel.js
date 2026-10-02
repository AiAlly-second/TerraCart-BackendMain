const mongoose = require("mongoose");

const featureChangeAuditSchema = new mongoose.Schema({
  featureKey: { type: String, required: true, trim: true, lowercase: true },
  scope: { type: String, required: true, enum: ["platform", "franchise"] },
  franchiseAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  previousState: { type: mongoose.Schema.Types.Mixed, default: null },
  newState: { type: mongoose.Schema.Types.Mixed, required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  actorType: { type: String, enum: ["user", "system"], required: true },
  operationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });

featureChangeAuditSchema.index({ featureKey: 1, scope: 1, franchiseAdminId: 1, createdAt: -1 });
featureChangeAuditSchema.pre("save", function () {
  if (!this.isNew) throw new Error("Feature audit records are immutable");
});

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete"]) {
  featureChangeAuditSchema.pre(operation, function () {
    throw new Error("Feature audit records are immutable");
  });
}

module.exports = mongoose.model("FeatureChangeAudit", featureChangeAuditSchema);
