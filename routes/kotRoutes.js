const express = require("express");
const router = express.Router();
const {
  getAllKOTs,
  getPendingKOTs,
  getKOTById,
  updateKOTStatus,
  getKOTStats,
} = require("../controllers/kotController");
const { protect, authorize } = require("../middleware/authMiddleware");

// All routes require authentication
router.use(protect);

// Get KOT statistics
router.get("/stats", getKOTStats);

// Get pending KOTs
router.get("/pending", getPendingKOTs);

// Get all KOTs
router.get("/", authorize(["chef", "cook", "admin", "franchise_admin", "super_admin", "manager"]), getAllKOTs);

// Get KOT by ID
router.get("/:id", authorize(["chef", "cook", "admin", "franchise_admin", "super_admin", "manager"]), getKOTById);

// Update KOT status (Cook, Manager)
router.patch("/:id/status", authorize(["chef", "cook", "admin", "franchise_admin", "super_admin", "manager"]), updateKOTStatus);

module.exports = router;

