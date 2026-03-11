const Task = require("../models/taskModel");
const Employee = require("../models/employeeModel");
const User = require("../models/userModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");

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

const applyTaskCartScope = (query, cartId) => {
  if (!cartId) return;
  // Support both cartId (new) and cafeId (legacy docs).
  query.$or = [{ cartId }, { cafeId: cartId }];
};

const getEmployeeFromTaskContext = async (taskData, user) => {
  if (taskData?.assignedTo) {
    const assignedEmployee = await Employee.findById(taskData.assignedTo).lean();
    if (assignedEmployee) return assignedEmployee;
  }

  if (user?.employeeId) {
    const ownEmployee = await Employee.findById(user.employeeId).lean();
    if (ownEmployee) return ownEmployee;
  }

  if (!user) return null;
  const identityFilters = [{ userId: user._id }];
  if (user.email) {
    identityFilters.push({ email: user.email.toLowerCase() });
  }
  return Employee.findOne({ $or: identityFilters }).lean();
};

const backfillTaskScopeFromEmployee = (taskData, employee) => {
  if (!taskData || !employee) return;
  if (!taskData.assignedTo) {
    taskData.assignedTo = employee._id;
  }
  if (!taskData.assignedToUser && employee.userId) {
    taskData.assignedToUser = employee.userId;
  }
  if (!taskData.cartId) {
    taskData.cartId = employee.cartId || employee.cafeId;
  }
  if (!taskData.franchiseId && employee.franchiseId) {
    taskData.franchiseId = employee.franchiseId;
  }
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    const adminCartId = user.cartId || user.cafeId || user._id;
    applyTaskCartScope(query, adminCartId);
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - always prefer Employee cart mapping to avoid stale
    // user cart/cafe fields after reassignment.
    let employee = null;
    if (user.employeeId) {
      employee = await Employee.findById(user.employeeId).lean();
    }
    if (!employee && user._id) {
      employee = await Employee.findOne({ userId: user._id }).lean();
    }
    if (!employee && user.email) {
      employee = await Employee.findOne({
        email: user.email.toLowerCase(),
      }).lean();
    }
    const cartScope =
      employee?.cartId || employee?.cafeId || user.cartId || user.cafeId;
    if (cartScope) {
      applyTaskCartScope(query, cartScope);
    } else {
      query.cartId = { $in: [] };
    }
  } else if (user.role === "employee") {
    // Legacy employee role
    const employee = await Employee.findOne({
      email: user.email?.toLowerCase(),
    }).lean();
    const cartScope = employee?.cartId || employee?.cafeId;
    if (cartScope) {
      applyTaskCartScope(query, cartScope);
    } else {
      query.cartId = { $in: [] };
    }
  }
  return query;
};

// Helper function to get day name from date
const getDayName = (date) => {
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[date.getDay()];
};

const normalizeDayName = (value) => {
  const day = String(value || "").trim().toLowerCase();
  const map = {
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tues: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
    sun: "sunday",
    sunday: "sunday",
  };
  return map[day] || "";
};

const getISTDayNameFromDate = (dateValue) => {
  const date = dateValue ? new Date(dateValue) : new Date();
  const istDate = utcToIST(date);
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[istDate.getDay()];
};

const getISTDateRangeForDate = (dateValue) => {
  const source = dateValue ? new Date(dateValue) : new Date();
  const istDate = utcToIST(source);
  istDate.setHours(0, 0, 0, 0);
  const startUTC = istToUTC(istDate);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { startUTC, endUTC };
};

const isEmployeeOffOnDay = (employeeSchedule, dayName) => {
  if (!employeeSchedule || !Array.isArray(employeeSchedule.weeklySchedule)) {
    return false;
  }
  const normalizedDay = normalizeDayName(dayName);
  const daySchedule = employeeSchedule.weeklySchedule.find(
    (s) => normalizeDayName(s.day) === normalizedDay
  );
  return Boolean(daySchedule && daySchedule.isWorking === false);
};

const getEmployeeAttendanceStatusForDate = async (employeeId, dateValue) => {
  if (!employeeId) return null;
  const { startUTC, endUTC } = getISTDateRangeForDate(dateValue);
  const attendance = await EmployeeAttendance.findOne({
    employeeId,
    date: { $gte: startUTC, $lt: endUTC },
  })
    .select("status")
    .lean();

  const status = String(attendance?.status || "").toLowerCase();
  return status || null;
};

