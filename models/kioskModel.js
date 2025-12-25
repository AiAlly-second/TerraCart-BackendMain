const mongoose = require("mongoose");

const kioskSchema = new mongoose.Schema(
  {
    kioskOwnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KioskOwner",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    location: {
      address: { type: String, required: true },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      coordinates: {
        latitude: { type: Number },
        longitude: { type: Number },
      },
    },
    gstNumber: { type: String },
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Kiosk", kioskSchema);













