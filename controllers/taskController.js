const Task = require("../models/taskModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

// IST offset constant (UTC+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds

// Helper function to get current IST time
const getISTNow = () => {
  const now = new Date(); // Current UTC time
  return new Date(now.getTime() + IST_OFFSET_MS); // Convert to IST
};

// Helper function to convert IST time to UTC for MongoDB storage
const istToUTC = (istDate) => {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
};

// Helper function to convert UTC time to IST
const utcToIST = (utcDate) => {
  return new Date(utcDate.getTime() + IST_OFFSET_MS);
};

// Helper function to get IST date (start of day in IST, converted to UTC for MongoDB storage)
const getISTDate = () => {
  const istNow = getISTNow();
  // Get start of day in IST
  const istDate = new Date(istNow);
  istDate.setHours(0, 0, 0, 0); // Set to start of day in IST
  
  // Convert to UTC for MongoDB storage
  return istToUTC(istDate);
};

// Helper function to get IST date range (today start and tomorrow start in UTC for MongoDB)
const getISTDateRange = () => {
  const today = getISTDate();
  const tomorrow = new Date(today);
  tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
};

// Helper function to get day name in IST
const getISTDayName = () => {
  const istNow = getISTNow();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[istNow.getDay()]; // Use getDay() for IST day
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cartId = user._id; // Task model uses cartId, not cafeId
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - get their cartId from user or employee record
    if (user.cartId) {
      query.cartId = user.cartId;
    } else if (user.cafeId) {
      // Fallback to cafeId for backward compatibility
      query.cartId = user.cafeId;
    } else if (user.employeeId) {
      const employee = await Employee.findById(user.employeeId).lean();
      if (employee && employee.cartId) {
        query.cartId = employee.cartId;
      } else if (employee && employee.cafeId) {
        // Fallback to cafeId
        query.cartId = employee.cafeId;
      }
    } else {
      // Fallback: find by email
      const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employee && employee.cartId) {
        query.cartId = employee.cartId;
      } else if (employee && employee.cafeId) {
        // Fallback to cafeId
        query.cartId = employee.cafeId;
      }
    }
  } else if (user.role === "employee") {
    // Legacy employee role
    const employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    if (employee && employee.cartId) {
      query.cartId = employee.cartId;
    } else if (employee && employee.cafeId) {
      query.cartId = employee.cafeId;
    }
  }
  return query;
};

// Helper function to get day name from date
const getDayName = (date) => {
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[date.getDay()];
};