const validateTaskScheduleConstraints = async ({
  assignedTo,
  frequency,
  dueDate,
}) => {
  if (!assignedTo) return null;

  const schedule = await EmployeeSchedule.findOne({ employeeId: assignedTo })
    .select("weeklySchedule")
    .lean();

  const normalizedFrequency = Array.isArray(frequency)
    ? frequency.map(normalizeDayName).filter(Boolean)
    : [];

  if (normalizedFrequency.length > 0 && schedule?.weeklySchedule?.length) {
    const blockedDays = normalizedFrequency.filter((day) =>
      isEmployeeOffOnDay(schedule, day)
    );
    if (blockedDays.length > 0) {
      const blockedLabel = [...new Set(blockedDays)]
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
        .join(", ");
      return `Cannot assign recurring task on employee off day(s): ${blockedLabel}`;
    }
  }

  if (dueDate) {
    const dueDay = getISTDayNameFromDate(dueDate);
    if (isEmployeeOffOnDay(schedule, dueDay)) {
      return `Cannot assign task on ${dueDay} because it is the employee's off day`;
    }

    const attendanceStatus = await getEmployeeAttendanceStatusForDate(
      assignedTo,
      dueDate
    );
    if (attendanceStatus === "on_leave" || attendanceStatus === "sick") {
      const displayStatus =
        attendanceStatus === "on_leave" ? "on leave" : attendanceStatus;
      return `Cannot assign task on this date because employee is marked ${displayStatus}`;
    }
  }

  return null;
};

