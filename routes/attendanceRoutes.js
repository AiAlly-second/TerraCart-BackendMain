const express = require("express");
const router = express.Router();
const {
  getAllAttendance,
  getTodayAttendance,
  getPastAttendance,
  checkIn,
  checkOut,
  checkOutById,
  getAttendanceStats,
  updateAttendanceStatus,
  deleteAttendance,
  startBreak,
  endBreak,
} = require("../controllers/attendanceController");
const { protect, authorize } = require("../middleware/authMiddleware");

// Get all attendance records - role-scoped in controller, role-guarded at route level
router.get(
  "/",
  protect,
  authorize([
    "admin",
    "franchise_admin",
    "super_admin",
    "waiter",
    "cook",
    "captain",
    "manager",
    "employee",
  ]),
  getAllAttendance
);

// Get today's attendance
router.get("/today", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getTodayAttendance);

// Get past attendance
router.get("/past", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getPastAttendance);

// Check-in
router.post("/checkin", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), checkIn);

// Check-out (legacy - accepts employeeId in body)
router.post("/checkout", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), checkOut);

// Check-out by attendance ID (new - accepts attendanceId in path)
router.patch("/:id/checkout", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), checkOutById);

// Get attendance statistics
router.get("/stats", protect, authorize(["admin", "franchise_admin", "super_admin"]), getAttendanceStats);

// Update attendance status manually (admin, manager)
router.put("/:id/status", protect, authorize(["admin", "franchise_admin", "super_admin", "manager"]), updateAttendanceStatus);

// Delete attendance record (admin, manager)
router.delete("/:id", protect, authorize(["admin", "franchise_admin", "super_admin", "manager"]), deleteAttendance);

// Start break (support both POST and PATCH for compatibility)
router.post("/:id/start-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), startBreak);
router.patch("/:id/start-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), startBreak);

// End break (support both POST and PATCH for compatibility)
router.post("/:id/end-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), endBreak);
router.patch("/:id/end-break", protect, authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), endBreak);

module.exports = router;












