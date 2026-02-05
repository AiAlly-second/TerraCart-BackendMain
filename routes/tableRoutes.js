const express = require("express");
const router = express.Router();

const {
  listTables,
  getAvailableTables,
  lookupTableBySlug,
  getCartIdByTableId,
  createTable,
  getTable,
  updateTable,
  deleteTable,
  regenerateQrSlug,
  occupyTable,
  mergeTables,
  unmergeTables,
  getTableOccupancyDashboard,
  getPublicTables,
} = require("../controllers/tableController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Public endpoints for customer flows
router.get("/available", getAvailableTables);
router.get("/public", getPublicTables);
router.get("/public-cart-id/:tableId", getCartIdByTableId); // For cart page: get cartId from table ID
router.get("/lookup/:slug", lookupTableBySlug);
router.post("/:id/occupy", occupyTable); // Public endpoint to mark table as occupied

// Admin-protected endpoints
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), listTables);
router.get("/:id", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getTable);
router.post("/", protect, authorize(["admin"]), createTable);
router.put("/:id", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "captain", "manager"]), updateTable);
router.patch("/:id", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "captain", "manager"]), updateTable);
router.delete("/:id", protect, authorize(["admin"]), deleteTable);
router.post("/:id/regenerate-qr", protect, authorize(["admin"]), regenerateQrSlug);
router.post("/:id/reset-qr", protect, authorize(["admin"]), regenerateQrSlug);
router.post("/merge", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "captain", "manager"]), mergeTables);
router.post("/:id/unmerge", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "captain", "manager"]), unmergeTables);
router.get("/dashboard/occupancy", protect, authorize(["admin", "franchise_admin", "super_admin", "manager"]), getTableOccupancyDashboard);

module.exports = router;

