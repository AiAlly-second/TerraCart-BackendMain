const express = require("express");
const router = express.Router();

const {
  createLeaveRequest,
  getMyLeaveRequests,
  getLeaveRequests,
  updateLeaveRequestStatus,
} = require("../controllers/leaveRequestController");
const { protect, authorize } = require("../middleware/authMiddleware");

router.use(protect);

router.get(
  "/my",
  authorize([
    "waiter",
    "cook",
    "captain",
    "manager",
    "employee",
    "admin",
    "franchise_admin",
    "super_admin",
  ]),
  getMyLeaveRequests
);

router.get(
  "/",
  authorize([
    "waiter",
    "cook",
    "captain",
    "manager",
    "employee",
    "admin",
    "franchise_admin",
    "super_admin",
  ]),
  getLeaveRequests
);

router.post(
  "/",
  authorize([
    "waiter",
    "cook",
    "captain",
    "manager",
    "employee",
    "admin",
    "franchise_admin",
    "super_admin",
  ]),
  createLeaveRequest
);

router.patch(
  "/:id/status",
  authorize(["manager", "admin", "franchise_admin", "super_admin"]),
  updateLeaveRequestStatus
);

module.exports = router;
