const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  franchiseAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  disabledAt: { type: Date, required: true },
  cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: "IngredientV2", default: null },
  legacyItemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", default: null },
  physicalQty: { type: Number, required: true, min: 0 },
  previousQty: { type: Number, required: true },
  countedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  note: { type: String, required: true },
}, { timestamps: true });
schema.index({ franchiseAdminId: 1, disabledAt: 1, cartId: 1, ingredientId: 1, legacyItemId: 1 }, { unique: true });
module.exports = mongoose.model("InventoryReconciliationCount", schema);
