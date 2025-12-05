const Task = require("../models/taskModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * @desc    Get all tasks (filtered by role and data isolation)
 * @route   GET /api/tasks
 * @access  Private (Staff, Cook, Manager)
 */
exports.getAllTasks = asyncHandler(async (req, res) => {
  const {
    status,
    category,
    priority,
    assignedTo,
    dueDateFrom,
    dueDateTo,
    page = 1,
    limit = 20,
    sort = "-createdAt",
  } = req.query;

  // For mobile roles (waiter, cook, captain, manager), get tasks from User.tasks array
  const mobileRoles = ["waiter", "cook", "captain", "manager"];
  if (mobileRoles.includes(req.user.role)) {
    const user = await User.findById(req.user._id).select("tasks");
    let tasks = user && user.tasks ? user.tasks : [];

    // Apply filters
    if (status) {
      tasks = tasks.filter(task => task.status === status);
    }
    if (category) {
      tasks = tasks.filter(task => task.category === category);
    }
    if (priority) {
      tasks = tasks.filter(task => task.priority === priority);
    }

    // Convert to array for sorting
    const tasksArray = tasks.map(task => task.toObject());
    
    // Simple sorting (for createdAt)
    if (sort === "-createdAt" || sort === "-updatedAt") {
      tasksArray.sort((a, b) => {
        const dateA = new Date(a.createdAt || a.updatedAt);
        const dateB = new Date(b.createdAt || b.updatedAt);
        return dateB - dateA;
      });
    }

    // Pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    const paginatedTasks = tasksArray.slice(skip, skip + limitNum);

    return res.status(200).json({
      success: true,
      data: paginatedTasks,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: tasksArray.length,
        pages: Math.ceil(tasksArray.length / limitNum),
      },
    });
  }

  // For admin roles, use Task collection
  // Build query with data isolation
  const query = {};
  
  // Data isolation based on user role
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  // Role-based filtering
  if (req.user.role === "cashier" || req.user.role === "cleaner") {
    // Staff can only see tasks assigned to them
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee) {
      query.assignedTo = employee._id;
    } else {
      query.assignedToUser = req.user._id;
    }
  } else if (req.user.role === "chef" || req.user.role === "cook") {
    // Cooks can see kitchen-related tasks
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee) {
      query.assignedTo = employee._id;
      query.category = { $in: ["inventory", "cleaning", "maintenance", "other"] };
    }
  }
  // Managers can see all tasks (no additional filtering)

  // Apply filters
  if (status) query.status = status;
  if (category) query.category = category;
  if (priority) query.priority = priority;
  if (assignedTo) query.assignedTo = assignedTo;
  if (dueDateFrom || dueDateTo) {
    query.dueDate = {};
    if (dueDateFrom) query.dueDate.$gte = new Date(dueDateFrom);
    if (dueDateTo) query.dueDate.$lte = new Date(dueDateTo);
  }

  // Pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Execute query
  const tasks = await Task.find(query)
    .populate("assignedTo", "name employeeRole")
    .populate("assignedToUser", "name email")
    .populate("completedBy", "name employeeRole")
    .sort(sort)
    .skip(skip)
    .limit(limitNum);

  const total = await Task.countDocuments(query);

  res.status(200).json({
    success: true,
    data: tasks,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * @desc    Get today's tasks
 * @route   GET /api/tasks/today
 * @access  Private
 */
exports.getTodayTasks = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
  const dayOfMonth = today.getDate();

  // For mobile roles (waiter, cook, captain, manager), get tasks from User.tasks array
  const mobileRoles = ["waiter", "cook", "captain", "manager"];
  if (mobileRoles.includes(req.user.role)) {
    const user = await User.findById(req.user._id).select("tasks");
    if (user && user.tasks && user.tasks.length > 0) {
      // Filter tasks based on frequency
      const todayTasks = user.tasks.filter(task => {
        // Daily tasks always show
        if (task.frequency === "daily") {
          return true;
        }
        // Weekly tasks show on the same day of week they were created
        if (task.frequency === "weekly") {
          const taskCreatedDate = new Date(task.createdAt);
          return taskCreatedDate.getDay() === dayOfWeek;
        }
        // Monthly tasks show on the same day of month they were created
        if (task.frequency === "monthly") {
          const taskCreatedDate = new Date(task.createdAt);
          return taskCreatedDate.getDate() === dayOfMonth;
        }
        // One-time tasks show only if not completed and due today
        if (task.frequency === "one_time") {
          return task.status === "incomplete";
        }
        return false;
      });

      return res.status(200).json({
        success: true,
        data: todayTasks,
      });
    } else {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }
  }

  // For admin roles, use Task collection
  const query = {
    dueDate: { $gte: today, $lt: tomorrow },
  };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  // Role-based filtering
  if (req.user.role === "cashier" || req.user.role === "cleaner") {
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee) {
      query.assignedTo = employee._id;
    } else {
      query.assignedToUser = req.user._id;
    }
  }

  const tasks = await Task.find(query)
    .populate("assignedTo", "name employeeRole")
    .populate("assignedToUser", "name email")
    .sort("priority -dueDate");

  res.status(200).json({
    success: true,
    data: tasks,
  });
});

