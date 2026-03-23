const express = require("express");
const multer = require("multer");
const path = require("path");
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
  directPurchase,
  getInventoryTransactions,
  diagnoseConsumption,
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
  linkMatchingBoms,
  // Push
  pushToCartAdmins,
} = require("../controllers/costing-v2/costingController");
const { protect } = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/authMiddleware");
const { getStorageCallback } = require("../config/uploadConfig");

const uploadInvoiceImage = multer({
  storage: getStorageCallback("invoices"),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = new Set([
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".heic",
      ".heif",
      ".pdf",
    ]);
    const ext = path.extname(file.originalname || "").toLowerCase();

    const allowedMimes = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/heic-sequence",
      "image/heif-sequence",
      "application/pdf",
      // Some devices/providers send generic type for camera-captured files.
      "application/octet-stream",
    ]);
    const mime = (file.mimetype || "").toLowerCase();

    const isAllowedMime = allowedMimes.has(mime);
    const isAllowedByExtension =
      allowedExtensions.has(ext) &&
      (mime === "application/octet-stream" || mime === "");

    if (isAllowedMime || isAllowedByExtension) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only invoice images/PDF files (JPG, PNG, WEBP, HEIC, HEIF, PDF) are allowed"
        ),
        false
      );
    }
  },
});

const handleInventoryInvoiceUpload = (req, res, next) => {
  uploadInvoiceImage.single("invoiceImage")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "Invoice file is too large. Maximum allowed size is 15MB.",
        });
      }
      return res.status(400).json({
        success: false,
        message: error.message || "Invoice upload failed.",
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Invalid invoice file.",
    });
  });
};

// All routes require authentication
router.use(protect);

// ==================== SUPPLIERS ====================
router.get(
  "/suppliers",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getSuppliers
);
router.post(
  "/suppliers",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  createSupplier
);
router.put(
  "/suppliers/:id",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  updateSupplier
);
router.delete(
  "/suppliers/:id",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  deleteSupplier
);

// ==================== INGREDIENTS ====================
router.get(
  "/ingredients",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getIngredients
);
router.post(
  "/ingredients",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  createIngredient
);
router.put(
  "/ingredients/:id",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
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
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getPurchases
);
router.post(
  "/purchases",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  createPurchase
);
router.post(
  "/purchases/:id/receive",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  receivePurchase
);

// ==================== INVENTORY ====================
// Get inventory from costing-v2 ingredients (cook + manager for mobile app; admin roles for web)
router.get(
  "/inventory",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "manager",
    "cook",
  ]),
  getCostingInventory
);
router.post(
  "/inventory/consume",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  consumeInventory
);
router.post(
  "/inventory/return",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  returnToInventory
);
router.post(
  "/inventory/direct-purchase",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  handleInventoryInvoiceUpload,
  directPurchase
);
router.get(
  "/inventory/transactions",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getInventoryTransactions
);
router.get(
  "/diagnose-consumption",
  authorize(["super_admin", "franchise_admin", "admin"]),
  diagnoseConsumption
);
router.get(
  "/low-stock",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  getLowStock
);

// ==================== WASTE ====================
router.post(
  "/waste",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  recordWaste
);
router.get(
  "/waste",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
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
router.post(
  "/menu-items/link-matching-boms",
  authorize(["super_admin", "franchise_admin", "admin"]),
  linkMatchingBoms
);

// ==================== PUSH ====================
router.post(
  "/push-to-cart-admins",
  authorize(["super_admin"]),
  pushToCartAdmins
);

module.exports = router;