// Helper function to check if task should be shown today based on frequency + schedule + attendance (IST)
const shouldShowTaskToday = (
  task,
  employeeSchedule,
  today,
  attendanceStatus = null
) => {
  const todayDayName = getISTDayName();

  if (attendanceStatus === "absent" || attendanceStatus === "on_leave") {
    return false;
  }

  if (employeeSchedule?.todayState === "on_leave") {
    return false;
  }

  if (isEmployeeOffOnDay(employeeSchedule, todayDayName)) {
    return false;
  }

  // If task has no frequency, show it normally (handled by caller - dueDate check)
  if (!task.frequency || task.frequency.length === 0) {
    return true;
  }

  const normalizedFrequency = task.frequency
    .map(normalizeDayName)
    .filter(Boolean);
  return normalizedFrequency.includes(todayDayName);
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
    const isMobileRole = ["waiter", "cook", "captain", "manager", "employee"].includes(user.role);

    // For mobile users (waiter, cook, captain, manager), only show tasks assigned to them
    if (isMobileRole) {
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
    if (assignedTo && !isMobileRole) {
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

    const taskEmployeeIds = [...new Set(tasks
      .map((task) => (task.assignedTo?._id || task.assignedTo || "").toString())
      .filter(Boolean))];

    const employeeSchedulesMap = new Map();
    if (taskEmployeeIds.length > 0) {
      const schedules = await EmployeeSchedule.find({
        employeeId: { $in: taskEmployeeIds },
      }).lean();
      schedules.forEach((schedule) => {
        if (schedule?.employeeId) {
          employeeSchedulesMap.set(schedule.employeeId.toString(), schedule);
        }
      });
    }

    if (employeeSchedule && employeeId && !employeeSchedulesMap.has(employeeId.toString())) {
      employeeSchedulesMap.set(employeeId.toString(), employeeSchedule);
    }

    const attendanceStatusMap = new Map();
    if (taskEmployeeIds.length > 0) {
      const { today: todayStart, tomorrow: tomorrowStart } = getISTDateRange();
      const attendanceRows = await EmployeeAttendance.find({
        employeeId: { $in: taskEmployeeIds },
        date: { $gte: todayStart, $lt: tomorrowStart },
      })
        .select("employeeId status")
        .lean();
      attendanceRows.forEach((row) => {
        if (row?.employeeId) {
          attendanceStatusMap.set(
            row.employeeId.toString(),
            String(row.status || "").toLowerCase()
          );
        }
      });
    }

    // Filter and enhance tasks based on frequency and work schedule
    const filteredTasks = tasks
      .filter((task) => {
        // For recurring tasks, check if they should be shown today
        if (isMobileRole && task.frequency && task.frequency.length > 0) {
          // Get the schedule for the assigned employee
          const taskEmployeeId = task.assignedTo?._id ? task.assignedTo._id.toString() : task.assignedTo?.toString();
          const taskSchedule = taskEmployeeId ? employeeSchedulesMap.get(taskEmployeeId) : employeeSchedule;
          const attendanceStatus = taskEmployeeId
            ? attendanceStatusMap.get(taskEmployeeId) || null
            : null;
          return shouldShowTaskToday(task, taskSchedule, today, attendanceStatus);
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

    const taskEmployeeIds = [...new Set(allTasks
      .map((task) => (task.assignedTo?._id || task.assignedTo || "").toString())
      .filter(Boolean))];

    const scheduleMap = new Map();
    if (taskEmployeeIds.length > 0) {
      const schedules = await EmployeeSchedule.find({
        employeeId: { $in: taskEmployeeIds },
      }).lean();
      schedules.forEach((schedule) => {
        if (schedule?.employeeId) {
          scheduleMap.set(schedule.employeeId.toString(), schedule);
        }
      });
    }
    if (employeeSchedule && employeeId && !scheduleMap.has(employeeId.toString())) {
      scheduleMap.set(employeeId.toString(), employeeSchedule);
    }

    const attendanceStatusMap = new Map();
    if (taskEmployeeIds.length > 0) {
      const attendanceRows = await EmployeeAttendance.find({
        employeeId: { $in: taskEmployeeIds },
        date: { $gte: today, $lt: tomorrow },
      })
        .select("employeeId status")
        .lean();

      attendanceRows.forEach((row) => {
        if (row?.employeeId) {
          attendanceStatusMap.set(
            row.employeeId.toString(),
            String(row.status || "").toLowerCase()
          );
        }
      });
    }

    // Filter tasks that should be shown today
    console.log('[TASK] getTodayTasks - Total tasks found:', allTasks.length);
    console.log('[TASK] getTodayTasks - Today IST date:', today.toISOString());
    
    const todayTasks = allTasks.filter((task) => {
      const taskEmployeeId = task.assignedTo?._id
        ? task.assignedTo._id.toString()
        : task.assignedTo?.toString();
      const taskSchedule = taskEmployeeId
        ? scheduleMap.get(taskEmployeeId)
        : employeeSchedule;
      const attendanceStatus = taskEmployeeId
        ? attendanceStatusMap.get(taskEmployeeId) || null
        : null;

      if (attendanceStatus === "absent" || attendanceStatus === "on_leave") {
        return false;
      }

      if (isEmployeeOffOnDay(taskSchedule, getISTDayName())) {
        return false;
      }

      // If it's a recurring task, check frequency and work schedule
      if (task.frequency && Array.isArray(task.frequency) && task.frequency.length > 0) {
        const shouldShow = shouldShowTaskToday(
          task,
          taskSchedule,
          today,
          attendanceStatus
        );
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
      const taskEmployeeId = task.assignedTo?._id
        ? task.assignedTo._id.toString()
        : task.assignedTo?.toString();
      const taskSchedule = taskEmployeeId
        ? scheduleMap.get(taskEmployeeId)
        : employeeSchedule;
      const calculatedStatus = calculateTaskStatus(task, taskSchedule, nowIST);
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

    if (["admin", "franchise_admin", "super_admin"].includes(user.role)) {
      taskData.assignedBy = taskData.assignedBy || "admin";
    } else {
      taskData.assignedBy = taskData.assignedBy || "self";
    }

    // Set hierarchy relationships
    if (user.role === "admin") {
      // Prefer employee/cart scoped assignment when available.
      if (!taskData.cartId && !taskData.assignedTo) {
        taskData.cartId = user.cartId || user.cafeId || user._id;
      }
      if (user.franchiseId && !taskData.franchiseId) {
        taskData.franchiseId = user.franchiseId;
      }
    } else if (user.role === "franchise_admin") {
      taskData.franchiseId = taskData.franchiseId || user._id;
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

    const scopedEmployee = await getEmployeeFromTaskContext(taskData, user);
    if (scopedEmployee) {
      backfillTaskScopeFromEmployee(taskData, scopedEmployee);
    }

    if (!taskData.cartId) {
      const fallbackCartId = user.cartId || user.cafeId;
      if (fallbackCartId) {
        taskData.cartId = fallbackCartId;
      } else if (user.role === "admin") {
        taskData.cartId = user._id;
      }
    }

    if (!taskData.franchiseId && user.franchiseId) {
      taskData.franchiseId = user.franchiseId;
    }

    // Re-validate franchise scope when cartId was derived from assigned employee.
    if (user.role === "franchise_admin" && taskData.cartId) {
      const cart = await User.findById(taskData.cartId).lean();
      if (!cart || cart.franchiseId?.toString() !== user._id.toString()) {
        return res.status(403).json({ message: "Invalid cart selection" });
      }
    }

    const createValidationMessage = await validateTaskScheduleConstraints({
      assignedTo: taskData.assignedTo,
      frequency: taskData.frequency,
      dueDate: taskData.dueDate,
    });
    if (createValidationMessage) {
      return res.status(400).json({ message: createValidationMessage });
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
    if (!task.taskId) {
      task.taskId = task._id.toString();
      await task.save();
    }
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

    const hasAssignedToUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      "assignedTo"
    );
    const hasFrequencyUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      "frequency"
    );
    const hasDueDateUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      "dueDate"
    );

    const targetAssignedTo = hasAssignedToUpdate ? updates.assignedTo : task.assignedTo;
    const targetFrequency = hasFrequencyUpdate ? updates.frequency : task.frequency;
    const targetDueDate = hasDueDateUpdate ? updates.dueDate : task.dueDate;

    const updateValidationMessage = await validateTaskScheduleConstraints({
      assignedTo: targetAssignedTo,
      frequency: targetFrequency,
      dueDate: targetDueDate,
    });
    if (updateValidationMessage) {
      return res.status(400).json({ message: updateValidationMessage });
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

    // Keep assignedToUser in sync when assignedTo changes.
    if (updates.assignedTo) {
      const assignedEmployee = await Employee.findById(updates.assignedTo).lean();
      task.assignedToUser = assignedEmployee?.userId || undefined;
    }

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

    const taskCartId = task.cartId || task.cafeId;
    await Task.deleteOne({ _id: id });

    // Emit socket event
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && taskCartId) {
      emitToCafe(io, taskCartId.toString(), "task:deleted", { id });
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

