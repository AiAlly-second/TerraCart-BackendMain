const express = require("express");
const router = express.Router();
const {
  getAllTasks,
  getMyTasks,
  getTodayTasks,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  getTaskStats,
} = require("../controllers/taskController");
const { protect, authorize } = require("../middleware/authMiddleware");

router.use(protect);

// Get all tasks (filtered by cart/kiosk)
router.get("/", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getAllTasks);

// Get my tasks (for mobile users)
router.get("/my", authorize(["waiter", "cook", "captain", "manager"]), getMyTasks);

// Get today's tasks
router.get("/today", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getTodayTasks);

// Get task statistics
router.get("/stats", authorize(["admin", "franchise_admin", "super_admin", "manager"]), getTaskStats);

// Get task by ID
router.get("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), getTaskById);

// Create task
router.post("/", authorize(["admin", "franchise_admin", "super_admin", "manager", "captain"]), createTask);

// Update task
router.put("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), updateTask);
router.patch("/:id", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), updateTask);

// Complete task
router.post("/:id/complete", authorize(["admin", "franchise_admin", "super_admin", "waiter", "cook", "captain", "manager"]), completeTask);

// Delete task
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), deleteTask);

module.exports = router;

