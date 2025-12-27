const mongoose = require("mongoose");

/**
 * Expense Model - v2
 * Comprehensive expense tracking for all operational costs
 */
const expenseSchema = new mongoose.Schema(
  {
    expenseDate: {
      type: Date,
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      enum: [
        "rent",
        "utilities", // Electricity, Water, Gas
        "salaries", // Staff salaries
        "marketing", // Advertising, promotions
        "maintenance", // Repairs, equipment maintenance
        "insurance", // Business insurance
        "licenses", // FSSAI, Shop Act, GST renewals
        "supplies", // Non-food supplies (cleaning, packaging)
        "transport", // Delivery, logistics
        "communication", // Phone, internet
        "professional", // Legal, accounting, consulting
        "depreciation", // Asset depreciation
        "bank_charges", // Transaction fees, interest
        "miscellaneous", // Other expenses
      ],
      required: true,
      index: true,
    },
    subCategory: {
      type: String,
      default: "", // e.g., "Electricity" under utilities, "Facebook Ads" under marketing
    },
    description: {
      type: String,
      default: "",
    },
    paymentMode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank Transfer", "Cheque", "Credit", "Other"],
      default: "Cash",
    },
    vendor: {
      type: String,
      default: "", // Vendor/supplier name
    },
    invoiceNumber: {
      type: String,
      default: "", // Invoice/bill number
    },
    isRecurring: {
      type: Boolean,
      default: false, // Recurring expense (rent, salaries, etc.)
    },
    recurringFrequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "quarterly", "yearly", ""],
      default: "",
    },
    budgetedAmount: {
      type: Number,
      default: null, // Budgeted amount for comparison
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // Required - expenses are cart-specific
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    attachments: [
      {
        fileName: String,
        filePath: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
expenseSchema.index({ expenseDate: -1 });
expenseSchema.index({ cartId: 1, expenseDate: -1 });
expenseSchema.index({ franchiseId: 1, expenseDate: -1 });
expenseSchema.index({ category: 1, expenseDate: -1 });
expenseSchema.index({ isRecurring: 1 });

module.exports = mongoose.model("CostingExpense", expenseSchema);

