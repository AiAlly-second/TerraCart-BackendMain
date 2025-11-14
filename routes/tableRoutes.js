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
} = require("../controllers/tableController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Public endpoints for customer flows
router.get("/available", getAvailableTables);
router.get("/lookup/:slug", lookupTableBySlug);
router.post("/:id/occupy", occupyTable); // Public endpoint to mark table as occupied

// Admin-protected endpoints
router.get("/", protect, authorize(["admin"]), listTables);
router.post("/", protect, authorize(["admin"]), createTable);
router.put("/:id", protect, authorize(["admin"]), updateTable);
router.patch("/:id", protect, authorize(["admin"]), updateTable);
router.delete("/:id", protect, authorize(["admin"]), deleteTable);
router.post("/:id/regenerate-qr", protect, authorize(["admin"]), regenerateQrSlug);
router.post("/:id/reset-qr", protect, authorize(["admin"]), regenerateQrSlug);

module.exports = router;

