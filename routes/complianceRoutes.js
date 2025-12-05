const express = require("express");
const router = express.Router();
const {
  getAllCompliance,
  getExpiringCompliance,
  getComplianceById,
  createCompliance,
  updateCompliance,
  deleteCompliance,
  getComplianceStats,
} = require("../controllers/complianceController");
const { protect, authorize } = require("../middleware/authMiddleware");

// All routes require authentication and manager role
router.use(protect);
router.use(authorize(["admin", "franchise_admin", "super_admin", "manager"]));

// Get compliance statistics
router.get("/stats", getComplianceStats);

// Get expiring compliance documents
router.get("/expiring", getExpiringCompliance);

// Get all compliance documents
router.get("/", getAllCompliance);

// Get compliance document by ID
router.get("/:id", getComplianceById);

// Create compliance document
router.post("/", createCompliance);

// Update compliance document
router.patch("/:id", updateCompliance);

// Delete compliance document
router.delete("/:id", deleteCompliance);

module.exports = router;

