const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getAllSchedules,
  getEmployeeSchedule,
  getMySchedule,
  upsertSchedule,
  updateTodayState,
  deleteSchedule,
} = require("../controllers/employeeScheduleController");

router.use(protect); // All routes require authentication

router.get(
  "/",
  authorize(["super_admin", "franchise_admin", "admin", "manager", "captain"]),
  getAllSchedules
);
router.get(
  "/my-schedule",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "manager",
    "captain",
    "waiter",
    "cook",
    "employee",
  ]),
  getMySchedule
);
router.get(
  "/employee/:employeeId",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "manager",
    "captain",
    "waiter",
    "cook",
    "employee",
  ]),
  getEmployeeSchedule
);
router.post(
  "/",
  authorize([
    "super_admin",
    "franchise_admin",
    "admin",
    "manager",
    "captain",
    "waiter",
    "cook",
    "employee",
  ]),
  upsertSchedule
);
router.put(
  "/employee/:employeeId/today-state",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  updateTodayState
);
router.delete(
  "/employee/:employeeId",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  deleteSchedule
);

module.exports = router;