/**
 * @desc    Get task by ID
 * @route   GET /api/tasks/:id
 * @access  Private
 */
exports.getTaskById = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const task = await Task.findOne(query)
    .populate("assignedTo", "name employeeRole")
    .populate("assignedToUser", "name email")
    .populate("completedBy", "name employeeRole");

  if (!task) {
    return res.status(404).json({
      success: false,
      message: "Task not found",
    });
  }

  res.status(200).json({
    success: true,
    data: task,
  });
});

/**
 * @desc    Create task
 * @route   POST /api/tasks
 * @access  Private (Admin, Manager, and Mobile roles: waiter, cook, captain, manager)
 */
exports.createTask = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    category,
    frequency,
    assignedTo,
    assignedToUser,
    dueDate,
    priority,
    notes,
  } = req.body;

  // Validate required fields
  if (!title) {
    return res.status(400).json({
      success: false,
      message: "Title is required",
    });
  }

  const mobileRoles = ["waiter", "cook", "captain", "manager"];
  
  // For mobile roles, save task to User.tasks array
  if (mobileRoles.includes(req.user.role)) {
    const taskData = {
      title,
      description: description || "",
      category: category || "daily",
      frequency: frequency || "daily",
      status: "incomplete",
      priority: priority || "medium",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Determine target user (self or assigned user)
    // Managers can assign tasks to waiters/cooks/captains
    let targetUserId = req.user._id;
    if (assignedToUser && (req.user.role === "manager" || req.user.role === "admin" || req.user.role === "franchise_admin" || req.user.role === "super_admin")) {
      // Verify the target user is a mobile role (waiter, cook, captain, manager)
      const targetUser = await User.findById(assignedToUser);
      if (!targetUser) {
        return res.status(404).json({
          success: false,
          message: "Target user not found",
        });
      }
      if (!mobileRoles.includes(targetUser.role)) {
        return res.status(400).json({
          success: false,
          message: "Tasks can only be assigned to waiter, cook, captain, or manager roles",
        });
      }
      targetUserId = assignedToUser;
    }

    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Add task to user's tasks array
    if (!user.tasks) {
      user.tasks = [];
    }
    user.tasks.push(taskData);
    await user.save();

    const createdTask = user.tasks[user.tasks.length - 1];

    // Emit Socket.IO event
    if (req.app.get("io")) {
      req.app.get("io").emit("task:created", {
        ...createdTask.toObject(),
        userId: user._id,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: createdTask,
    });
  }

  // For admin roles, use Task collection
  const taskData = {
    title,
    description: description || "",
    category: category || "daily",
    frequency: frequency || "daily",
    dueDate: dueDate ? new Date(dueDate) : new Date(),
    priority: priority || "medium",
    notes: notes || "",
  };

  // Data isolation
  if (req.user.cafeId) {
    taskData.cafeId = req.user.cafeId;
    taskData.franchiseId = req.user.franchiseId;
  } else if (req.user.franchiseId) {
    taskData.franchiseId = req.user.franchiseId;
  }

  // Assign task
  if (assignedTo) {
    taskData.assignedTo = assignedTo;
  } else if (assignedToUser) {
    taskData.assignedToUser = assignedToUser;
  }

  const task = await Task.create(taskData);

  // Populate and return
  await task.populate("assignedTo", "name employeeRole");
  await task.populate("assignedToUser", "name email");

  // Emit Socket.IO event
  if (req.app.get("io")) {
    req.app.get("io").emit("task:created", task);
  }

  res.status(201).json({
    success: true,
    message: "Task created successfully",
    data: task,
  });
});

/**
 * @desc    Update task
 * @route   PATCH /api/tasks/:id
 * @access  Private
 */
exports.updateTask = asyncHandler(async (req, res) => {
  const mobileRoles = ["waiter", "cook", "captain", "manager"];
  
  // For mobile roles, update task in User.tasks array
  if (mobileRoles.includes(req.user.role)) {
    const taskId = req.params.id;
    const user = await User.findById(req.user._id);
    
    if (!user || !user.tasks || user.tasks.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Find task by _id (MongoDB subdocument _id)
    const taskIndex = user.tasks.findIndex(
      task => task._id.toString() === taskId
    );

    if (taskIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Update allowed fields
    const allowedFields = ["title", "description", "category", "frequency", "priority", "status"];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        user.tasks[taskIndex][field] = req.body[field];
      }
    });
    
    user.tasks[taskIndex].updatedAt = new Date();
    await user.save();

    // Emit Socket.IO event
    if (req.app.get("io")) {
      req.app.get("io").emit("task:updated", {
        taskId: taskId,
        userId: user._id,
        task: user.tasks[taskIndex],
      });
    }

    return res.status(200).json({
      success: true,
      message: "Task updated successfully",
      data: user.tasks[taskIndex],
    });
  }

  // For admin roles, use Task collection
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const task = await Task.findOne(query);

  if (!task) {
    return res.status(404).json({
      success: false,
      message: "Task not found",
    });
  }

  // Check permissions - staff can only update their own tasks
  if (req.user.role === "cashier" || req.user.role === "cleaner") {
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee && task.assignedTo?.toString() !== employee._id.toString()) {
      if (task.assignedToUser?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to update this task",
        });
      }
    }
  }

  // Update fields
  const allowedFields = ["title", "description", "category", "frequency", "assignedTo", "assignedToUser", "dueDate", "priority", "notes", "status"];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      task[field] = req.body[field];
    }
  });

  await task.save();

  await task.populate("assignedTo", "name employeeRole");
  await task.populate("assignedToUser", "name email");

  // Emit Socket.IO event
  if (req.app.get("io")) {
    req.app.get("io").emit("task:updated", task);
  }

  res.status(200).json({
    success: true,
    message: "Task updated successfully",
    data: task,
  });
});

