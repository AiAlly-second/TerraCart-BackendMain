const express = require("express");
const router = express.Router();
const {
  calculateDailyRevenue,
  calculateMonthlyRevenue,
  getRevenueHistory,
  getCurrentRevenue,
  getFranchiseRevenue,
  getDetailedRevenueExport,
} = require("../controllers/revenueController");
const { protect, authorize, franchiseAdmin } = require("../middleware/authMiddleware");

// Franchise admin route (must be before super_admin restriction)
router.get("/franchise", protect, franchiseAdmin, getFranchiseRevenue);

// All routes below require super admin access
router.use(protect, authorize(["super_admin"]));

// Calculate and store revenue
router.post("/calculate/daily", calculateDailyRevenue);
router.post("/calculate/monthly", calculateMonthlyRevenue);

// Get revenue data
router.get("/current", getCurrentRevenue);
router.get("/history", getRevenueHistory);
router.get("/export", getDetailedRevenueExport);

module.exports = router;

