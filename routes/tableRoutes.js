const express = require("express");
const router = express.Router();

const {
  listTables,
  getAvailableTables,
  lookupTableBySlug,
  createTable,
  updateTable,
  deleteTable,
  regenerateQrSlug,
  occupyTable,
  mergeTables,
  unmergeTables,
  getTableOccupancyDashboard,
} = require("../controllers/tableController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Public endpoints for customer flows
router.get("/available", getAvailableTables);
router.get("/lookup/:slug", lookupTableBySlug);
router.post("/:id/occupy", occupyTable); // Public endpoint to mark table as occupied

// Admin-protected endpoints
// Mobile app access: waiter, cook, manager, captain can view tables for order management
router.get(
  "/",
  protect,
  authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "manager", "captain"]),
  listTables
);
router.post("/", protect, authorize(["admin"]), createTable);
router.put("/:id", protect, authorize(["admin"]), updateTable);
router.patch("/:id", protect, authorize(["admin"]), updateTable);
router.delete("/:id", protect, authorize(["admin"]), deleteTable);
router.post("/:id/regenerate-qr", protect, authorize(["admin"]), regenerateQrSlug);
router.post("/:id/reset-qr", protect, authorize(["admin"]), regenerateQrSlug);
router.post("/merge", protect, authorize(["admin", "franchise_admin", "super_admin"]), mergeTables);
router.post("/:id/unmerge", protect, authorize(["admin", "franchise_admin", "super_admin"]), unmergeTables);
router.get("/dashboard/occupancy", protect, authorize(["admin", "franchise_admin", "super_admin"]), getTableOccupancyDashboard);

module.exports = router;

