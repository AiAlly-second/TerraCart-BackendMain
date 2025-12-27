const Task = require("../models/taskModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

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

// Helper function to get day name from date
const getDayName = (date) => {
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[date.getDay()];
};

// Helper function to check if task should be shown today based on frequency and work schedule
const shouldShowTaskToday = (task, employeeSchedule, today) => {
  // If task has no frequency, show it normally
  if (!task.frequency || task.frequency.length === 0) {
    return true;
  }

  const todayDayName = getDayName(today);
  
  // Check if today is in the frequency list
  if (!task.frequency.includes(todayDayName)) {
    return false;
  }

  // If employee schedule exists, check if today is a working day
  if (employeeSchedule && employeeSchedule.weeklySchedule) {
    const todaySchedule = employeeSchedule.weeklySchedule.find(
      (s) => s.day === todayDayName
    );
    // Only show task if it's a working day
    return todaySchedule && todaySchedule.isWorking;
  }

  // If no schedule, show task if day matches frequency
  return true;
};

// Helper function to calculate task status based on work schedule
const calculateTaskStatus = (task, employeeSchedule, now) => {
  // If task is already completed or cancelled, return as is
  if (task.status === "completed" || task.status === "cancelled") {
    return task.status;
  }

  // If no schedule or no assigned employee, return current status
  if (!employeeSchedule || !employeeSchedule.weeklySchedule || !task.assignedTo) {
    return task.status;
  }

  // Get employee ID (handle both populated and non-populated)
  const employeeId = task.assignedTo._id ? task.assignedTo._id.toString() : task.assignedTo.toString();
  const scheduleEmployeeId = employeeSchedule.employeeId?._id ? 
    employeeSchedule.employeeId._id.toString() : 
    employeeSchedule.employeeId?.toString();

  // Only calculate status if schedule matches the assigned employee
  if (employeeId !== scheduleEmployeeId) {
    return task.status;
  }

  const taskDayName = getDayName(new Date(task.dueDate));
  const daySchedule = employeeSchedule.weeklySchedule.find(
    (s) => s.day === taskDayName
  );

  if (!daySchedule || !daySchedule.isWorking) {
    return task.status; // Not a working day, keep current status
  }

  // Parse start and end times
  const [startHour, startMinute] = daySchedule.startTime.split(":").map(Number);
  const [endHour, endMinute] = daySchedule.endTime.split(":").map(Number);

  // Create scheduled times for the task's due date
  const taskDate = new Date(task.dueDate);
  const scheduledStart = new Date(taskDate);
  scheduledStart.setHours(startHour, startMinute, 0, 0);
  
  const scheduledEnd = new Date(taskDate);
  scheduledEnd.setHours(endHour, endMinute, 0, 0);

  // Check if task is late (past scheduled start time and not completed)
  if (now > scheduledStart && task.status !== "completed") {
    const lateMinutes = Math.floor((now - scheduledStart) / (1000 * 60));
    if (lateMinutes > 15) {
      // More than 15 minutes late
      return "late";
    }
  }

  // Check if it's past end time and not completed - mark as overdue
  if (now > scheduledEnd && task.status !== "completed") {
    return "pending"; // Keep as pending but will show as overdue
  }

  return task.status;
};

// Get all tasks
exports.getAllTasks = async (req, res) => {
  try {
    const { status, priority, category, assignedTo } = req.query;
    const user = req.user;
    const query = {};
    let employeeId = null;
    let employeeSchedule = null;

    // For mobile users (waiter, cook, captain, manager), only show tasks assigned to them
    if (["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      if (user.employeeId) {
        employeeId = user.employeeId;
      } else {
        // Find employee record
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

      if (employeeId) {
        // Only show tasks assigned to this employee
        query.assignedTo = employeeId;
        // Fetch employee schedule
        employeeSchedule = await EmployeeSchedule.findOne({ employeeId }).lean();
      } else {
        // If no employee found, return empty array
        return res.json([]);
      }
    } else {
      // For admin/franchise_admin, use hierarchy query to see all tasks in their scope
      const hierarchyQuery = await buildHierarchyQuery(user);
      Object.assign(query, hierarchyQuery);
    }

    if (status) {
      query.status = status;
    }
    if (priority) {
      query.priority = priority;
    }
    if (category) {
      query.category = category;
    }
    // Allow filtering by assignedTo in query params (for admin users)
    if (assignedTo && !["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      query.assignedTo = assignedTo;
      // Fetch schedule for the assigned employee
      employeeSchedule = await EmployeeSchedule.findOne({ employeeId: assignedTo }).lean();
    }

    const tasks = await Task.find(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .populate("completedBy", "name mobile employeeRole")
      .sort({ createdAt: -1 })
      .lean();

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // For admin view with multiple employees, we need to fetch schedules per employee
    // For now, we'll handle the current employee's schedule and improve later if needed
    const employeeSchedulesMap = new Map();
    if (employeeSchedule && employeeId) {
      employeeSchedulesMap.set(employeeId.toString(), employeeSchedule);
    }

    // Filter and enhance tasks based on frequency and work schedule
    const filteredTasks = tasks
      .filter((task) => {
        // For recurring tasks, check if they should be shown today
        if (task.frequency && task.frequency.length > 0) {
          // Get the schedule for the assigned employee
          const taskEmployeeId = task.assignedTo?._id ? task.assignedTo._id.toString() : task.assignedTo?.toString();
          const taskSchedule = taskEmployeeId ? employeeSchedulesMap.get(taskEmployeeId) : employeeSchedule;
          return shouldShowTaskToday(task, taskSchedule, today);
        }
        return true;
      })
      .map((task) => {
        // Get the schedule for the assigned employee
        const taskEmployeeId = task.assignedTo?._id ? task.assignedTo._id.toString() : task.assignedTo?.toString();
        const taskSchedule = taskEmployeeId ? employeeSchedulesMap.get(taskEmployeeId) : employeeSchedule;
        
        // Calculate status based on work schedule
        const calculatedStatus = calculateTaskStatus(task, taskSchedule, now);
        
        return { ...task, status: calculatedStatus };
      });

    return res.json(filteredTasks);
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

    const user = req.user;
    let employeeId = null;
    let employeeSchedule = null;

    // Get employee ID and schedule for mobile users
    if (["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      if (user.employeeId) {
        employeeId = user.employeeId;
      } else {
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
      
      if (employeeId) {
        employeeSchedule = await EmployeeSchedule.findOne({ employeeId }).lean();
      }
    }

    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = {
      ...hierarchyQuery,
    };

    // For mobile users, only show tasks assigned to them
    if (employeeId) {
      query.assignedTo = employeeId;
    }

    // Get all tasks (including recurring ones)
    const allTasks = await Task.find(query)
      .populate("assignedTo", "name mobile employeeRole")
      .populate("assignedToUser", "name email role")
      .sort({ priority: 1, createdAt: -1 })
      .lean();

    // Filter tasks that should be shown today
    const todayTasks = allTasks.filter((task) => {
      // If it's a recurring task, check frequency and work schedule
      if (task.frequency && Array.isArray(task.frequency) && task.frequency.length > 0) {
        return shouldShowTaskToday(task, employeeSchedule, today);
      }
      
      // For non-recurring tasks, check if task is due today
      if (task.dueDate) {
        const taskDueDate = new Date(task.dueDate);
        taskDueDate.setHours(0, 0, 0, 0); // Normalize to start of day
        const isDueToday = taskDueDate.getTime() === today.getTime();
        return isDueToday;
      }
      
      // If no dueDate, don't show the task
      return false;
    });

    const now = new Date();
    
    // Calculate status for each task based on work schedule
    const tasksWithStatus = todayTasks.map((task) => {
      const calculatedStatus = calculateTaskStatus(task, employeeSchedule, now);
      return { ...task, status: calculatedStatus };
    });

    // Return array directly for mobile app compatibility
    return res.json(tasksWithStatus);
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
      taskData.cartId = user._id; // Task model uses cartId, not cafeId
      if (user.franchiseId) {
        taskData.franchiseId = user.franchiseId;
      }
    } else if (user.role === "franchise_admin") {
      taskData.franchiseId = user._id;
      if (taskData.cartId) {
        // Validate cartId belongs to this franchise
        const cart = await User.findById(taskData.cartId);
        if (!cart || cart.franchiseId?.toString() !== user._id.toString()) {
          return res.status(403).json({ message: "Invalid cart selection" });
        }
      }
    } else if (["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      // Mobile users can create tasks for their cart
      if (user.cafeId) {
        taskData.cartId = user.cafeId; // User.cafeId links to cart admin, which is what we need for Task.cartId
      } else if (user.employeeId) {
        const employee = await Employee.findById(user.employeeId).lean();
        if (employee && employee.cartId) {
          taskData.cartId = employee.cartId; // Task model uses cartId, not cafeId
        }
      } else {
        // Find employee by userId or email
        const employee = await Employee.findOne({
          $or: [
            { userId: user._id },
            { email: user.email?.toLowerCase() }
          ]
        }).lean();
        if (employee && employee.cartId) {
          taskData.cartId = employee.cartId; // Task model uses cartId, not cafeId
          if (employee.franchiseId) {
            taskData.franchiseId = employee.franchiseId;
          }
        }
      }
      if (user.franchiseId) {
        taskData.franchiseId = user.franchiseId;
      }
      
      // If no assignedTo is provided and user has employeeId, assign to self
      if (!taskData.assignedTo && user.employeeId) {
        taskData.assignedTo = user.employeeId;
      } else if (!taskData.assignedTo) {
        // Try to find employee record
        const employee = await Employee.findOne({
          $or: [
            { userId: user._id },
            { email: user.email?.toLowerCase() }
          ]
        }).lean();
        if (employee) {
          taskData.assignedTo = employee._id;
        }
      }
    }
    
    // Handle frequency: store original due date if frequency is set
    if (taskData.frequency && Array.isArray(taskData.frequency) && taskData.frequency.length > 0 && taskData.dueDate) {
      taskData.originalDueDate = taskData.dueDate;
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
    const taskCartId = task.cartId || task.cafeId; // Support old cafeId field for backward compatibility
    if (io && emitToCafe && taskCartId) {
      emitToCafe(io, taskCartId.toString(), "task:created", task);
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
    const user = req.user;
    
    // Build hierarchy query, but also allow users to update their own tasks
    const hierarchyQuery = await buildHierarchyQuery(user);
    
    // Allow users to update tasks assigned to them even if outside hierarchy
    let query = { _id: id };
    
    // Check if task belongs to hierarchy OR is assigned to current user
    const hierarchyTask = await Task.findOne({ _id: id, ...hierarchyQuery }).lean();
    
    if (!hierarchyTask) {
      // Check if task is assigned to current user
      let employeeId = user.employeeId;
      if (!employeeId && ["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
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
      
      if (employeeId) {
        const ownTask = await Task.findOne({ _id: id, assignedTo: employeeId }).lean();
        if (!ownTask) {
          return res.status(404).json({ message: "Task not found or access denied" });
        }
      } else {
        return res.status(404).json({ message: "Task not found or access denied" });
      }
    }

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    
    // Handle frequency: store original due date if frequency is set
    if (updates.frequency && Array.isArray(updates.frequency) && updates.frequency.length > 0) {
      if (updates.dueDate && !task.originalDueDate) {
        updates.originalDueDate = updates.dueDate;
      } else if (!updates.dueDate && task.originalDueDate) {
        // Keep original due date when updating frequency
        updates.originalDueDate = task.originalDueDate;
      }
    }

    // Update fields
    Object.keys(updates).forEach((key) => {
      // Don't allow updating cartId or franchiseId directly
      if (key !== "_id" && key !== "cartId" && key !== "cafeId" && key !== "franchiseId") {
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
    const taskCartId = task.cartId || task.cafeId; // Support old cafeId field for backward compatibility
    if (io && emitToCafe && taskCartId) {
      emitToCafe(io, taskCartId.toString(), "task:updated", task);
      if (task.status === "completed") {
        emitToCafe(io, taskCartId.toString(), "task:completed", task);
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
    const taskCartId = task.cartId || task.cafeId; // Support old cafeId field for backward compatibility
    if (io && emitToCafe && taskCartId) {
      emitToCafe(io, taskCartId.toString(), "task:completed", task);
      emitToCafe(io, taskCartId.toString(), "task:updated", task);
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

