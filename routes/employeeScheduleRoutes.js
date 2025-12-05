const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllSchedules,
  getEmployeeSchedule,
  upsertSchedule,
  updateTodayState,
  deleteSchedule,
} = require("../controllers/employeeScheduleController");

router.use(protect); // All routes require authentication

router.get("/", getAllSchedules);
// Get own schedule for mobile users (no employeeId needed) - must be before /employee/:employeeId
router.get("/my-schedule", getEmployeeSchedule);
router.get("/employee/:employeeId", getEmployeeSchedule);
// Create or update schedule (mobile users can update their own schedule)
router.post("/", upsertSchedule);
router.put("/employee/:employeeId/today-state", updateTodayState);
router.delete("/employee/:employeeId", deleteSchedule);

module.exports = router;













