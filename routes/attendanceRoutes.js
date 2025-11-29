const express = require("express");
const router = express.Router();
const {
  getAllAttendance,
  getTodayAttendance,
  checkIn,
  checkOut,
  getAttendanceStats,
  updateAttendanceStatus,
} = require("../controllers/attendanceController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Get all attendance records
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin"]), getAllAttendance);

// Get today's attendance
router.get("/today", protect, authorize(["admin", "franchise_admin", "super_admin"]), getTodayAttendance);

// Check-in
router.post("/checkin", protect, authorize(["admin", "franchise_admin", "super_admin", "employee"]), checkIn);

// Check-out
router.post("/checkout", protect, authorize(["admin", "franchise_admin", "super_admin", "employee"]), checkOut);

// Get attendance statistics
router.get("/stats", protect, authorize(["admin", "franchise_admin", "super_admin"]), getAttendanceStats);

// Update attendance status manually
router.put("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin"]), updateAttendanceStatus);

module.exports = router;













