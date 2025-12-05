/**
 * Task Reminder Service
 * Sends reminders for overdue tasks and upcoming due dates
 */

const Task = require("../models/taskModel");
const { notifyNewTask, notifyTaskCompleted } = require("./notificationService");

/**
 * Check for overdue tasks and send reminders
 * @param {Object} io - Socket.IO instance
 */
async function checkOverdueTasks(io) {
  try {
    const now = new Date();
    
    // Find overdue tasks that are not completed or cancelled
    const overdueTasks = await Task.find({
      dueDate: { $lt: now },
      status: { $nin: ["completed", "cancelled"] },
    })
      .populate("assignedTo", "name")
      .populate("cafeId", "name")
      .populate("franchiseId", "name");

    for (const task of overdueTasks) {
      // Update status to overdue if not already
      if (task.status !== "overdue") {
        task.status = "overdue";
        await task.save();
      }

      // Emit notification
      if (io) {
        io.emit("task:overdue", {
          taskId: task._id,
          title: task.title,
          dueDate: task.dueDate,
          assignedTo: task.assignedTo,
          task: task,
        });
      }
    }

    console.log(`[TASK REMINDER] Checked ${overdueTasks.length} overdue tasks`);
  } catch (error) {
    console.error("[TASK REMINDER] Error checking overdue tasks:", error);
  }
}

/**
 * Send daily task reminders
 * @param {Object} io - Socket.IO instance
 */
async function sendDailyTaskReminders(io) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Find tasks due today
    const tasksDueToday = await Task.find({
      dueDate: { $gte: today, $lt: tomorrow },
      status: { $nin: ["completed", "cancelled"] },
    })
      .populate("assignedTo", "name")
      .populate("assignedToUser", "name email");

    for (const task of tasksDueToday) {
      if (io) {
        io.emit("task:due_today", {
          taskId: task._id,
          title: task.title,
          dueDate: task.dueDate,
          task: task,
        });
      }
    }

    console.log(`[TASK REMINDER] Sent ${tasksDueToday.length} daily task reminders`);
  } catch (error) {
    console.error("[TASK REMINDER] Error sending daily reminders:", error);
  }
}

/**
 * Schedule task reminders
 * @param {Object} io - Socket.IO instance
 */
function scheduleTaskReminders(io) {
  // Check for overdue tasks every hour
  setInterval(() => {
    checkOverdueTasks(io);
  }, 60 * 60 * 1000); // 1 hour

  // Send daily reminders at 9 AM
  const now = new Date();
  const next9AM = new Date();
  next9AM.setHours(9, 0, 0, 0);
  if (next9AM <= now) {
    next9AM.setDate(next9AM.getDate() + 1);
  }

  const msUntil9AM = next9AM - now;
  setTimeout(() => {
    sendDailyTaskReminders(io);
    // Then schedule daily
    setInterval(() => {
      sendDailyTaskReminders(io);
    }, 24 * 60 * 60 * 1000); // 24 hours
  }, msUntil9AM);

  console.log("[TASK REMINDER] Task reminder service scheduled");
}

module.exports = {
  checkOverdueTasks,
  sendDailyTaskReminders,
  scheduleTaskReminders,
};

