const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllSchedules,
  getEmployeeSchedule,
  getMySchedule,
  upsertSchedule,
  updateTodayState,
  deleteSchedule,
} = require("../controllers/employeeScheduleController");

router.use(protect); // All routes require authentication

router.get("/", getAllSchedules);
router.get("/my-schedule", getMySchedule);
router.get("/employee/:employeeId", getEmployeeSchedule);
router.post("/", upsertSchedule);
router.put("/employee/:employeeId/today-state", updateTodayState);
router.delete("/employee/:employeeId", deleteSchedule);

module.exports = router;













