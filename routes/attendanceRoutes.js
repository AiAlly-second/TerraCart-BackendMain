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
} = require("../controllers/attendanceController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Get all attendance records
router.get("/", protect, authorize(["admin", "franchise_admin", "super_admin", "manager"]), getAllAttendance);

// Get today's attendance
router.get("/today", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getTodayAttendance);

// Get past attendance
router.get("/past", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getPastAttendance);

// Check-in
router.post("/checkin", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), checkIn);

// Check-out
router.post("/checkout", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), checkOut);

// Get attendance statistics
router.get("/stats", protect, authorize(["admin", "franchise_admin", "super_admin"]), getAttendanceStats);

// Update attendance status manually
router.put("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin"]), updateAttendanceStatus);

// Start break
router.post("/:id/start-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), startBreak);

// End break
router.post("/:id/end-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), endBreak);

module.exports = router;













