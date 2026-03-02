const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: [
        "super_admin",
        "franchise_admin",
        "admin",
        "employee",
        "customer",
        "waiter",
        "cook",
        "captain",
        "manager",
      ],
      default: "customer",
    },

    // ===== FRANCHISE ID SYSTEM =====
    // Franchise Code: 3-letter shortcut from franchise name (e.g., "MAH" for "Mahindra")
    franchiseShortcut: { type: String, uppercase: true, maxlength: 3 },
    // Full Franchise ID: shortcut + sequence number (e.g., "MAH001", "ABC002")
    franchiseCode: { type: String, unique: true, sparse: true, index: true },
    // Sequence number for this franchise (1, 2, 3...)
    franchiseSequence: { type: Number },

    // ===== CART ID SYSTEM =====
    // Full Cart ID: franchise shortcut + cart sequence (e.g., "MAH001", "MAH002")
    cartCode: { type: String, unique: true, sparse: true, index: true },
    // Sequence number for cart within franchise (1, 2, 3...)
    cartSequence: { type: Number },

    // Cart admin specific fields
    location: { type: String },
    phone: { type: String },
    managerHelplineNumber: { type: String },
    emergencyContacts: [
      {
        name: { type: String },
        phone: { type: String },
        relation: { type: String },
        notes: { type: String },
        isPrimary: { type: Boolean, default: false },
      },
    ],
    address: { type: String },
    cartName: { type: String },
    isApproved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    // Franchise relationship - cart admins belong to a franchise
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    // Mobile app user fields - link to Employee and Cart/Kiosk
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      sparse: true,
    }, // Cart/Kiosk ID for mobile users
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      index: true,
      sparse: true,
    }, // Employee record for mobile users
    // Active/Inactive status for franchises (default: true for new franchises)
    isActive: { type: Boolean, default: true, index: true },
    // Franchise admin specific fields
    mobile: { type: String }, // Mobile number for franchise admin
    fssaiNumber: { type: String }, // FSSAI number (replaced GST)
    gstNumber: { type: String }, // Deprecated: Old GST number, kept for backward compatibility
    udyamCertificate: { type: String }, // File path for Udyam certificate
    aadharCard: { type: String }, // File path for Aadhar card
    panCard: { type: String }, // File path for PAN card
    // Cart admin specific document fields
    gstCertificate: { type: String }, // File path for GST Certificate
    shopActLicense: { type: String }, // File path for Shop Act License
    fssaiLicense: { type: String }, // File path for FSSAI License
    electricityBill: { type: String }, // File path for Electricity Bill (address proof)
    rentAgreement: { type: String }, // File path for Rent Agreement (address proof)
    // Document expiry dates (optional) - only for documents that can expire
    gstCertificateExpiry: { type: Date },
    shopActLicenseExpiry: { type: Date },
    fssaiLicenseExpiry: { type: Date },
    resetPasswordExpire: Date,
    // API Keys for external integrations (like Fabric)
    apiKeys: [
      {
        key: { type: String, required: true }, // The actual key (e.g. "tc_live_...")
        name: { type: String, default: "Default" }, // Label (e.g. "Fabric Dashboard")
        createdAt: { type: Date, default: Date.now },
        lastUsed: { type: Date },
      },
    ],
    // Printer Configuration for Local Print Agent
    printerSettings: {
      ip: { type: String, default: "192.168.1.151" },
      port: { type: Number, default: 9100 },
      enabled: { type: Boolean, default: true },
    },
    // Firebase Cloud Messaging token (latest device token)
    fcmToken: { type: String, trim: true, default: null, index: true, sparse: true },
    fcmTokenPlatform: {
      type: String,
      enum: ["android", "ios", "web", "unknown"],
      default: "unknown",
    },
    fcmTokenUpdatedAt: { type: Date, default: null },
    // Token version for logout from all devices
    // Incrementing this invalidates all existing tokens
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next();
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
