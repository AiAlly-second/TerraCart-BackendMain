const mongoose = require("mongoose");

const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    mobile: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true, sparse: true }, // Email for login access
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
        // Cafe-level roles
        "waiter", "chef", "manager", "cashier", "cleaner",
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
    // Status
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Employee", employeeSchema);

