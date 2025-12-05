const mongoose = require("mongoose");

/**
 * Expense Category Model - v2
 * Master list of expense categories with budgets
 */
const expenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true, // e.g., "RENT", "UTILITIES"
    },
    description: {
      type: String,
      default: "",
    },
    parentCategory: {
      type: String,
      enum: [
        "rent",
        "utilities",
        "salaries",
        "marketing",
        "maintenance",
        "insurance",
        "licenses",
        "supplies",
        "transport",
        "communication",
        "professional",
        "depreciation",
        "bank_charges",
        "miscellaneous",
      ],
      default: null,
    },
    monthlyBudget: {
      type: Number,
      default: null, // Monthly budget for this category
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // null = global category, specific ID = outlet-specific
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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

// Indexes
expenseCategorySchema.index({ code: 1 });
expenseCategorySchema.index({ parentCategory: 1 });
expenseCategorySchema.index({ outletId: 1 });
expenseCategorySchema.index({ isActive: 1 });

module.exports = mongoose.model("CostingExpenseCategory", expenseCategorySchema);