/**
 * @desc    Mark task as complete
 * @route   PATCH /api/tasks/:id/complete
 * @access  Private
 */
exports.completeTask = asyncHandler(async (req, res) => {
  const mobileRoles = ["waiter", "cook", "captain", "manager"];
  
  // For mobile roles, update task in User.tasks array
  if (mobileRoles.includes(req.user.role)) {
    const taskId = req.params.id;
    const user = await User.findById(req.user._id);
    
    if (!user || !user.tasks || user.tasks.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Find task by _id (MongoDB subdocument _id)
    const taskIndex = user.tasks.findIndex(
      task => task._id.toString() === taskId
    );

    if (taskIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Update task status
    user.tasks[taskIndex].status = "complete";
    user.tasks[taskIndex].completedAt = new Date();
    user.tasks[taskIndex].completedBy = req.user._id;
    user.tasks[taskIndex].updatedAt = new Date();
    
    await user.save();

    // Emit Socket.IO event
    if (req.app.get("io")) {
      req.app.get("io").emit("task:completed", {
        taskId: taskId,
        userId: user._id,
        task: user.tasks[taskIndex],
      });
    }

    return res.status(200).json({
      success: true,
      message: "Task completed successfully",
      data: user.tasks[taskIndex],
    });
  }

  // For admin roles, use Task collection
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const task = await Task.findOne(query);

  if (!task) {
    return res.status(404).json({
      success: false,
      message: "Task not found",
    });
  }

  // Check permissions
  if (req.user.role === "waiter" || req.user.role === "cashier" || req.user.role === "cleaner") {
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee && task.assignedTo?.toString() !== employee._id.toString()) {
      if (task.assignedToUser?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to complete this task",
        });
      }
    }
  }

  // Update task status
  task.status = "completed";
  task.completedAt = new Date();
  if (req.user.employeeId) {
    task.completedBy = req.user.employeeId;
  }

  await task.save();
  await task.populate("assignedTo", "name employeeRole");
  await task.populate("assignedToUser", "name email");
  await task.populate("completedBy", "name employeeRole");

  // Emit Socket.IO event
  if (req.app.get("io")) {
    req.app.get("io").emit("task:completed", task);
  }

  res.status(200).json({
    success: true,
    message: "Task completed successfully",
    data: task,
  });
});

/**
 * @desc    Delete task
 * @route   DELETE /api/tasks/:id
 * @access  Private (Manager only)
 */
exports.deleteTask = asyncHandler(async (req, res) => {
  const query = { _id: req.params.id };

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  const task = await Task.findOneAndDelete(query);

  if (!task) {
    return res.status(404).json({
      success: false,
      message: "Task not found",
    });
  }

  // Emit Socket.IO event
  if (req.app.get("io")) {
    req.app.get("io").emit("task:deleted", { id: req.params.id });
  }

  res.status(200).json({
    success: true,
    message: "Task deleted successfully",
  });
});

/**
 * @desc    Get task statistics
 * @route   GET /api/tasks/stats
 * @access  Private
 */
exports.getTaskStats = asyncHandler(async (req, res) => {
  const query = {};

  // Data isolation
  if (req.user.cafeId) {
    query.cafeId = req.user.cafeId;
  } else if (req.user.franchiseId) {
    query.franchiseId = req.user.franchiseId;
  }

  // Role-based filtering
  if (req.user.role === "waiter" || req.user.role === "cashier" || req.user.role === "cleaner") {
    const employee = await Employee.findOne({ 
      $or: [
        { _id: req.user.employeeId },
        { userId: req.user._id }
      ]
    });
    if (employee) {
      query.assignedTo = employee._id;
    } else {
      query.assignedToUser = req.user._id;
    }
  }

  const [
    total,
    pending,
    inProgress,
    completed,
    overdue,
  ] = await Promise.all([
    Task.countDocuments(query),
    Task.countDocuments({ ...query, status: "pending" }),
    Task.countDocuments({ ...query, status: "in_progress" }),
    Task.countDocuments({ ...query, status: "completed" }),
    Task.countDocuments({ ...query, status: "overdue" }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      total,
      pending,
      inProgress,
      completed,
      overdue,
    },
  });
});

