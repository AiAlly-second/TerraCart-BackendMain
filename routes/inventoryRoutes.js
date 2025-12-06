const express = require("express");
const {
  getAllInventory,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  updateStock,
  getInventoryStats,
  getAvailableIngredients,
} = require("../controllers/inventoryController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// All routes require authentication
router.use(protect);

// Get available ingredients from costing-v2 for managers
router.get("/available-ingredients", authorize(["admin", "franchise_admin", "super_admin", "manager"]), getAvailableIngredients);

// Get inventory statistics
router.get("/stats", authorize(["admin", "franchise_admin", "super_admin", "manager"]), getInventoryStats);

// Get all inventory items
router.get("/", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getAllInventory);

// Get single inventory item
router.get("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getInventoryItem);

// Create inventory item
router.post("/", authorize(["admin", "franchise_admin", "super_admin", "manager"]), createInventoryItem);

// Update inventory item
router.patch("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), updateInventoryItem);

// Update stock quantity
router.patch("/:id/stock", authorize(["admin", "franchise_admin", "super_admin", "manager"]), updateStock);

// Delete inventory item
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), deleteInventoryItem);

module.exports = router;











