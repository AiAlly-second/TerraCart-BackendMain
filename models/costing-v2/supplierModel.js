const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    contact: {
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      person: { type: String, trim: true }, // Contact person name
    },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
    },
    paymentTerms: {
      type: String,
      enum: ["COD", "Net 15", "Net 30", "Net 45", "Net 60", "Advance", "Other"],
      default: "Net 30",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      default: "",
    },
    // Cart association (required - suppliers are cart-specific)
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
supplierSchema.index({ name: 1 });
supplierSchema.index({ "contact.email": 1 });
supplierSchema.index({ isActive: 1 });
supplierSchema.index({ cartId: 1 });
supplierSchema.index({ franchiseId: 1 });

module.exports = mongoose.model("Supplier", supplierSchema);




