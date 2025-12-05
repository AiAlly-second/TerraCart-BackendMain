const express = require("express");
const router = express.Router();
const {
  getDashboardStats,
  getRecentActivity,
  getPerformanceMetrics,
} = require("../controllers/dashboardController");
const { protect, authorize } = require("../middleware/authMiddleware");

// All routes require authentication
router.use(protect);

// Get dashboard statistics (role-based)
router.get("/stats", getDashboardStats);

// Get recent activity
router.get("/recent-activity", getRecentActivity);

// Get performance metrics (Manager only)
router.get("/performance", authorize(["admin", "franchise_admin", "super_admin", "manager"]), getPerformanceMetrics);

module.exports = router;

