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
    // Cart ID if it's cart-specific (changed from cafeId to cartId)
    cartId: {
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

// Index to ensure one active QR per cart/user
paymentQrSchema.index({ userId: 1, isActive: 1 });
paymentQrSchema.index({ cartId: 1, isActive: 1 }); // Changed from cafeId to cartId

module.exports = mongoose.model("PaymentQR", paymentQrSchema);

