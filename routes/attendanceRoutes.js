const express = require("express");
const router = express.Router();
const {
  getAllAttendance,
  getTodayAttendance,
  getPastAttendance,
  checkIn,
  checkOut,
  getAttendanceStats,
  updateAttendanceStatus,
  startBreak,
  endBreak,
  checkout,
} = require("../controllers/attendanceController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Get all attendance records (admin or mobile user with filters)
router.get("/", protect, getAllAttendance);

// Get today's attendance (admin or mobile user)
router.get("/today", protect, getTodayAttendance);

// Get past attendance (excluding today) for mobile users
router.get("/past", protect, getPastAttendance);

// Check-in
router.post("/checkin", protect, authorize(["admin", "franchise_admin", "super_admin", "employee", "waiter", "cook", "captain", "manager"]), checkIn);

// Check-out
router.post("/checkout", protect, authorize(["admin", "franchise_admin", "super_admin", "employee", "waiter", "cook", "captain", "manager"]), checkOut);

// Get attendance statistics (all roles can view their own stats)
router.get("/stats", protect, getAttendanceStats);

// Update attendance status manually
router.put("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin"]), updateAttendanceStatus);

// Start break - Mobile app only
router.patch("/:id/start-break", protect, startBreak);

// End break - Mobile app only
router.patch("/:id/end-break", protect, endBreak);

// Checkout - Mobile app only
router.patch("/:id/checkout", protect, checkout);

module.exports = router;













