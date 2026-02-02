const Investment = require("../models/investmentModel");
const Expense = require("../models/expenseModel");
const ExpenseCategory = require("../models/expenseCategoryModel");
const Ingredient = require("../models/ingredientModel");
const Recipe = require("../models/recipeModel");
const RecipeIngredient = require("../models/recipeIngredientModel");
const InventoryTransaction = require("../models/inventoryTransactionModel");
const IngredientPurchase = require("../models/ingredientPurchaseModel");
const OutletOPEX = require("../models/outletOPEXModel");
const OutletAsset = require("../models/outletAssetModel");
const Order = require("../models/orderModel");
const { MenuItem } = require("../models/menuItemModel");
const User = require("../models/userModel");
const InventoryTransactionV2 = require("../models/costing-v2/inventoryTransactionModel");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { getFileUrl } = require("../config/uploadConfig");

// ==================== DASHBOARD ====================

/**
 * @route   GET /api/admin/costing/dashboard
 * @desc    Get costing dashboard KPIs
 * @access  Private (Super Admin only)
 */
exports.getDashboard = async (req, res) => {
  try {
    const { startDate, endDate, franchiseId, kioskId } = req.query;
    const userRole = req.user.role;
    const userId = req.user._id;

    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    // Build scope filters
    // scopeFilter uses 'kioskId' (for Investment, Expense)
    // cartScopeFilter uses 'cartId' (for Order, InventoryTransaction)
    const scopeFilter = {};
    const cartScopeFilter = {};
    
    if (userRole === "super_admin") {
      if (franchiseId) {
        scopeFilter.franchiseId = franchiseId;
        cartScopeFilter.franchiseId = franchiseId;
      }
      if (kioskId) {
        scopeFilter.kioskId = kioskId;
        cartScopeFilter.cartId = kioskId;
      }
    } else if (userRole === "franchise_admin") {
      scopeFilter.franchiseId = userId;
      cartScopeFilter.franchiseId = userId;
      if (kioskId) {
        scopeFilter.kioskId = kioskId;
        cartScopeFilter.cartId = kioskId;
      }
    } else if (userRole === "admin" || userRole === "cart_admin") {
      scopeFilter.kioskId = userId;
      cartScopeFilter.cartId = userId;
    }

    // Calculate Total Investment (Uses kioskId)
    const investmentFilter = { ...scopeFilter, ...dateFilter };
    if (dateFilter.createdAt) {
      // Investments use purchaseDate usually, but let's stick to simple createdAt if that's what was used before, 
      // OR map dateFilter to purchaseDate if previously consistent.
      // Previous code used createdAt for dateFilter but Investments have purchaseDate.
      // Let's refine: Investment uses purchaseDate usually for filtering.
      // But purely for safety, let's look at previous implementation:
      // It merged query dateFilter (on createdAt) into investmentFilter.
      // Investment model has createdAt. So this is fine.
    }
    const totalInvestment = await Investment.aggregate([
      { $match: investmentFilter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const investmentSum = totalInvestment[0]?.total || 0;

    // Calculate Monthly Expenses (Uses kioskId)
    const expenseFilter = { ...scopeFilter };
    if (startDate || endDate) {
      expenseFilter.expenseDate = {};
      if (startDate) expenseFilter.expenseDate.$gte = new Date(startDate);
      if (endDate) expenseFilter.expenseDate.$lte = new Date(endDate);
    }
    const monthlyExpenses = await Expense.aggregate([
      { $match: expenseFilter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const expenseSum = monthlyExpenses[0]?.total || 0;

    // Calculate Food Cost % (COGS / Sales * 100)
    // Sales uses cartId (Order model)
    const orderFilter = { ...cartScopeFilter };
    if (startDate || endDate) {
      orderFilter.createdAt = {};
      if (startDate) orderFilter.createdAt.$gte = new Date(startDate);
      if (endDate) orderFilter.createdAt.$lte = new Date(endDate);
    }
    orderFilter.status = { $in: ["Paid", "Finalized"] };

    const salesData = await Order.aggregate([
      { $match: orderFilter },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalAmount" },
        },
      },
    ]);
    const totalSales = salesData[0]?.totalSales || 0;

    // Calculate COGS from inventory transactions (Uses cartId)
    // Must include scope!
    // V2 Implementation: Sum costAllocated for type='OUT' (consumption) and 'WASTE'
    const cogsFilter = { 
      ...cartScopeFilter
    };
    
    // Convert filter for V2 schema if needed
    // cartScopeFilter uses cartId which matches V2 schema
    
    // Date filter
    if (startDate || endDate) {
      cogsFilter.date = {}; // V2 uses 'date', not 'createdAt'
      if (startDate) cogsFilter.date.$gte = new Date(startDate);
      if (endDate) cogsFilter.date.$lte = new Date(endDate);
    }

    // Filter for consumption (OUT) and Wastage
    cogsFilter.type = { $in: ["OUT", "WASTE"] };
    // Optionally refine by refType if needed, e.g., refType: "order" for pure sales COGS
    // But generalized COGS usually includes all inventory outflows
    
    const cogsData = await InventoryTransactionV2.aggregate([
      { $match: cogsFilter },
      { $group: { _id: null, total: { $sum: "$costAllocated" } } },
    ]);
    const cogs = cogsData[0]?.total || 0;

    const foodCostPercentage = totalSales > 0 ? (cogs / totalSales) * 100 : 0;

    // Calculate Gross Profit (Sales - COGS - Expenses)
    const grossProfit = totalSales - cogs - expenseSum;

    // Calculate Breakeven months
    const avgMonthlyNetProfit = grossProfit / Math.max(1, getMonthsBetween(startDate, endDate));
    const breakevenMonths = avgMonthlyNetProfit > 0 ? investmentSum / avgMonthlyNetProfit : null;

    res.json({
      success: true,
      data: {
        totalInvestment: investmentSum,
        monthlyExpenses: expenseSum,
        foodCostPercentage: Number(foodCostPercentage.toFixed(2)),
        grossProfit: Number(grossProfit.toFixed(2)),
        breakevenMonths: breakevenMonths ? Number(breakevenMonths.toFixed(2)) : null,
        totalSales: totalSales,
        cogs: cogs, // Food Cost (COGS)
      },
    });
  } catch (error) {
    console.error("[COSTING] Dashboard error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard data",
      error: error.message,
    });
  }
};

// Helper function to calculate months between dates
function getMonthsBetween(startDate, endDate) {
  if (!startDate || !endDate) return 1;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(1, months || 1);
}

// ==================== INVESTMENTS ====================

/**
 * @route   GET /api/admin/costing/investments
 * @desc    Get all investments
 * @access  Private (Super Admin only)
 */
exports.getInvestments = async (req, res) => {
  try {
    const { franchiseId, kioskId, startDate, endDate, category } = req.query;
    const filter = {};

    if (franchiseId) filter.franchiseId = franchiseId;
    if (kioskId) filter.kioskId = kioskId;
    if (category) filter.category = category;
    if (startDate || endDate) {
      filter.purchaseDate = {};
      if (startDate) filter.purchaseDate.$gte = new Date(startDate);
      if (endDate) filter.purchaseDate.$lte = new Date(endDate);
    }

    const investments = await Investment.find(filter)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("createdBy", "name email")
      .sort({ purchaseDate: -1 });

    res.json({
      success: true,
      data: investments,
    });
  } catch (error) {
    console.error("[COSTING] Get investments error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch investments",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/investments/:id
 * @desc    Get single investment
 * @access  Private (Super Admin only)
 */
exports.getInvestment = async (req, res) => {
  try {
    const investment = await Investment.findById(req.params.id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("createdBy", "name email");

    if (!investment) {
      return res.status(404).json({
        success: false,
        message: "Investment not found",
      });
    }

    res.json({
      success: true,
      data: investment,
    });
  } catch (error) {
    console.error("[COSTING] Get investment error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch investment",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/investments
 * @desc    Create investment
 * @access  Private (Super Admin only)
 */
exports.createInvestment = async (req, res) => {
  try {
    const {
      franchiseId,
      kioskId,
      title,
      amount,
      category,
      description,
      purchaseDate,
      vendor,
    } = req.body;

    // Handle file upload
    let invoicePath = null;
    if (req.file) {
      invoicePath = getFileUrl(req, req.file, "invoices");
    }

    const investment = new Investment({
      franchiseId: franchiseId || null,
      kioskId: kioskId || null,
      title,
      amount,
      category,
      description: description || "",
      purchaseDate: new Date(purchaseDate),
      vendor: vendor || "",
      invoicePath: invoicePath,
      createdBy: req.user._id,
    });

    await investment.save();

    const populated = await Investment.findById(investment._id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create investment error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create investment",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/investments/:id
 * @desc    Update investment
 * @access  Private (Super Admin only)
 */
exports.updateInvestment = async (req, res) => {
  try {
    const investment = await Investment.findById(req.params.id);

    if (!investment) {
      return res.status(404).json({
        success: false,
        message: "Investment not found",
      });
    }

    const {
      franchiseId,
      kioskId,
      title,
      amount,
      category,
      description,
      purchaseDate,
      vendor,
    } = req.body;

    // Handle file upload
    if (req.file) {
      // Delete old invoice if exists
      if (investment.invoicePath) {
        const oldFilePath = path.join(__dirname, "..", investment.invoicePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      investment.invoicePath = getFileUrl(req, req.file, "invoices");
    }

    if (title) investment.title = title;
    if (amount !== undefined) investment.amount = amount;
    if (category) investment.category = category;
    if (description !== undefined) investment.description = description;
    if (purchaseDate) investment.purchaseDate = new Date(purchaseDate);
    if (vendor !== undefined) investment.vendor = vendor;
    if (franchiseId !== undefined) investment.franchiseId = franchiseId || null;
    if (kioskId !== undefined) investment.kioskId = kioskId || null;

    await investment.save();

    const populated = await Investment.findById(investment._id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update investment error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update investment",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/investments/:id
 * @desc    Delete investment
 * @access  Private (Super Admin only)
 */
exports.deleteInvestment = async (req, res) => {
  try {
    const investment = await Investment.findById(req.params.id);

    if (!investment) {
      return res.status(404).json({
        success: false,
        message: "Investment not found",
      });
    }

    // Delete invoice file if exists
    if (investment.invoicePath) {
      const filePath = path.join(__dirname, "..", investment.invoicePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await Investment.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Investment deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete investment error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete investment",
      error: error.message,
    });
  }
};

// ==================== EXPENSES ====================

/**
 * @route   GET /api/admin/costing/expenses
 * @desc    Get all expenses
 * @access  Private (Super Admin only)
 */
exports.getExpenses = async (req, res) => {
  try {
    const { franchiseId, kioskId, startDate, endDate, expenseCategoryId } = req.query;
    const filter = {};

    if (franchiseId) filter.franchiseId = franchiseId;
    if (kioskId) filter.kioskId = kioskId;
    if (expenseCategoryId) filter.expenseCategoryId = expenseCategoryId;
    if (startDate || endDate) {
      filter.expenseDate = {};
      if (startDate) filter.expenseDate.$gte = new Date(startDate);
      if (endDate) filter.expenseDate.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(filter)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("expenseCategoryId", "name")
      .populate("createdBy", "name email")
      .sort({ expenseDate: -1 });

    res.json({
      success: true,
      data: expenses,
    });
  } catch (error) {
    console.error("[COSTING] Get expenses error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expenses",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/expenses/:id
 * @desc    Get single expense
 * @access  Private (Super Admin only)
 */
exports.getExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("expenseCategoryId", "name")
      .populate("createdBy", "name email");

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    res.json({
      success: true,
      data: expense,
    });
  } catch (error) {
    console.error("[COSTING] Get expense error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expense",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/expenses
 * @desc    Create expense
 * @access  Private (Super Admin only)
 */
exports.createExpense = async (req, res) => {
  try {
    const {
      franchiseId,
      kioskId,
      expenseCategoryId,
      amount,
      description,
      expenseDate,
      paymentMode,
    } = req.body;

    // Handle file upload
    let invoicePath = null;
    if (req.file) {
      invoicePath = getFileUrl(req, req.file, "invoices");
    }

    const expense = new Expense({
      franchiseId: franchiseId || null,
      kioskId: kioskId || null,
      expenseCategoryId,
      amount,
      description: description || "",
      expenseDate: new Date(expenseDate),
      paymentMode: paymentMode || "Cash",
      invoicePath: invoicePath,
      createdBy: req.user._id,
    });

    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("expenseCategoryId", "name")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create expense error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create expense",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/expenses/:id
 * @desc    Update expense
 * @access  Private (Super Admin only)
 */
exports.updateExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    const {
      franchiseId,
      kioskId,
      expenseCategoryId,
      amount,
      description,
      expenseDate,
      paymentMode,
    } = req.body;

    // Handle file upload
    if (req.file) {
      // Delete old invoice if exists
      if (expense.invoicePath) {
        const oldFilePath = path.join(__dirname, "..", expense.invoicePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      expense.invoicePath = getFileUrl(req, req.file, "invoices");
    }

    if (expenseCategoryId) expense.expenseCategoryId = expenseCategoryId;
    if (amount !== undefined) expense.amount = amount;
    if (description !== undefined) expense.description = description;
    if (expenseDate) expense.expenseDate = new Date(expenseDate);
    if (paymentMode) expense.paymentMode = paymentMode;
    if (franchiseId !== undefined) expense.franchiseId = franchiseId || null;
    if (kioskId !== undefined) expense.kioskId = kioskId || null;

    await expense.save();

    const populated = await Expense.findById(expense._id)
      .populate("franchiseId", "name")
      .populate("kioskId", "name cartName")
      .populate("expenseCategoryId", "name")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update expense error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update expense",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/expenses/:id
 * @desc    Delete expense
 * @access  Private (Super Admin only)
 */
exports.deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: "Expense not found",
      });
    }

    // Delete invoice file if exists
    if (expense.invoicePath) {
      const filePath = path.join(__dirname, "..", expense.invoicePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await Expense.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Expense deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete expense error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete expense",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/expenses/bulk-import
 * @desc    Bulk import expenses from CSV
 * @access  Private (Super Admin only)
 */
exports.bulkImportExpenses = async (req, res) => {
  try {
    const { expenses } = req.body;

    if (!Array.isArray(expenses) || expenses.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Expenses array is required",
      });
    }

    const results = {
      success: [],
      failed: [],
    };

    for (const expenseData of expenses) {
      try {
        const expense = new Expense({
          franchiseId: expenseData.franchiseId || null,
          kioskId: expenseData.kioskId || null,
          expenseCategoryId: expenseData.expenseCategoryId,
          amount: expenseData.amount,
          description: expenseData.description || "",
          expenseDate: new Date(expenseData.expenseDate),
          paymentMode: expenseData.paymentMode || "Cash",
          invoicePath: expenseData.invoicePath || null,
          createdBy: req.user._id,
        });

        await expense.save();
        results.success.push(expense._id);
      } catch (error) {
        results.failed.push({
          data: expenseData,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      data: {
        total: expenses.length,
        successful: results.success.length,
        failed: results.failed.length,
        results: results,
      },
    });
  } catch (error) {
    console.error("[COSTING] Bulk import expenses error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to bulk import expenses",
      error: error.message,
    });
  }
};

// ==================== EXPENSE CATEGORIES ====================

/**
 * @route   GET /api/admin/costing/expense-categories
 * @desc    Get all expense categories
 * @access  Private (Super Admin only)
 */
exports.getExpenseCategories = async (req, res) => {
  try {
    const categories = await ExpenseCategory.find()
      .populate("createdBy", "name email")
      .sort({ name: 1 });

    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    console.error("[COSTING] Get expense categories error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch expense categories",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/expense-categories
 * @desc    Create expense category
 * @access  Private (Super Admin only)
 */
exports.createExpenseCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    const category = new ExpenseCategory({
      name,
      description: description || "",
      createdBy: req.user._id,
    });

    await category.save();

    const populated = await ExpenseCategory.findById(category._id)
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create expense category error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Expense category with this name already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to create expense category",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/expense-categories/:id
 * @desc    Update expense category
 * @access  Private (Super Admin only)
 */
exports.updateExpenseCategory = async (req, res) => {
  try {
    const category = await ExpenseCategory.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Expense category not found",
      });
    }

    const { name, description } = req.body;

    if (name) category.name = name;
    if (description !== undefined) category.description = description;

    await category.save();

    const populated = await ExpenseCategory.findById(category._id)
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update expense category error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Expense category with this name already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to update expense category",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/expense-categories/:id
 * @desc    Delete expense category
 * @access  Private (Super Admin only)
 */
exports.deleteExpenseCategory = async (req, res) => {
  try {
    const category = await ExpenseCategory.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Expense category not found",
      });
    }

    // Check if category is used in expenses
    const expenseCount = await Expense.countDocuments({ expenseCategoryId: category._id });
    if (expenseCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. It is used in ${expenseCount} expense(s)`,
      });
    }

    await ExpenseCategory.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Expense category deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete expense category error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete expense category",
      error: error.message,
    });
  }
};

// ==================== INGREDIENTS ====================

/**
 * @route   GET /api/admin/costing/ingredients
 * @desc    Get all ingredients
 * @access  Private (Super Admin only)
 */
exports.getIngredients = async (req, res) => {
  try {
    const ingredients = await Ingredient.find()
      .populate("vendorId", "name email")
      .populate("lastUpdatedBy", "name email")
      .sort({ name: 1 });

    res.json({
      success: true,
      data: ingredients,
    });
  } catch (error) {
    console.error("[COSTING] Get ingredients error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch ingredients",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/ingredients
 * @desc    Create ingredient
 * @access  Private (Super Admin only)
 */
exports.createIngredient = async (req, res) => {
  try {
    const { name, unit, costPerUnit, vendorId } = req.body;

    const ingredient = new Ingredient({
      name,
      unit,
      costPerUnit,
      vendorId: vendorId || null,
      lastUpdatedBy: req.user._id,
      lastUpdatedAt: new Date(),
    });

    await ingredient.save();

    const populated = await Ingredient.findById(ingredient._id)
      .populate("vendorId", "name email")
      .populate("lastUpdatedBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create ingredient error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Ingredient with this name already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to create ingredient",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/ingredients/:id
 * @desc    Update ingredient
 * @access  Private (Super Admin only)
 */
exports.updateIngredient = async (req, res) => {
  try {
    const ingredient = await Ingredient.findById(req.params.id);

    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message: "Ingredient not found",
      });
    }

    const { name, unit, costPerUnit, vendorId } = req.body;

    if (name) ingredient.name = name;
    if (unit) ingredient.unit = unit;
    if (costPerUnit !== undefined) ingredient.costPerUnit = costPerUnit;
    if (vendorId !== undefined) ingredient.vendorId = vendorId || null;
    ingredient.lastUpdatedBy = req.user._id;
    ingredient.lastUpdatedAt = new Date();

    await ingredient.save();

    const populated = await Ingredient.findById(ingredient._id)
      .populate("vendorId", "name email")
      .populate("lastUpdatedBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update ingredient error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Ingredient with this name already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to update ingredient",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/ingredients/:id
 * @desc    Delete ingredient
 * @access  Private (Super Admin only)
 */
exports.deleteIngredient = async (req, res) => {
  try {
    const ingredient = await Ingredient.findById(req.params.id);

    if (!ingredient) {
      return res.status(404).json({
        success: false,
        message: "Ingredient not found",
      });
    }

    // Check if ingredient is used in recipes
    const recipeCount = await RecipeIngredient.countDocuments({ ingredientId: ingredient._id });
    if (recipeCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete ingredient. It is used in ${recipeCount} recipe(s)`,
      });
    }

    await Ingredient.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Ingredient deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete ingredient error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete ingredient",
      error: error.message,
    });
  }
};

// ==================== RECIPES ====================

/**
 * @route   GET /api/admin/costing/recipes
 * @desc    Get all recipes
 * @access  Private (Super Admin only)
 */
exports.getRecipes = async (req, res) => {
  try {
    const recipes = await Recipe.find()
      .populate("createdBy", "name email")
      .sort({ name: 1 });

    // Populate ingredients for each recipe
    const recipesWithIngredients = await Promise.all(
      recipes.map(async (recipe) => {
        const ingredients = await RecipeIngredient.find({ recipeId: recipe._id })
          .populate("ingredientId", "name unit costPerUnit");
        return {
          ...recipe.toObject(),
          ingredients,
        };
      })
    );

    res.json({
      success: true,
      data: recipesWithIngredients,
    });
  } catch (error) {
    console.error("[COSTING] Get recipes error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch recipes",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/recipes/:id
 * @desc    Get single recipe with ingredients
 * @access  Private (Super Admin only)
 */
exports.getRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id)
      .populate("createdBy", "name email");

    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: "Recipe not found",
      });
    }

    const ingredients = await RecipeIngredient.find({ recipeId: recipe._id })
      .populate("ingredientId", "name unit costPerUnit");

    res.json({
      success: true,
      data: {
        ...recipe.toObject(),
        ingredients,
      },
    });
  } catch (error) {
    console.error("[COSTING] Get recipe error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch recipe",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/recipes
 * @desc    Create recipe with ingredients
 * @access  Private (Super Admin only)
 */
exports.createRecipe = async (req, res) => {
  try {
    const { name, sku, sellingPrice, ingredients, overheadPerPlate } = req.body;

    // Calculate plate cost from ingredients
    let plateCost = 0;
    if (ingredients && Array.isArray(ingredients)) {
      for (const ing of ingredients) {
        const ingredient = await Ingredient.findById(ing.ingredientId);
        if (!ingredient) continue;

        // Convert quantity to base unit and calculate cost
        const quantityInBaseUnit = convertToBaseUnit(ing.quantity, ing.unit);
        const costPerBaseUnit = ingredient.costPerUnit;
        plateCost += quantityInBaseUnit * costPerBaseUnit;
      }
    }

    // Add overhead per plate
    const overhead = overheadPerPlate || Number(process.env.OVERHEAD_PER_PLATE) || 0;
    plateCost += overhead;

    const recipe = new Recipe({
      name,
      sku: sku.toUpperCase(),
      sellingPrice,
      plateCost: Number(plateCost.toFixed(2)),
      overheadPerPlate: overhead,
      createdBy: req.user._id,
    });

    await recipe.save();

    // Create recipe ingredients
    if (ingredients && Array.isArray(ingredients)) {
      for (const ing of ingredients) {
        const recipeIngredient = new RecipeIngredient({
          recipeId: recipe._id,
          ingredientId: ing.ingredientId,
          quantity: ing.quantity,
          unit: ing.unit,
        });
        await recipeIngredient.save();
      }
    }

    const populated = await Recipe.findById(recipe._id)
      .populate("createdBy", "name email");
    const recipeIngredients = await RecipeIngredient.find({ recipeId: recipe._id })
      .populate("ingredientId", "name unit costPerUnit");

    res.status(201).json({
      success: true,
      data: {
        ...populated.toObject(),
        ingredients: recipeIngredients,
      },
    });
  } catch (error) {
    console.error("[COSTING] Create recipe error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Recipe with this SKU already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to create recipe",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/recipes/:id
 * @desc    Update recipe
 * @access  Private (Super Admin only)
 */
exports.updateRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);

    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: "Recipe not found",
      });
    }

    const { name, sku, sellingPrice, ingredients, overheadPerPlate } = req.body;

    if (name) recipe.name = name;
    if (sku) recipe.sku = sku.toUpperCase();
    if (sellingPrice !== undefined) recipe.sellingPrice = sellingPrice;
    if (overheadPerPlate !== undefined) recipe.overheadPerPlate = overheadPerPlate;

    // Recalculate plate cost if ingredients are provided
    if (ingredients && Array.isArray(ingredients)) {
      let plateCost = 0;
      for (const ing of ingredients) {
        const ingredient = await Ingredient.findById(ing.ingredientId);
        if (!ingredient) continue;

        const quantityInBaseUnit = convertToBaseUnit(ing.quantity, ing.unit);
        const costPerBaseUnit = ingredient.costPerUnit;
        plateCost += quantityInBaseUnit * costPerBaseUnit;
      }

      const overhead = overheadPerPlate !== undefined ? overheadPerPlate : recipe.overheadPerPlate;
      plateCost += overhead;
      recipe.plateCost = Number(plateCost.toFixed(2));
    }

    await recipe.save();

    // Update recipe ingredients if provided
    if (ingredients && Array.isArray(ingredients)) {
      // Delete existing ingredients
      await RecipeIngredient.deleteMany({ recipeId: recipe._id });

      // Create new ingredients
      for (const ing of ingredients) {
        const recipeIngredient = new RecipeIngredient({
          recipeId: recipe._id,
          ingredientId: ing.ingredientId,
          quantity: ing.quantity,
          unit: ing.unit,
        });
        await recipeIngredient.save();
      }
    }

    const populated = await Recipe.findById(recipe._id)
      .populate("createdBy", "name email");
    const recipeIngredients = await RecipeIngredient.find({ recipeId: recipe._id })
      .populate("ingredientId", "name unit costPerUnit");

    res.json({
      success: true,
      data: {
        ...populated.toObject(),
        ingredients: recipeIngredients,
      },
    });
  } catch (error) {
    console.error("[COSTING] Update recipe error:", error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Recipe with this SKU already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Failed to update recipe",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/recipes/:id
 * @desc    Delete recipe
 * @access  Private (Super Admin only)
 */
exports.deleteRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);

    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: "Recipe not found",
      });
    }

    // Delete recipe ingredients
    await RecipeIngredient.deleteMany({ recipeId: recipe._id });

    await Recipe.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Recipe deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete recipe error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete recipe",
      error: error.message,
    });
  }
};

// Helper function to convert units to base unit
function convertToBaseUnit(quantity, unit) {
  const conversions = {
    kg: 1,
    g: 0.001,
    l: 1,
    ml: 0.001,
    pcs: 1,
  };
  return quantity * (conversions[unit] || 1);
}

// ==================== INVENTORY TRANSACTIONS ====================

/**
 * @route   POST /api/admin/costing/inventory/adjust
 * @desc    Record inventory adjustment/wastage
 * @access  Private (Super Admin only)
 */
exports.adjustInventory = async (req, res) => {
  try {
    const { ingredientId, changeQty, changeType, referenceId, cost, remarks } = req.body;

    const transaction = new InventoryTransaction({
      ingredientId,
      changeQty,
      changeType,
      referenceId: referenceId || null,
      cost: cost || 0,
      remarks: remarks || "",
      createdBy: req.user._id,
    });

    await transaction.save();

    const populated = await InventoryTransaction.findById(transaction._id)
      .populate("ingredientId", "name unit costPerUnit")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Adjust inventory error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to record inventory adjustment",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/inventory/transactions
 * @desc    Get inventory transactions
 * @access  Private (Super Admin only)
 */
exports.getInventoryTransactions = async (req, res) => {
  try {
    const { ingredientId, changeType, startDate, endDate } = req.query;
    const filter = {};

    if (ingredientId) filter.ingredientId = ingredientId;
    if (changeType) filter.changeType = changeType;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const transactions = await InventoryTransaction.find(filter)
      .populate("ingredientId", "name unit costPerUnit")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: transactions,
    });
  } catch (error) {
    console.error("[COSTING] Get inventory transactions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory transactions",
      error: error.message,
    });
  }
};

// ==================== INGREDIENT PURCHASES ====================

/**
 * @route   GET /api/admin/costing/ingredient-purchases
 * @desc    Get all ingredient purchases
 * @access  Private (Super Admin only)
 */
exports.getIngredientPurchases = async (req, res) => {
  try {
    const { outletId, franchiseId, ingredientId, startDate, endDate } = req.query;
    const filter = {};

    if (outletId) filter.outletId = outletId;
    if (franchiseId) filter.franchiseId = franchiseId;
    if (ingredientId) filter.ingredientId = ingredientId;
    if (startDate || endDate) {
      filter.purchaseDate = {};
      if (startDate) filter.purchaseDate.$gte = new Date(startDate);
      if (endDate) filter.purchaseDate.$lte = new Date(endDate);
    }

    const purchases = await IngredientPurchase.find(filter)
      .populate("outletId", "name cartName")
      .populate("franchiseId", "name")
      .populate("ingredientId", "name unit")
      .populate("createdBy", "name email")
      .sort({ purchaseDate: -1 });

    res.json({
      success: true,
      data: purchases,
    });
  } catch (error) {
    console.error("[COSTING] Get ingredient purchases error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch ingredient purchases",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/ingredient-purchases
 * @desc    Create ingredient purchase
 * @access  Private (Super Admin only)
 */
exports.createIngredientPurchase = async (req, res) => {
  try {
    const {
      outletId,
      franchiseId,
      ingredientId,
      qtyPurchased,
      unit,
      totalCost,
      purchaseDate,
      vendor,
      remarks,
    } = req.body;

    if (!outletId || !ingredientId || !qtyPurchased || !totalCost || !purchaseDate) {
      return res.status(400).json({
        success: false,
        message: "outletId, ingredientId, qtyPurchased, totalCost, and purchaseDate are required",
      });
    }

    let invoicePath = null;
    if (req.file) {
      invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    const purchase = new IngredientPurchase({
      outletId,
      franchiseId: franchiseId || null,
      ingredientId,
      qtyPurchased,
      unit,
      totalCost,
      purchaseDate: new Date(purchaseDate),
      vendor: vendor || "",
      invoicePath,
      remarks: remarks || "",
      createdBy: req.user._id,
    });

    await purchase.save();

    // Create inventory transaction for purchase
    const ingredient = await Ingredient.findById(ingredientId);
    const inventoryTransaction = new InventoryTransaction({
      ingredientId,
      outletId,
      franchiseId: franchiseId || null,
      changeQty: qtyPurchased,
      changeType: "purchase",
      cost: totalCost,
      remarks: `Purchase: ${purchase.purchaseId}`,
      createdBy: req.user._id,
    });
    await inventoryTransaction.save();

    const populated = await IngredientPurchase.findById(purchase._id)
      .populate("outletId", "name cartName")
      .populate("franchiseId", "name")
      .populate("ingredientId", "name unit")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create ingredient purchase error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create ingredient purchase",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/ingredient-purchases/:id
 * @desc    Update ingredient purchase
 * @access  Private (Super Admin only)
 */
exports.updateIngredientPurchase = async (req, res) => {
  try {
    const purchase = await IngredientPurchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Ingredient purchase not found",
      });
    }

    const {
      outletId,
      franchiseId,
      ingredientId,
      qtyPurchased,
      unit,
      totalCost,
      purchaseDate,
      vendor,
      remarks,
    } = req.body;

    if (req.file) {
      if (purchase.invoicePath) {
        const oldFilePath = path.join(__dirname, "..", purchase.invoicePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      purchase.invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    if (outletId) purchase.outletId = outletId;
    if (franchiseId !== undefined) purchase.franchiseId = franchiseId;
    if (ingredientId) purchase.ingredientId = ingredientId;
    if (qtyPurchased) purchase.qtyPurchased = qtyPurchased;
    if (unit) purchase.unit = unit;
    if (totalCost) purchase.totalCost = totalCost;
    if (purchaseDate) purchase.purchaseDate = new Date(purchaseDate);
    if (vendor !== undefined) purchase.vendor = vendor;
    if (remarks !== undefined) purchase.remarks = remarks;

    await purchase.save();

    const populated = await IngredientPurchase.findById(purchase._id)
      .populate("outletId", "name cartName")
      .populate("franchiseId", "name")
      .populate("ingredientId", "name unit")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update ingredient purchase error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update ingredient purchase",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/ingredient-purchases/:id
 * @desc    Delete ingredient purchase
 * @access  Private (Super Admin only)
 */
exports.deleteIngredientPurchase = async (req, res) => {
  try {
    const purchase = await IngredientPurchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Ingredient purchase not found",
      });
    }

    // Delete invoice file if exists
    if (purchase.invoicePath) {
      const filePath = path.join(__dirname, "..", purchase.invoicePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await IngredientPurchase.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Ingredient purchase deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete ingredient purchase error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete ingredient purchase",
      error: error.message,
    });
  }
};

// ==================== OUTLET OPEX ====================

/**
 * @route   GET /api/admin/costing/outlet-opex
 * @desc    Get all outlet OPEX
 * @access  Private (Super Admin only)
 */
exports.getOutletOPEX = async (req, res) => {
  try {
    const { franchiseId, costCategory, startDate, endDate } = req.query;
    const filter = {};

    if (franchiseId) filter.franchiseId = franchiseId;
    if (costCategory) filter.costCategory = costCategory;
    if (startDate || endDate) {
      filter.$or = [
        {
          periodStartDate: { $lte: new Date(endDate || new Date()) },
          periodEndDate: { $gte: new Date(startDate || new Date(0)) },
        },
      ];
    }

    const opexList = await OutletOPEX.find(filter)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email")
      .sort({ periodStartDate: -1 });

    res.json({
      success: true,
      data: opexList,
    });
  } catch (error) {
    console.error("[COSTING] Get outlet OPEX error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch outlet OPEX",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/outlet-opex
 * @desc    Create outlet OPEX
 * @access  Private (Super Admin only)
 */
exports.createOutletOPEX = async (req, res) => {
  try {
    const {
      franchiseId,
      costCategory,
      amount,
      periodStartDate,
      periodEndDate,
      description,
    } = req.body;

    if (!franchiseId || !costCategory || !amount || !periodStartDate || !periodEndDate) {
      return res.status(400).json({
        success: false,
        message: "franchiseId, costCategory, amount, periodStartDate, and periodEndDate are required",
      });
    }

    // Handle franchiseId - could be ObjectId or franchise code (e.g., "SAH001")
    let franchiseObjectId = franchiseId;
    
    // Check if it's a franchise code (not a valid ObjectId)
    if (!mongoose.Types.ObjectId.isValid(franchiseId)) {
      // Try to find franchise by code
      const franchise = await User.findOne({ 
        franchiseCode: franchiseId,
        role: 'franchise_admin'
      }).select('_id');
      
      if (!franchise) {
        return res.status(400).json({
          success: false,
          message: `Franchise not found with code: ${franchiseId}`,
        });
      }
      
      franchiseObjectId = franchise._id;
    }

    let invoicePath = null;
    if (req.file) {
      invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    const opex = new OutletOPEX({
      franchiseId: franchiseObjectId,
      costCategory,
      amount,
      periodStartDate: new Date(periodStartDate),
      periodEndDate: new Date(periodEndDate),
      description: description || "",
      invoicePath,
      createdBy: req.user._id,
    });

    await opex.save();

    const populated = await OutletOPEX.findById(opex._id)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create outlet OPEX error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create outlet OPEX",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/outlet-opex/:id
 * @desc    Update outlet OPEX
 * @access  Private (Super Admin only)
 */
exports.updateOutletOPEX = async (req, res) => {
  try {
    const opex = await OutletOPEX.findById(req.params.id);

    if (!opex) {
      return res.status(404).json({
        success: false,
        message: "Outlet OPEX not found",
      });
    }

    const {
      franchiseId,
      costCategory,
      amount,
      periodStartDate,
      periodEndDate,
      description,
    } = req.body;

    if (req.file) {
      if (opex.invoicePath) {
        const oldFilePath = path.join(__dirname, "..", opex.invoicePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      opex.invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    // Handle franchiseId - could be ObjectId or franchise code (e.g., "SAH001")
    if (franchiseId) {
      let franchiseObjectId = franchiseId;
      
      // Check if it's a franchise code (not a valid ObjectId)
      if (!mongoose.Types.ObjectId.isValid(franchiseId)) {
        // Try to find franchise by code
        const franchise = await User.findOne({ 
          franchiseCode: franchiseId,
          role: 'franchise_admin'
        }).select('_id');
        
        if (!franchise) {
          return res.status(400).json({
            success: false,
            message: `Franchise not found with code: ${franchiseId}`,
          });
        }
        
        franchiseObjectId = franchise._id;
      }
      
      opex.franchiseId = franchiseObjectId;
    }
    if (costCategory) opex.costCategory = costCategory;
    if (amount) opex.amount = amount;
    if (periodStartDate) opex.periodStartDate = new Date(periodStartDate);
    if (periodEndDate) opex.periodEndDate = new Date(periodEndDate);
    if (description !== undefined) opex.description = description;

    await opex.save();

    const populated = await OutletOPEX.findById(opex._id)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update outlet OPEX error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update outlet OPEX",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/outlet-opex/:id
 * @desc    Delete outlet OPEX
 * @access  Private (Super Admin only)
 */
exports.deleteOutletOPEX = async (req, res) => {
  try {
    const opex = await OutletOPEX.findById(req.params.id);

    if (!opex) {
      return res.status(404).json({
        success: false,
        message: "Outlet OPEX not found",
      });
    }

    if (opex.invoicePath) {
      const filePath = path.join(__dirname, "..", opex.invoicePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await OutletOPEX.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Outlet OPEX deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete outlet OPEX error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete outlet OPEX",
      error: error.message,
    });
  }
};

// ==================== OUTLET ASSETS ====================

/**
 * @route   GET /api/admin/costing/outlet-assets
 * @desc    Get all outlet assets
 * @access  Private (Super Admin only)
 */
exports.getOutletAssets = async (req, res) => {
  try {
    const { franchiseId, assetType } = req.query;
    const filter = {};

    if (franchiseId) filter.franchiseId = franchiseId;
    if (assetType) filter.assetType = assetType;

    const assets = await OutletAsset.find(filter)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email")
      .sort({ purchaseDate: -1 });

    res.json({
      success: true,
      data: assets,
    });
  } catch (error) {
    console.error("[COSTING] Get outlet assets error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch outlet assets",
      error: error.message,
    });
  }
};

/**
 * @route   POST /api/admin/costing/outlet-assets
 * @desc    Create outlet asset
 * @access  Private (Super Admin only)
 */
exports.createOutletAsset = async (req, res) => {
  try {
    const {
      franchiseId,
      assetType,
      assetName,
      purchaseCost,
      purchaseDate,
      usefulLifeMonths,
      depreciationMethod,
      description,
    } = req.body;

    if (!franchiseId || !assetType || !assetName || !purchaseCost || !purchaseDate) {
      return res.status(400).json({
        success: false,
        message: "franchiseId, assetType, assetName, purchaseCost, and purchaseDate are required",
      });
    }

    // Handle franchiseId - could be ObjectId or franchise code (e.g., "SAH001")
    let franchiseObjectId = franchiseId;
    
    // Check if it's a franchise code (not a valid ObjectId)
    if (!mongoose.Types.ObjectId.isValid(franchiseId)) {
      // Try to find franchise by code
      const franchise = await User.findOne({ 
        franchiseCode: franchiseId,
        role: 'franchise_admin'
      }).select('_id');
      
      if (!franchise) {
        return res.status(400).json({
          success: false,
          message: `Franchise not found with code: ${franchiseId}`,
        });
      }
      
      franchiseObjectId = franchise._id;
    }

    let invoicePath = null;
    if (req.file) {
      invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    const asset = new OutletAsset({
      franchiseId: franchiseObjectId,
      assetType,
      assetName,
      purchaseCost,
      purchaseDate: new Date(purchaseDate),
      usefulLifeMonths: usefulLifeMonths || 60,
      depreciationMethod: depreciationMethod || "straight_line",
      description: description || "",
      invoicePath,
      createdBy: req.user._id,
    });

    await asset.save();

    const populated = await OutletAsset.findById(asset._id)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email");

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Create outlet asset error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create outlet asset",
      error: error.message,
    });
  }
};

/**
 * @route   PUT /api/admin/costing/outlet-assets/:id
 * @desc    Update outlet asset
 * @access  Private (Super Admin only)
 */
exports.updateOutletAsset = async (req, res) => {
  try {
    const asset = await OutletAsset.findById(req.params.id);

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Outlet asset not found",
      });
    }

    const {
      franchiseId,
      assetType,
      assetName,
      purchaseCost,
      purchaseDate,
      usefulLifeMonths,
      depreciationMethod,
      description,
    } = req.body;

    if (req.file) {
      if (asset.invoicePath) {
        const oldFilePath = path.join(__dirname, "..", asset.invoicePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      asset.invoicePath = `/uploads/invoices/${req.file.filename}`;
    }

    // Handle franchiseId - could be ObjectId or franchise code (e.g., "SAH001")
    if (franchiseId) {
      let franchiseObjectId = franchiseId;
      
      // Check if it's a franchise code (not a valid ObjectId)
      if (!mongoose.Types.ObjectId.isValid(franchiseId)) {
        // Try to find franchise by code
        const franchise = await User.findOne({ 
          franchiseCode: franchiseId,
          role: 'franchise_admin'
        }).select('_id');
        
        if (!franchise) {
          return res.status(400).json({
            success: false,
            message: `Franchise not found with code: ${franchiseId}`,
          });
        }
        
        franchiseObjectId = franchise._id;
      }
      
      asset.franchiseId = franchiseObjectId;
    }
    if (assetType) asset.assetType = assetType;
    if (assetName) asset.assetName = assetName;
    if (purchaseCost) asset.purchaseCost = purchaseCost;
    if (purchaseDate) asset.purchaseDate = new Date(purchaseDate);
    if (usefulLifeMonths) asset.usefulLifeMonths = usefulLifeMonths;
    if (depreciationMethod) asset.depreciationMethod = depreciationMethod;
    if (description !== undefined) asset.description = description;

    await asset.save();

    const populated = await OutletAsset.findById(asset._id)
      .populate("franchiseId", "name")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: populated,
    });
  } catch (error) {
    console.error("[COSTING] Update outlet asset error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update outlet asset",
      error: error.message,
    });
  }
};

/**
 * @route   DELETE /api/admin/costing/outlet-assets/:id
 * @desc    Delete outlet asset
 * @access  Private (Super Admin only)
 */
exports.deleteOutletAsset = async (req, res) => {
  try {
    const asset = await OutletAsset.findById(req.params.id);

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Outlet asset not found",
      });
    }

    if (asset.invoicePath) {
      const filePath = path.join(__dirname, "..", asset.invoicePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await OutletAsset.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Outlet asset deleted successfully",
    });
  } catch (error) {
    console.error("[COSTING] Delete outlet asset error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete outlet asset",
      error: error.message,
    });
  }
};

// ==================== REPORTS ====================

/**
 * @route   GET /api/admin/costing/reports/pnl
 * @desc    Get P&L report
 * @access  Private (Super Admin only)
 */
exports.getPnLReport = async (req, res) => {
  try {
    const { startDate, endDate, franchiseId, kioskId, format } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const scopeFilter = {};
    if (franchiseId) scopeFilter.franchiseId = franchiseId;
    if (kioskId) scopeFilter.kioskId = kioskId;

    // Calculate Revenue (Sales)
    const orderFilter = {
      ...scopeFilter,
      status: { $in: ["Paid", "Finalized"] },
      createdAt: { $gte: start, $lte: end },
    };
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const revenue = salesData[0]?.total || 0;

    // Calculate COGS
    const cogsFilter = {
      changeType: "consumption",
      createdAt: { $gte: start, $lte: end },
    };
    const cogsData = await InventoryTransaction.aggregate([
      { $match: cogsFilter },
      { $group: { _id: null, total: { $sum: "$cost" } } },
    ]);
    const cogs = cogsData[0]?.total || 0;

    // Calculate Expenses
    const expenseFilter = {
      ...scopeFilter,
      expenseDate: { $gte: start, $lte: end },
    };
    const expenseData = await Expense.aggregate([
      { $match: expenseFilter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const expenses = expenseData[0]?.total || 0;

    // Calculate Net Profit
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - expenses;

    const report = {
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      revenue: Number(revenue.toFixed(2)),
      cogs: Number(cogs.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      expenses: Number(expenses.toFixed(2)),
      netProfit: Number(netProfit.toFixed(2)),
      foodCostPercentage: revenue > 0 ? Number(((cogs / revenue) * 100).toFixed(2)) : 0,
    };

    // Export as CSV if requested
    if (format === "csv") {
      const csv = generatePnLCSV(report);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=pnl-report-${Date.now()}.csv`);
      return res.send(csv);
    }

    // Export as PDF if requested
    if (format === "pdf") {
      // TODO: Implement PDF generation using PDFKit
      return res.status(501).json({
        success: false,
        message: "PDF export not yet implemented",
      });
    }

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    console.error("[COSTING] P&L report error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate P&L report",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/reports/roi
 * @desc    Get ROI and breakeven report
 * @access  Private (Super Admin only)
 */
exports.getROIReport = async (req, res) => {
  try {
    const { startDate, endDate, franchiseId, kioskId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const scopeFilter = {};
    if (franchiseId) scopeFilter.franchiseId = franchiseId;
    if (kioskId) scopeFilter.kioskId = kioskId;

    // Calculate Total Investment
    const investmentFilter = { ...scopeFilter };
    const investmentData = await Investment.aggregate([
      { $match: investmentFilter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalInvestment = investmentData[0]?.total || 0;

    // Calculate Net Profit for the period
    const orderFilter = {
      ...scopeFilter,
      status: { $in: ["Paid", "Finalized"] },
      createdAt: { $gte: start, $lte: end },
    };
    const salesData = await Order.aggregate([
      { $match: orderFilter },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const revenue = salesData[0]?.total || 0;

    const cogsFilter = {
      changeType: "consumption",
      createdAt: { $gte: start, $lte: end },
    };
    const cogsData = await InventoryTransaction.aggregate([
      { $match: cogsFilter },
      { $group: { _id: null, total: { $sum: "$cost" } } },
    ]);
    const cogs = cogsData[0]?.total || 0;

    const expenseFilter = {
      ...scopeFilter,
      expenseDate: { $gte: start, $lte: end },
    };
    const expenseData = await Expense.aggregate([
      { $match: expenseFilter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const expenses = expenseData[0]?.total || 0;

    const netProfit = revenue - cogs - expenses;

    // Calculate ROI
    const roi = totalInvestment > 0 ? (netProfit / totalInvestment) * 100 : 0;

    // Calculate Breakeven months
    const months = getMonthsBetween(startDate, endDate);
    const avgMonthlyNetProfit = netProfit / months;
    const breakevenMonths = avgMonthlyNetProfit > 0 ? totalInvestment / avgMonthlyNetProfit : null;

    res.json({
      success: true,
      data: {
        totalInvestment: Number(totalInvestment.toFixed(2)),
        netProfit: Number(netProfit.toFixed(2)),
        roi: Number(roi.toFixed(2)),
        breakevenMonths: breakevenMonths ? Number(breakevenMonths.toFixed(2)) : null,
        period: {
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          months: months,
        },
      },
    });
  } catch (error) {
    console.error("[COSTING] ROI report error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate ROI report",
      error: error.message,
    });
  }
};

// Helper function to generate CSV
function generatePnLCSV(report) {
  const rows = [
    ["P&L Report"],
    ["Period", `${report.period.startDate} to ${report.period.endDate}`],
    [""],
    ["Revenue", report.revenue],
    ["COGS", report.cogs],
    ["Gross Profit", report.grossProfit],
    ["Expenses", report.expenses],
    ["Net Profit", report.netProfit],
    ["Food Cost %", `${report.foodCostPercentage}%`],
  ];

  return rows.map((row) => row.join(",")).join("\n");
}

// ==================== NEW CALCULATION FUNCTIONS ====================

/**
 * Calculate ingredient cost per unit from purchases
 * Formula: IngredientCostPerUnit = SUM(TotalCost) ÷ SUM(QtyPurchased)
 */
async function calculateIngredientCostPerUnit(ingredientId, outletId = null, startDate = null, endDate = null) {
  try {
    const filter = { ingredientId };
    if (outletId) filter.outletId = outletId;
    if (startDate || endDate) {
      filter.purchaseDate = {};
      if (startDate) filter.purchaseDate.$gte = new Date(startDate);
      if (endDate) filter.purchaseDate.$lte = new Date(endDate);
    }

    const purchases = await IngredientPurchase.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalCost: { $sum: "$totalCost" },
          totalQty: { $sum: "$qtyPurchased" },
        },
      },
    ]);

    if (purchases.length === 0 || purchases[0].totalQty === 0) {
      // Fallback to ingredient's costPerUnit
      const ingredient = await Ingredient.findById(ingredientId);
      return ingredient ? ingredient.costPerUnit : 0;
    }

    return purchases[0].totalCost / purchases[0].totalQty;
  } catch (error) {
    console.error("[COSTING] Calculate ingredient cost error:", error);
    return 0;
  }
}

/**
 * Calculate standard dish cost from recipe BOM
 * Formula: StandardDishCost = SUM(QtyPerDish × IngredientCostPerUnit for all ingredients)
 */
async function calculateDishCost(recipeId, outletId = null, startDate = null, endDate = null) {
  try {
    const recipeIngredients = await RecipeIngredient.find({ recipeId }).populate("ingredientId");
    
    let totalCost = 0;
    for (const ri of recipeIngredients) {
      const ingredientCost = await calculateIngredientCostPerUnit(
        ri.ingredientId._id,
        outletId,
        startDate,
        endDate
      );
      totalCost += ri.qtyPerDish * ingredientCost;
    }

    return totalCost;
  } catch (error) {
    console.error("[COSTING] Calculate dish cost error:", error);
    return 0;
  }
}

/**
 * Calculate total direct cost
 * Formula: TotalDirectCost = SUM(QuantitySold × StandardDishCost)
 */
async function calculateDirectCost(outletId, startDate, endDate) {
  try {
    const orderFilter = {
      cartId: outletId,
      status: { $in: ["Paid", "Finalized"] },
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
    };

    const orders = await Order.find(orderFilter);
    let totalDirectCost = 0;

    for (const order of orders) {
      for (const kotLine of order.kotLines || []) {
        for (const item of kotLine.items || []) {
          // Find recipe by menu item name or ID
          const recipe = await Recipe.findOne({
            $or: [
              { menuItemId: item._id },
              { name: item.name },
              { dishName: item.name },
            ],
          });

          if (recipe) {
            const dishCost = await calculateDishCost(recipe._id, outletId, startDate, endDate);
            totalDirectCost += item.quantity * dishCost;
          } else {
            // Fallback: use inventory consumption cost
            // This is approximate
            const cogsFilter = {
              outletId,
              changeType: "consumption",
              createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
            };
            const cogsData = await InventoryTransaction.aggregate([
              { $match: cogsFilter },
              { $group: { _id: null, total: { $sum: "$cost" } } },
            ]);
            const cogs = cogsData[0]?.total || 0;
            const totalUnits = orders.reduce((sum, o) => {
              return sum + (o.kotLines || []).reduce((s, k) => {
                return s + (k.items || []).reduce((i, item) => i + item.quantity, 0);
              }, 0);
            }, 0);
            if (totalUnits > 0) {
              totalDirectCost += (item.quantity * cogs) / totalUnits;
            }
          }
        }
      }
    }

    return totalDirectCost;
  } catch (error) {
    console.error("[COSTING] Calculate direct cost error:", error);
    return 0;
  }
}

/**
 * Calculate total OPEX for outlet
 * Formula: TotalOutletOpex = SUM(OutletOpex.Amount)
 * Note: OPEX is now at franchise level, so we get franchiseId from outlet
 */
async function calculateTotalOPEX(outletId, startDate, endDate) {
  try {
    // Get franchiseId from outlet (cart)
    const outlet = await User.findById(outletId).select('franchiseId').lean();
    if (!outlet || !outlet.franchiseId) {
      return 0; // No franchise associated
    }

    const filter = {
      franchiseId: outlet.franchiseId,
      $or: [
        {
          periodStartDate: { $lte: new Date(endDate) },
          periodEndDate: { $gte: new Date(startDate) },
        },
      ],
    };

    const opexData = await OutletOPEX.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    return opexData[0]?.total || 0;
  } catch (error) {
    console.error("[COSTING] Calculate OPEX error:", error);
    return 0;
  }
}

/**
 * Calculate depreciation for outlet assets
 * Note: Assets are now at franchise level, so we get franchiseId from outlet
 */
async function calculateDepreciation(outletId, startDate, endDate) {
  try {
    // Get franchiseId from outlet (cart)
    const outlet = await User.findById(outletId).select('franchiseId').lean();
    if (!outlet || !outlet.franchiseId) {
      return 0; // No franchise associated
    }

    const assets = await OutletAsset.find({ franchiseId: outlet.franchiseId });
    let totalDepreciation = 0;

    for (const asset of assets) {
      const depreciation = asset.calculateDepreciation(startDate, endDate);
      totalDepreciation += depreciation;
    }

    return totalDepreciation;
  } catch (error) {
    console.error("[COSTING] Calculate depreciation error:", error);
    return 0;
  }
}

/**
 * Calculate outlet profit
 * Formula: OutletProfit = Revenue - TotalCost
 * Where TotalCost = TotalDirectCost + TotalOutletOpex + Depreciation
 */
async function calculateOutletProfit(outletId, startDate, endDate) {
  try {
    // Calculate Revenue
    const orderFilter = {
      cartId: outletId,
      status: { $in: ["Paid", "Finalized"] },
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
    };
    const revenueData = await Order.aggregate([
      { $match: orderFilter },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const revenue = revenueData[0]?.total || 0;

    // Calculate Costs
    const directCost = await calculateDirectCost(outletId, startDate, endDate);
    const opex = await calculateTotalOPEX(outletId, startDate, endDate);
    const depreciation = await calculateDepreciation(outletId, startDate, endDate);

    const totalCost = directCost + opex + depreciation;
    const profit = revenue - totalCost;

    return {
      revenue,
      directCost,
      opex,
      depreciation,
      totalCost,
      profit,
      profitMargin: revenue > 0 ? (profit / revenue) * 100 : 0,
    };
  } catch (error) {
    console.error("[COSTING] Calculate outlet profit error:", error);
    return {
      revenue: 0,
      directCost: 0,
      opex: 0,
      depreciation: 0,
      totalCost: 0,
      profit: 0,
      profitMargin: 0,
    };
  }
}

/**
 * Calculate cost per dish
 * Formula: 
 * - OverheadPerDish = TotalOutletOpex ÷ TotalUnitsSold
 * - FullCostPerDish = StandardDishCost + OverheadPerDish
 */
async function calculateCostPerDish(recipeId, outletId, startDate, endDate) {
  try {
    // Calculate standard dish cost
    const standardDishCost = await calculateDishCost(recipeId, outletId, startDate, endDate);

    // Calculate total units sold for this dish
    const recipe = await Recipe.findById(recipeId);
    const orderFilter = {
      cartId: outletId,
      status: { $in: ["Paid", "Finalized"] },
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
    };
    const orders = await Order.find(orderFilter);
    
    let totalUnitsSold = 0;
    for (const order of orders) {
      for (const kotLine of order.kotLines || []) {
        for (const item of kotLine.items || []) {
          const isMatch = recipe.menuItemId?.toString() === item._id?.toString() ||
                         recipe.name === item.name ||
                         recipe.dishName === item.name;
          if (isMatch) {
            totalUnitsSold += item.quantity;
          }
        }
      }
    }

    // Calculate total OPEX
    const totalOpex = await calculateTotalOPEX(outletId, startDate, endDate);

    // Calculate total units sold across all dishes
    let totalAllUnits = 0;
    for (const order of orders) {
      for (const kotLine of order.kotLines || []) {
        for (const item of kotLine.items || []) {
          totalAllUnits += item.quantity;
        }
      }
    }

    // Calculate overhead per dish
    const overheadPerDish = totalAllUnits > 0 ? totalOpex / totalAllUnits : 0;

    // Calculate full cost per dish
    const fullCostPerDish = standardDishCost + overheadPerDish;

    return {
      standardDishCost,
      overheadPerDish,
      fullCostPerDish,
      totalUnitsSold,
      profitPerDish: recipe.sellingPrice - fullCostPerDish,
      profitMargin: recipe.sellingPrice > 0 ? ((recipe.sellingPrice - fullCostPerDish) / recipe.sellingPrice) * 100 : 0,
    };
  } catch (error) {
    console.error("[COSTING] Calculate cost per dish error:", error);
    return {
      standardDishCost: 0,
      overheadPerDish: 0,
      fullCostPerDish: 0,
      totalUnitsSold: 0,
      profitPerDish: 0,
      profitMargin: 0,
    };
  }
}

/**
 * @route   GET /api/admin/costing/reports/profitability
 * @desc    Get outlet-level profitability report
 * @access  Private (Super Admin only)
 */
exports.getProfitabilityReport = async (req, res) => {
  try {
    const { startDate, endDate, franchiseId, outletId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const scopeFilter = {};
    if (franchiseId) scopeFilter.franchiseId = franchiseId;
    if (outletId) scopeFilter.cartId = outletId;

    // Get all outlets
    const User = require("../models/userModel");
    const outletFilter = { role: "admin" };
    if (franchiseId) outletFilter.franchiseId = franchiseId;
    const outlets = await User.find(outletFilter).select("_id name cartName location");

    const results = [];

    for (const outlet of outlets) {
      const profitability = await calculateOutletProfit(outlet._id, startDate, endDate);
      results.push({
        outletId: outlet._id,
        outletName: outlet.cartName || outlet.name,
        location: outlet.location,
        ...profitability,
      });
    }

    res.json({
      success: true,
      data: {
        period: {
          startDate,
          endDate,
        },
        outlets: results,
        summary: {
          totalRevenue: results.reduce((sum, r) => sum + r.revenue, 0),
          totalDirectCost: results.reduce((sum, r) => sum + r.directCost, 0),
          totalOPEX: results.reduce((sum, r) => sum + r.opex, 0),
          totalDepreciation: results.reduce((sum, r) => sum + r.depreciation, 0),
          totalCost: results.reduce((sum, r) => sum + r.totalCost, 0),
          totalProfit: results.reduce((sum, r) => sum + r.profit, 0),
        },
      },
    });
  } catch (error) {
    console.error("[COSTING] Profitability report error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate profitability report",
      error: error.message,
    });
  }
};

/**
 * @route   GET /api/admin/costing/reports/cost-per-dish
 * @desc    Get cost per dish report
 * @access  Private (Super Admin only)
 */
exports.getCostPerDishReport = async (req, res) => {
  try {
    const { startDate, endDate, outletId, recipeId } = req.query;

    if (!startDate || !endDate || !outletId) {
      return res.status(400).json({
        success: false,
        message: "startDate, endDate, and outletId are required",
      });
    }

    if (recipeId) {
      // Single recipe
      const costData = await calculateCostPerDish(recipeId, outletId, startDate, endDate);
      const recipe = await Recipe.findById(recipeId);
      res.json({
        success: true,
        data: {
          recipe: {
            id: recipe._id,
            name: recipe.name,
            sellingPrice: recipe.sellingPrice,
          },
          ...costData,
        },
      });
    } else {
      // All recipes
      const recipes = await Recipe.find();
      const results = [];

      for (const recipe of recipes) {
        const costData = await calculateCostPerDish(recipe._id, outletId, startDate, endDate);
        results.push({
          recipeId: recipe._id,
          recipeName: recipe.name,
          sellingPrice: recipe.sellingPrice,
          ...costData,
        });
      }

      res.json({
        success: true,
        data: {
          period: {
            startDate,
            endDate,
          },
          outletId,
          dishes: results,
        },
      });
    }
  } catch (error) {
    console.error("[COSTING] Cost per dish report error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate cost per dish report",
      error: error.message,
    });
  }
};