// Helper function to check if task should be shown today based on frequency (IST)
// Frequency is primary: e.g. sat-sun task appears only on Sat-Sun in IST
// Work schedule is NOT used - task visibility is driven by frequency alone
const shouldShowTaskToday = (task, employeeSchedule, today) => {
  // If task has no frequency, show it normally (handled by caller - dueDate check)
  if (!task.frequency || task.frequency.length === 0) {
    return true;
  }

  // Use IST day name for consistency
  const todayDayName = getISTDayName();
  
  // Check if today is in the frequency list - that's the only filter for recurring tasks
  return task.frequency.includes(todayDayName);
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

  // Use IST day name for consistency - get today's IST day name
  const taskDayName = getISTDayName();
  const daySchedule = employeeSchedule.weeklySchedule.find(
    (s) => s.day === taskDayName
  );

  if (!daySchedule || !daySchedule.isWorking) {
    return task.status; // Not a working day, keep current status
  }

  // Parse start and end times (these are in IST format from schedule)
  const [startHour, startMinute] = daySchedule.startTime.split(":").map(Number);
  const [endHour, endMinute] = daySchedule.endTime.split(":").map(Number);

  // Convert task due date from UTC (MongoDB) to IST
  const taskDateUTC = new Date(task.dueDate);
  const taskDateIST = utcToIST(taskDateUTC);
  
  // Create scheduled times in IST for the task's due date
  const scheduledStartIST = new Date(taskDateIST);
  scheduledStartIST.setHours(startHour, startMinute, 0, 0);
  
  const scheduledEndIST = new Date(taskDateIST);
  scheduledEndIST.setHours(endHour, endMinute, 0, 0);

  // Get current time in IST
  const nowIST = getISTNow();

  // Check if task is late (past scheduled start time and not completed) - all in IST
  if (nowIST > scheduledStartIST && task.status !== "completed") {
    const lateMinutes = Math.floor((nowIST - scheduledStartIST) / (1000 * 60));
    if (lateMinutes > 15) {
      // More than 15 minutes late
      return "late";
    }
  }

  // Check if it's past end time and not completed - mark as overdue (all in IST)
  if (nowIST > scheduledEndIST && task.status !== "completed") {
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
    // Use IST date range for consistent date comparison
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

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
    console.log('[TASK] getTodayTasks - Total tasks found:', allTasks.length);
    console.log('[TASK] getTodayTasks - Today IST date:', today.toISOString());
    
    const todayTasks = allTasks.filter((task) => {
      // If it's a recurring task, check frequency and work schedule
      if (task.frequency && Array.isArray(task.frequency) && task.frequency.length > 0) {
        const shouldShow = shouldShowTaskToday(task, employeeSchedule, today);
        console.log('[TASK] Recurring task:', {
          id: task._id,
          title: task.title,
          frequency: task.frequency,
          shouldShow: shouldShow,
        });
        return shouldShow;
      }
      
      // For non-recurring tasks, check if task is due today (using IST date comparison)
      if (task.dueDate) {
        // Convert task due date from UTC (MongoDB) to IST
        const taskDueDateUTC = new Date(task.dueDate);
        const taskDueDateIST = utcToIST(taskDueDateUTC);
        
        // Get start of day in IST for task due date
        const taskDueDateISTStart = new Date(taskDueDateIST);
        taskDueDateISTStart.setHours(0, 0, 0, 0);
        
        // Get today's start in IST
        const todayIST = getISTNow();
        const todayISTStart = new Date(todayIST);
        todayISTStart.setHours(0, 0, 0, 0);
        
        // Compare IST dates
        const isDueToday = taskDueDateISTStart.getTime() === todayISTStart.getTime();
        
        console.log('[TASK] Non-recurring task date check (IST):', {
          id: task._id,
          title: task.title,
          taskDueDateUTC: taskDueDateUTC.toISOString(),
          taskDueDateIST: taskDueDateIST.toISOString(),
          taskDueDateISTStart: taskDueDateISTStart.toISOString(),
          todayISTStart: todayISTStart.toISOString(),
          isDueToday: isDueToday,
        });
        
        return isDueToday;
      }
      
      // If no dueDate, don't show the task
      console.log('[TASK] Task has no dueDate:', {
        id: task._id,
        title: task.title,
      });
      return false;
    });
    
    console.log('[TASK] getTodayTasks - Tasks for today:', todayTasks.length);

    // Use IST time for all calculations
    const nowIST = getISTNow();
    
    // Calculate status for each task based on work schedule (using IST)
    const tasksWithStatus = todayTasks.map((task) => {
      const calculatedStatus = calculateTaskStatus(task, employeeSchedule, nowIST);
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
      if (user.cartId) {
        taskData.cartId = user.cartId; // Task model uses cartId
      } else if (user.cafeId) {
        // Fallback to cafeId for backward compatibility
        taskData.cartId = user.cafeId;
      } else if (user.employeeId) {
        const employee = await Employee.findById(user.employeeId).lean();
        if (employee && employee.cartId) {
          taskData.cartId = employee.cartId; // Task model uses cartId, not cafeId
        } else if (employee && employee.cafeId) {
          // Fallback to cafeId
          taskData.cartId = employee.cafeId;
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
        } else if (employee && employee.cafeId) {
          // Fallback to cafeId
          taskData.cartId = employee.cafeId;
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

