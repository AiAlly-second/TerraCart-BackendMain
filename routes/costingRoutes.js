const express = require("express");
const router = express.Router();
const {
  getDashboard,
  getInvestments,
  getInvestment,
  createInvestment,
  updateInvestment,
  deleteInvestment,
  getExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  bulkImportExpenses,
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  getIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  getRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  adjustInventory,
  getInventoryTransactions,
  getIngredientPurchases,
  createIngredientPurchase,
  updateIngredientPurchase,
  deleteIngredientPurchase,
  getOutletOPEX,
  createOutletOPEX,
  updateOutletOPEX,
  deleteOutletOPEX,
  getOutletAssets,
  createOutletAsset,
  updateOutletAsset,
  deleteOutletAsset,
  getPnLReport,
  getROIReport,
  getProfitabilityReport,
  getCostPerDishReport,
} = require("../controllers/costingController");
const { protect } = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/authMiddleware");
const { checkCostingPermission } = require("../middleware/costingPermissionMiddleware");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getStorageCallback } = require("../config/uploadConfig");

const upload = multer({
  storage: getStorageCallback("invoices"),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and image files (JPEG, PNG) are allowed"), false);
    }
  },
});

// All routes require authentication and costing permission
router.use(protect);
router.use(checkCostingPermission);
router.use(authorize(["super_admin", "franchise_admin", "admin", "cart_admin"]));

// Dashboard
router.get("/dashboard", getDashboard);

// Investments
router.get("/investments", getInvestments);
router.get("/investments/:id", getInvestment);
router.post("/investments", upload.single("invoice"), createInvestment);
router.put("/investments/:id", upload.single("invoice"), updateInvestment);
router.delete("/investments/:id", deleteInvestment);

// Expenses
router.get("/expenses", getExpenses);
router.get("/expenses/:id", getExpense);
router.post("/expenses", upload.single("invoice"), createExpense);
router.put("/expenses/:id", upload.single("invoice"), updateExpense);
router.delete("/expenses/:id", deleteExpense);
router.post("/expenses/bulk-import", bulkImportExpenses);

// Expense Categories
router.get("/expense-categories", getExpenseCategories);
router.post("/expense-categories", createExpenseCategory);
router.put("/expense-categories/:id", updateExpenseCategory);
router.delete("/expense-categories/:id", deleteExpenseCategory);

// Ingredients
router.get("/ingredients", getIngredients);
router.post("/ingredients", createIngredient);
router.put("/ingredients/:id", updateIngredient);
router.delete("/ingredients/:id", deleteIngredient);

// Recipes
router.get("/recipes", getRecipes);
router.get("/recipes/:id", getRecipe);
router.post("/recipes", createRecipe);
router.put("/recipes/:id", updateRecipe);
router.delete("/recipes/:id", deleteRecipe);

// Inventory Transactions
router.post("/inventory/adjust", adjustInventory);
router.get("/inventory/transactions", getInventoryTransactions);

// Ingredient Purchases
router.get("/ingredient-purchases", getIngredientPurchases);
router.post("/ingredient-purchases", upload.single("invoice"), createIngredientPurchase);
router.put("/ingredient-purchases/:id", upload.single("invoice"), updateIngredientPurchase);
router.delete("/ingredient-purchases/:id", deleteIngredientPurchase);

// Outlet OPEX
router.get("/outlet-opex", getOutletOPEX);
router.post("/outlet-opex", upload.single("invoice"), createOutletOPEX);
router.put("/outlet-opex/:id", upload.single("invoice"), updateOutletOPEX);
router.delete("/outlet-opex/:id", deleteOutletOPEX);

// Outlet Assets
router.get("/outlet-assets", getOutletAssets);
router.post("/outlet-assets", upload.single("invoice"), createOutletAsset);
router.put("/outlet-assets/:id", upload.single("invoice"), updateOutletAsset);
router.delete("/outlet-assets/:id", deleteOutletAsset);

// Reports
router.get("/reports/pnl", getPnLReport);
router.get("/reports/roi", getROIReport);
router.get("/reports/profitability", getProfitabilityReport);
router.get("/reports/cost-per-dish", getCostPerDishReport);

module.exports = router;




