const mongoose = require("mongoose");

const kioskOwnerSchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true },
    ownerName: { type: String, required: true },
    gstNumber: { type: String },
    registrationId: { type: String },
    udyamCertificate: { type: String }, // File path or URL
    healthSafetyCertificate: { type: String }, // File path or URL
    otherCompliances: [
      {
        name: { type: String },
        certificate: { type: String }, // File path or URL
        expiryDate: { type: Date },
      },
    ],
    registeredAddress: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: "India" },
    },
    contact: {
      email: { type: String },
      phone: { type: String },
      alternatePhone: { type: String },
    },
    // Hierarchy relationships
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("KioskOwner", kioskOwnerSchema);













