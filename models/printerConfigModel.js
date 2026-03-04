const mongoose = require("mongoose");

const printerConfigSchema = new mongoose.Schema(
  {
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Legacy/default printer fields (kept for backward compatibility)
    printerIp: { type: String, default: "" },
    printerPort: { type: Number, default: 9100 },
    // Dedicated printer endpoints for simultaneous KOT + BILL printing
    kotPrinterIp: { type: String, default: "" },
    kotPrinterPort: { type: Number, default: 9100 },
    billPrinterIp: { type: String, default: "" },
    billPrinterPort: { type: Number, default: 9100 },
    businessName: { type: String, default: "TERRA CART" },
    kotHeaderText: { type: String, default: "" },
    billHeaderText: { type: String, default: "" },
    centerAlign: { type: Boolean, default: true },
    /** Who prints KOTs: APP = TerraAdmin Flutter app (default); AGENT = Local Print Bridge only. */
    printAuthority: { type: String, enum: ["AGENT", "APP"], default: "APP" },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PrinterConfig", printerConfigSchema);
