const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    kioskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    expenseCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseCategory",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: "",
    },
    expenseDate: {
      type: Date,
      required: true,
      index: true,
    },
    paymentMode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank Transfer", "Cheque", "Other"],
      default: "Cash",
    },
    invoicePath: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
expenseSchema.index({ franchiseId: 1, expenseDate: -1 });
expenseSchema.index({ kioskId: 1, expenseDate: -1 });
expenseSchema.index({ expenseCategoryId: 1 });
expenseSchema.index({ expenseDate: -1 });

module.exports = mongoose.model("Expense", expenseSchema);





