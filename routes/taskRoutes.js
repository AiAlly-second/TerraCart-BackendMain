const express = require("express");
const router = express.Router();
const {
  getAllTasks,
  getTodayTasks,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  getTaskStats,
} = require("../controllers/taskController");
const { protect, authorize } = require("../middleware/authMiddleware");

// All routes require authentication
router.use(protect);

// Get task statistics
router.get("/stats", getTaskStats);

// Get today's tasks
router.get("/today", getTodayTasks);

// Get all tasks
router.get("/", getAllTasks);

// Get task by ID
router.get("/:id", getTaskById);

// Create task (Admin, Manager, and Mobile roles: waiter, cook, captain, manager)
router.post("/", authorize(["admin", "franchise_admin", "super_admin", "manager", "waiter", "cook", "captain"]), createTask);

// Update task
router.patch("/:id", updateTask);

// Mark task as complete
router.patch("/:id/complete", completeTask);

// Delete task (Manager only)
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin", "manager"]), deleteTask);

module.exports = router;

