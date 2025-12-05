const Task = require("../models/taskModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - get their cafeId from user or employee record
    if (user.cafeId) {
      query.cafeId = user.cafeId;
    } else if (user.employeeId) {
      const employee = await Employee.findById(user.employeeId).lean();
      if (employee && employee.cafeId) {
        query.cafeId = employee.cafeId;
      }
    } else {
      // Fallback: find by email
      const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employee && employee.cafeId) {
        query.cafeId = employee.cafeId;
      }
    }
  } else if (user.role === "employee") {
    // Legacy employee role
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    if (employee && employee.cafeId) {
      query.cafeId = employee.cafeId;
    }
  }
  return query;
};

// Get all tasks
exports.getAllTasks = async (req, res) => {
  try {
    const { status, priority, category, assignedTo } = req.query;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { ...hierarchyQuery };

    if (status) {
      query.status = status;
    }
    if (priority) {
      query.priority = priority;
    }
    if (category) {
      query.category = category;
    }
    if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    const tasks = await Task.find(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .populate("completedBy", "name mobile employeeRole")
      .sort({ createdAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get my tasks (for mobile users)
exports.getMyTasks = async (req, res) => {
  try {
    const { status } = req.query;
    const user = req.user;
    
    // Get employeeId for mobile users
    let employeeId = null;
    if (user.employeeId) {
      employeeId = user.employeeId;
    } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const employee = await Employee.findOne({ 
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      }).lean();
      if (employee) {
        employeeId = employee._id;
      }
    }

    if (!employeeId) {
      return res.status(404).json({ message: "Employee record not found" });
    }

    const query = { assignedTo: employeeId };
    if (status) {
      query.status = status;
    }

    const tasks = await Task.find(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("completedBy", "name mobile employeeRole")
      .sort({ priority: 1, createdAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get today's tasks
exports.getTodayTasks = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = {
      ...hierarchyQuery,
      $or: [
        { dueDate: { $gte: today, $lt: tomorrow } },
        { createdAt: { $gte: today, $lt: tomorrow } },
      ],
    };

    const tasks = await Task.find(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .sort({ priority: 1, createdAt: -1 })
      .lean();

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get task by ID
exports.getTaskById = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const task = await Task.findOne(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .populate("completedBy", "name mobile employeeRole");

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    return res.json(task);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create task
exports.createTask = async (req, res) => {
  try {
    const taskData = { ...req.body };
    const user = req.user;

    // Set hierarchy relationships
    if (user.role === "admin") {
      taskData.cafeId = user._id;
      if (user.franchiseId) {
        taskData.franchiseId = user.franchiseId;
      }
    } else if (user.role === "franchise_admin") {
      taskData.franchiseId = user._id;
      if (taskData.cafeId) {
        // Validate cafeId belongs to this franchise
        const cafe = await User.findById(taskData.cafeId);
        if (!cafe || cafe.franchiseId?.toString() !== user._id.toString()) {
          return res.status(403).json({ message: "Invalid cafe selection" });
        }
      }
    } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      // Mobile users can create tasks for their cart
      if (user.cafeId) {
        taskData.cafeId = user.cafeId;
      } else if (user.employeeId) {
        const employee = await Employee.findById(user.employeeId).lean();
        if (employee && employee.cafeId) {
          taskData.cafeId = employee.cafeId;
        }
      }
      if (user.franchiseId) {
        taskData.franchiseId = user.franchiseId;
      }
    }

    // If assignedTo is provided, also set assignedToUser
    if (taskData.assignedTo) {
      const employee = await Employee.findById(taskData.assignedTo).lean();
      if (employee && employee.userId) {
        taskData.assignedToUser = employee.userId;
      }
    }

    const task = await Task.create(taskData);
    await task.populate("assignedTo", "name mobile employeeRole");
    await task.populate("assignedToUser", "name email role");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && task.cafeId) {
      emitToCafe(io, task.cafeId.toString(), "task:created", task);
    }

    return res.status(201).json(task);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update task
exports.updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const task = await Task.findOne(query);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Update fields
    Object.keys(updates).forEach((key) => {
      if (key !== "_id" && key !== "cafeId" && key !== "franchiseId") {
        task[key] = updates[key];
      }
    });

    // If status changed to completed, set completedAt and completedBy
    if (updates.status === "completed" && task.status !== "completed") {
      task.completedAt = new Date();
      // Set completedBy from current user's employeeId
      if (req.user.employeeId) {
        task.completedBy = req.user.employeeId;
      } else if (["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
        const employee = await Employee.findOne({
          $or: [
            { userId: req.user._id },
            { email: req.user.email?.toLowerCase() }
          ]
        }).lean();
        if (employee) {
          task.completedBy = employee._id;
        }
      }
    }

    await task.save();
    await task.populate("assignedTo", "name mobile employeeRole");
    await task.populate("assignedToUser", "name email role");
    await task.populate("completedBy", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && task.cafeId) {
      emitToCafe(io, task.cafeId.toString(), "task:updated", task);
      if (task.status === "completed") {
        emitToCafe(io, task.cafeId.toString(), "task:completed", task);
      }
    }

    return res.json(task);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Complete task
exports.completeTask = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const task = await Task.findOne(query);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (task.status === "completed") {
      return res.status(400).json({ message: "Task already completed" });
    }

    task.status = "completed";
    task.completedAt = new Date();
    
    // Set completedBy from current user's employeeId
    if (req.user.employeeId) {
      task.completedBy = req.user.employeeId;
    } else if (["waiter", "cook", "captain", "manager"].includes(req.user.role)) {
      const employee = await Employee.findOne({
        $or: [
          { userId: req.user._id },
          { email: req.user.email?.toLowerCase() }
        ]
      }).lean();
      if (employee) {
        task.completedBy = employee._id;
      }
    }

    await task.save();
    await task.populate("assignedTo", "name mobile employeeRole");
    await task.populate("completedBy", "name mobile employeeRole");

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && task.cafeId) {
      emitToCafe(io, task.cafeId.toString(), "task:completed", task);
      emitToCafe(io, task.cafeId.toString(), "task:updated", task);
    }

    return res.json(task);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete task
exports.deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = { _id: id, ...hierarchyQuery };

    const task = await Task.findOne(query);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const cafeId = task.cafeId;
    await Task.deleteOne({ _id: id });

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && cafeId) {
      emitToCafe(io, cafeId.toString(), "task:deleted", { id });
    }

    return res.json({ message: "Task deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get task statistics
exports.getTaskStats = async (req, res) => {
  try {
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const tasks = await Task.find(hierarchyQuery).lean();

    const stats = {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
      overdue: tasks.filter((t) => {
        if (t.status === "completed" || t.status === "cancelled") return false;
        if (!t.dueDate) return false;
        return new Date(t.dueDate) < new Date();
      }).length,
    };

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

