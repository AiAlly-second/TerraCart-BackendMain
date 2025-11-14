const mongoose = require("mongoose");

const paymentQrSchema = new mongoose.Schema(
  {
    // Link to cafe/admin user (optional - can be global)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      sparse: true,
    },
    // Cafe ID if it's cafe-specific
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      sparse: true,
    },
    // QR code image URL/path
    qrImageUrl: {
      type: String,
      required: true,
    },
    // UPI ID/VPA (optional - for reference)
    upiId: {
      type: String,
      trim: true,
    },
    // Payment gateway name (optional)
    gatewayName: {
      type: String,
      trim: true,
    },
    // Is active
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index to ensure one active QR per cafe/user
paymentQrSchema.index({ userId: 1, isActive: 1 });
paymentQrSchema.index({ cafeId: 1, isActive: 1 });

module.exports = mongoose.model("PaymentQR", paymentQrSchema);

