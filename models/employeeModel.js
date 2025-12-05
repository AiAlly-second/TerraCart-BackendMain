const mongoose = require("mongoose");

const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    mobile: { type: String, required: true },
    // Optional email, kept in sync with linked User for convenience in admin UIs
    email: { type: String },
    documents: {
      aadhar: { type: String },
      pan: { type: String },
      otherDocuments: [{ type: String }],
    },
    kycVerified: { type: Boolean, default: false },
    disability: {
      hasDisability: { type: Boolean, default: false },
      type: { type: String },
    },
    deviceIssued: {
      smartwatch: { type: Boolean, default: false },
      tracker: { type: Boolean, default: false },
    },
    imei: {
      device: { type: String },
      phone: { type: String },
    },
    employeeRole: {
      type: String,
      enum: [
        // Cafe-level roles (unified with User model)
        "waiter", "cook", "captain", "manager", 
        // Legacy roles (for backward compatibility)
        "chef", "cashier", "cleaner",
        // Franchise-level roles
        "franchise_manager", "area_manager", "supervisor", "accountant", 
        "hr_manager", "operations_manager", "quality_auditor", "training_coordinator",
        "other"
      ],
      required: true,
    },
    // Hierarchy relationships
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Link to User document for login access
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Employee", employeeSchema);

