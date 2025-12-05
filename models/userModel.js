const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["super_admin", "franchise_admin", "admin", "cart_admin", "manager", "captain", "waiter", "cook", "employee", "customer"],
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
    address: { type: String },
    cartName: { type: String },
    isApproved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    // Franchise relationship - cart admins belong to a franchise
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Active/Inactive status for franchises (default: true for new franchises)
    isActive: { type: Boolean, default: true, index: true },
    // Franchise admin specific fields
    mobile: { type: String }, // Mobile number for franchise admin
    gstNumber: { type: String }, // GST number
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
    // Tasks array for waiters and other mobile roles
    tasks: [{
      title: { type: String, required: true },
      description: { type: String, default: "" },
      category: { 
        type: String, 
        enum: ["daily", "weekly", "monthly", "cleaning", "inventory", "preparation", "safety", "finance", "other"],
        default: "daily"
      },
      frequency: {
        type: String,
        enum: ["daily", "weekly", "monthly", "one_time"],
        default: "daily"
      },
      status: {
        type: String,
        enum: ["incomplete", "complete"],
        default: "incomplete"
      },
      priority: {
        type: String,
        enum: ["low", "medium", "high"],
        default: "medium"
      },
      completedAt: { type: Date },
      completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }],
    // Emergency contacts for mobile roles
    emergencyContacts: [{
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String },
      relationship: { type: String }, // e.g., "Spouse", "Parent", "Friend", etc.
      isPrimary: { type: Boolean, default: false },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    }],
  },
  { timestamps: true }
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
