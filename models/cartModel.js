const mongoose = require("mongoose");

const cartSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
      required: true,
      index: true,
    },
    cartAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    location: { type: String },
    pinCode: { type: String }, // Pin code for easier location search and geocoding
    // Address for pickup/delivery
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      zipCode: { type: String },
      country: { type: String, default: "India" },
      fullAddress: { type: String }, // Complete formatted address
    },
    // Location coordinates for distance calculation
    coordinates: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
    // Order fulfillment options
    pickupEnabled: { type: Boolean, default: true },
    deliveryEnabled: { type: Boolean, default: false },
    deliveryRadius: { type: Number, default: 5 }, // Maximum delivery radius in km
    deliveryCharge: { type: Number, default: 0 }, // Delivery charge in rupees
    // Menu tracking
    menuInitialized: { type: Boolean, default: false },
    menuInitializedAt: { type: Date },
    // Contact us (shown on customer menu page)
    contactPhone: { type: String, trim: true },
    contactEmail: { type: String, trim: true },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Compound index for efficient queries
cartSchema.index({ franchiseId: 1, isActive: 1 });
cartSchema.index({ cartAdminId: 1 });

module.exports = mongoose.model("Cart", cartSchema);
