const mongoose = require("mongoose");

const complianceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["license", "certificate", "permit", "document", "insurance", "tax", "other"],
      default: "document",
      index: true,
    },
    expiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["valid", "expiring_soon", "expired", "renewal_pending"],
      default: "valid",
      index: true,
    },
    documentUrl: {
      type: String,
      trim: true,
    },
    renewalDate: {
      type: Date,
    },
    renewalReminderDays: {
      type: Number,
      default: 30, // Days before expiry to send reminder
    },
    notes: {
      type: String,
      trim: true,
    },
    lastRenewedAt: {
      type: Date,
    },
    // Hierarchy relationships for data isolation
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
complianceSchema.index({ cafeId: 1, status: 1, expiryDate: 1 });
complianceSchema.index({ franchiseId: 1, type: 1 });
complianceSchema.index({ expiryDate: 1, status: 1 });

// Virtual for checking if compliance is expiring soon
complianceSchema.virtual("isExpiringSoon").get(function () {
  if (!this.expiryDate) return false;
  const daysUntilExpiry = Math.ceil((this.expiryDate - new Date()) / (1000 * 60 * 60 * 24));
  return daysUntilExpiry <= this.renewalReminderDays && daysUntilExpiry > 0;
});

// Pre-save middleware to update status based on expiry date
complianceSchema.pre("save", function (next) {
  if (this.expiryDate) {
    const now = new Date();
    const daysUntilExpiry = Math.ceil((this.expiryDate - now) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiry < 0) {
      this.status = "expired";
    } else if (daysUntilExpiry <= this.renewalReminderDays) {
      this.status = "expiring_soon";
    } else {
      this.status = "valid";
    }
  }
  next();
});

module.exports = mongoose.model("Compliance", complianceSchema);

