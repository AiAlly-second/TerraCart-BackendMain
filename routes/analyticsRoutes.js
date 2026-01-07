const express = require("express");
const router = express.Router();
const {
  getAnalyticsSummary,
  getOrderAnalytics,
  getMenuAnalytics,
  getEmployeeAnalytics,
  getRevenueAnalytics,
  getCustomerAnalytics,
  getAttendanceAnalytics,
  getInventoryAnalytics,
  exportAnalyticsData,
} = require("../controllers/analyticsController");
const { protect, authorize } = require("../middleware/authMiddleware");

// All analytics routes require authentication and admin/franchise_admin/super_admin role
const adminRoles = ["admin", "franchise_admin", "super_admin"];

// GET /api/analytics/summary - Overall analytics summary
router.get("/summary", protect, authorize(adminRoles), getAnalyticsSummary);

// GET /api/analytics/orders - Order analytics (sales, trends, popular items)
router.get("/orders", protect, authorize(adminRoles), getOrderAnalytics);

// GET /api/analytics/menu - Menu performance analytics
router.get("/menu", protect, authorize(adminRoles), getMenuAnalytics);

// GET /api/analytics/employees - Employee performance analytics
router.get("/employees", protect, authorize(adminRoles), getEmployeeAnalytics);

// GET /api/analytics/revenue - Revenue and financial analytics
router.get("/revenue", protect, authorize(adminRoles), getRevenueAnalytics);

// GET /api/analytics/customers - Customer analytics
router.get("/customers", protect, authorize(adminRoles), getCustomerAnalytics);

// GET /api/analytics/attendance - Attendance analytics
router.get("/attendance", protect, authorize(adminRoles), getAttendanceAnalytics);

// GET /api/analytics/inventory - Inventory analytics (if applicable)
router.get("/inventory", protect, authorize(adminRoles), getInventoryAnalytics);

// GET /api/analytics/export - Export all analytics data (for Fabric/external tools)
router.get("/export", protect, authorize(adminRoles), exportAnalyticsData);

module.exports = router;
