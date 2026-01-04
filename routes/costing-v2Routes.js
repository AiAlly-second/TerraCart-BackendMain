const express = require("express");
const router = express.Router();
const {
  // Suppliers
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  // Ingredients
  getIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  getFIFOLayers,
  debugIngredients,
  // Purchases
  getPurchases,
  createPurchase,
  receivePurchase,
  // Inventory
  consumeInventory,
  returnToInventory,
  getInventoryTransactions,
  getCostingInventory,
  getLowStock,
  // Waste
  recordWaste,
  getWaste,
  // Recipes
  getRecipes,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  recalculateRecipeCost,
  // Menu Items
  getMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getDefaultMenuItems,
  importFromDefaultMenu,
  // Outlets
  getOutlets,
  // Hierarchical Costing
  getHierarchicalCosting,
  // Labour & Overhead
  getLabourCosts,
  createLabourCost,
  getOverheads,
  createOverhead,
  // Reports
  getFoodCostReport,
  getMenuEngineeringReport,
  getSupplierPriceHistory,
  getPnLReport,
  // Expenses
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
  getExpenseCategories,
  createExpenseCategory,
  // Sync
  syncMenuItemsFromDefault,
  // Push
  pushToCartAdmins,
} = require("../controllers/costing-v2/costingController");
const { protect } = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/authMiddleware");

// All routes require authentication
router.use(protect);

// ==================== SUPPLIERS ====================
router.get(
  "/suppliers",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getSuppliers
);
router.post(
  "/suppliers",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createSupplier
);
router.put(
  "/suppliers/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateSupplier
);
router.delete(
  "/suppliers/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  deleteSupplier
);

// ==================== INGREDIENTS ====================
router.get(
  "/ingredients",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getIngredients
);
router.post(
  "/ingredients",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createIngredient
);
router.put(
  "/ingredients/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateIngredient
);
router.delete(
  "/ingredients/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  deleteIngredient
);
router.get(
  "/ingredients/:id/fifo-layers",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getFIFOLayers
);
router.get(
  "/ingredients/debug",
  authorize(["super_admin", "admin"]),
  debugIngredients
);

// ==================== PURCHASES ====================
router.get(
  "/purchases",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getPurchases
);
router.post(
  "/purchases",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createPurchase
);
router.post(
  "/purchases/:id/receive",
  authorize(["super_admin", "franchise_admin", "admin"]),
  receivePurchase
);

// ==================== INVENTORY ====================
// Get inventory from costing-v2 ingredients for mobile app
router.get(
  "/inventory",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "waiter",
    "cook",
    "captain",
    "manager",
  ]),
  getCostingInventory
);
router.post(
  "/inventory/consume",
  authorize(["super_admin", "franchise_admin", "admin"]),
  consumeInventory
);
router.post(
  "/inventory/return",
  authorize(["super_admin", "franchise_admin", "admin"]),
  returnToInventory
);
router.get(
  "/inventory/transactions",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getInventoryTransactions
);
router.get(
  "/low-stock",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getLowStock
);

// ==================== WASTE ====================
router.post(
  "/waste",
  authorize(["super_admin", "franchise_admin", "admin"]),
  recordWaste
);
router.get(
  "/waste",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getWaste
);

// ==================== RECIPES ====================
router.get(
  "/recipes",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getRecipes
);
router.post(
  "/recipes",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createRecipe
);
router.put(
  "/recipes/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateRecipe
);
router.delete(
  "/recipes/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  deleteRecipe
);
router.post(
  "/recipes/:id/calculate-cost",
  authorize(["super_admin", "franchise_admin", "admin"]),
  recalculateRecipeCost
);

// ==================== MENU ITEMS ====================
router.get(
  "/menu-items",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getMenuItems
);
router.post(
  "/menu-items",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createMenuItem
);
router.put(
  "/menu-items/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateMenuItem
);
router.delete("/menu-items/:id", authorize(["admin"]), deleteMenuItem); // Only cart admin can delete
router.get(
  "/default-menu-items",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getDefaultMenuItems
);
router.post(
  "/menu-items/import-from-default",
  authorize(["super_admin", "franchise_admin", "admin"]),
  importFromDefaultMenu
);

// ==================== OUTLETS ====================
router.get(
  "/outlets",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getOutlets
);

// ==================== HIERARCHICAL COSTING ====================
router.get(
  "/hierarchical-costing",
  authorize(["super_admin", "franchise_admin"]),
  getHierarchicalCosting
);

// ==================== LABOUR & OVERHEAD ====================
router.get(
  "/labour-costs",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getLabourCosts
);
router.post(
  "/labour-costs",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createLabourCost
);
router.get(
  "/overheads",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getOverheads
);
router.post(
  "/overheads",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createOverhead
);

// ==================== REPORTS ====================
router.get(
  "/reports/food-cost",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getFoodCostReport
);
router.get(
  "/reports/menu-engineering",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getMenuEngineeringReport
);
router.get(
  "/reports/supplier-price-history",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getSupplierPriceHistory
);
router.get(
  "/reports/pnl",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getPnLReport
);

// ==================== EXPENSES ====================
router.get(
  "/expenses",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getExpenses
);
router.post(
  "/expenses",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createExpense
);
router.put(
  "/expenses/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  updateExpense
);
router.delete(
  "/expenses/:id",
  authorize(["super_admin", "franchise_admin", "admin"]),
  deleteExpense
);
router.get(
  "/expenses/summary",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getExpenseSummary
);
router.get(
  "/expense-categories",
  authorize(["super_admin", "franchise_admin", "admin"]),
  getExpenseCategories
);
router.post(
  "/expense-categories",
  authorize(["super_admin", "franchise_admin", "admin"]),
  createExpenseCategory
);

// ==================== SYNC ====================
router.post(
  "/menu-items/sync-from-default",
  authorize(["super_admin", "franchise_admin", "admin"]),
  syncMenuItemsFromDefault
);

// ==================== PUSH ====================
router.post(
  "/push-to-cart-admins",
  authorize(["super_admin"]),
  pushToCartAdmins
);

module.exports = router;
