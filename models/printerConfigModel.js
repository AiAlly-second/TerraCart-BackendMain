const mongoose = require("mongoose");

const printerConfigSchema = new mongoose.Schema(
  {
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    printerIp: { type: String, required: true },
    printerPort: { type: Number, default: 9100 },
    businessName: { type: String, default: "TERRA CART" },
    kotHeaderText: { type: String, default: "" },
    billHeaderText: { type: String, default: "" },
    centerAlign: { type: Boolean, default: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PrinterConfig", printerConfigSchema);
