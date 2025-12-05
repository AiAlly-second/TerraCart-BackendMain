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

// Get dashboard statistics
router.get(
  "/stats",
  authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]),
  getDashboardStats
);

// Get recent activity
router.get(
  "/recent-activity",
  authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]),
  getRecentActivity
);

// Get performance metrics
router.get(
  "/performance",
  authorize(["admin", "franchise_admin", "super_admin", "manager"]),
  getPerformanceMetrics
);

module.exports = router;

