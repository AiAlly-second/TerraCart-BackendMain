const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

// Helper function to get IST date (start of day in IST, converted to UTC for MongoDB)
const getISTDate = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds (UTC+5:30)
  const istNow = new Date(now.getTime() + istOffset);
  
  // Get start of day in IST
  const istDate = new Date(istNow);
  istDate.setUTCHours(0, 0, 0, 0);
  
  // Convert back to UTC for MongoDB storage
  istDate.setTime(istDate.getTime() - istOffset);
  
  return istDate;
};

// Helper function to get IST date range (today start and tomorrow start in UTC)
const getISTDateRange = () => {
  const today = getISTDate();
  const tomorrow = new Date(today);
  tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
};

// Helper function to get current IST time
const getISTNow = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
};

// Helper function to get day name in IST
const getISTDayName = () => {
  const istNow = getISTNow();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[istNow.getUTCDay()];
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cartId = user._id; // EmployeeAttendance model uses cartId, not cafeId
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users (waiter, cook, captain, manager) - only show their own attendance
    // Get their employee record to find cartId and employeeId
    let employee = await Employee.findOne({ userId: user._id }).lean();
    if (!employee && user.email) {
      // Fallback: find by email
      employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    }
    if (employee) {
      query.cartId = employee.cartId; // EmployeeAttendance model uses cartId, not cafeId
      // For individual mobile users, only show their own attendance
      query.employeeId = employee._id;
    } else {
      // If no employee record found, use a query that will return no results
      query.employeeId = { $exists: false }; // This will ensure no results are returned
    }
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      query.cartId = employee.cartId; // EmployeeAttendance model uses cartId, not cafeId
      query.employeeId = employee._id;
    } else {
      // If no employee record found, use a query that will return no results
      query.employeeId = { $exists: false }; // This will ensure no results are returned
    }
  } else {
    // For any other role, ensure they can only see their own attendance if they have an employee record
    // Otherwise, return no results
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (!employee && user.email) {
      const employeeByEmail = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employeeByEmail) {
        query.cartId = employeeByEmail.cartId; // EmployeeAttendance model uses cartId, not cafeId
        query.employeeId = employeeByEmail._id;
      } else {
        query.employeeId = { $exists: false }; // No employee record found, return no results
      }
    } else if (employee) {
      query.cartId = employee.cartId; // EmployeeAttendance model uses cartId, not cafeId
      query.employeeId = employee._id;
    } else {
      query.employeeId = { $exists: false }; // No employee record found, return no results
    }
  }
  return query;
};

// Get all attendance records
exports.getAllAttendance = async (req, res) => {
  try {
    const { employeeId, startDate, endDate, status } = req.query;
    const query = await buildHierarchyQuery(req.user);

    if (employeeId) {
      query.employeeId = employeeId;
    }

    // Check if querying for today's attendance
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();
    const now = new Date();

    // If querying today's attendance, mark absent employees
    const isQueryingToday = (!startDate && !endDate) || 
      (startDate && new Date(startDate) <= today && (!endDate || new Date(endDate) >= today));

    if (isQueryingToday && !employeeId) {
      // Get all employees in the hierarchy
      const employeeQuery = await buildHierarchyQuery(req.user);
      const employees = await Employee.find(employeeQuery)
        .select("_id name employeeRole cafeId franchiseId")
        .lean();

      // Get existing attendance for today
      const todayQuery = {
        ...query,
        date: { $gte: today, $lt: tomorrow },
      };
      const existingAttendance = await EmployeeAttendance.find(todayQuery)
        .select("employeeId")
        .lean();
      const attendanceEmployeeIds = new Set(
        existingAttendance.map((a) => a.employeeId?.toString() || a.employeeId?._id?.toString())
      );

      // Get day name for today in IST
      const todayDay = getISTDayName();

      // Mark absent for employees who haven't checked in on working days
      for (const employee of employees) {
        const empId = employee._id.toString();
        
        if (attendanceEmployeeIds.has(empId)) {
          continue;
        }

        const schedule = await EmployeeSchedule.findOne({ employeeId: employee._id }).lean();
        
        if (schedule && schedule.weeklySchedule) {
          const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);
          
          if (todaySchedule && todaySchedule.isWorking) {
          const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
          const istOffset = 5.5 * 60 * 60 * 1000;
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setUTCHours(hours, minutes, 0, 0);
          scheduledStartTimeIST.setTime(scheduledStartTimeIST.getTime() - istOffset);
          
          // Add 30 minute buffer
          const bufferTime = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
            
            if (now >= bufferTime) {
              try {
                await EmployeeAttendance.create({
                  employeeId: employee._id,
                  date: today,
                  status: "absent",
                  cartId: employee.cartId, // EmployeeAttendance model uses cartId, not cafeId
                  franchiseId: employee.franchiseId,
                });
              } catch (err) {
                if (err.code !== 11000) {
                  console.error(`[ATTENDANCE] Error creating absent record:`, err.message);
                }
              }
            }
          }
        }
      }
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
    } else if (isQueryingToday) {
      // If querying today, ensure date filter is set
      query.date = { $gte: today, $lt: tomorrow };
    }

    if (status) {
      query.status = status;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(attendance);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get today's attendance for all employees
exports.getTodayAttendance = async (req, res) => {
  try {
    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();
    const now = new Date();

    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = {
      ...hierarchyQuery,
      date: { $gte: today, $lt: tomorrow },
    };

    // Get existing attendance records
    // For mobile users, query should already filter by employeeId
    console.log('[ATTENDANCE] getTodayAttendance query:', JSON.stringify(query, null, 2));
    let attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ "checkIn.time": -1 })
      .lean();
    console.log('[ATTENDANCE] getTodayAttendance found records:', attendance.length);

    // Get all employees in the hierarchy to check for absent employees
    const employeeQuery = await buildHierarchyQuery(req.user);
    const employees = await Employee.find(employeeQuery)
      .select("_id name employeeRole cafeId franchiseId")
      .lean();

    // Get day name for today in IST
    const todayDay = getISTDayName();

    // Check each employee and mark absent if they haven't checked in on a working day
    const attendanceEmployeeIds = new Set(
      attendance.map((a) => a.employeeId?._id?.toString() || a.employeeId?.toString())
    );

    for (const employee of employees) {
      const employeeId = employee._id.toString();
      
      // Skip if attendance already exists
      if (attendanceEmployeeIds.has(employeeId)) {
        continue;
      }

      // Get employee's work schedule
      const schedule = await EmployeeSchedule.findOne({ employeeId: employee._id }).lean();
      
      if (schedule && schedule.weeklySchedule) {
        const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);
        
        // If today is a working day and employee hasn't checked in, mark as absent
        if (todaySchedule && todaySchedule.isWorking) {
          // Check if it's past the scheduled start time (with 30 minute buffer)
          const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
          const istOffset = 5.5 * 60 * 60 * 1000;
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setUTCHours(hours, minutes, 0, 0);
          scheduledStartTimeIST.setTime(scheduledStartTimeIST.getTime() - istOffset); // Convert to UTC
          
          // Add 30 minute buffer - only mark absent if it's 30 minutes past scheduled start time
          const bufferTime = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
          
          if (now >= bufferTime) {
            // Create absent attendance record
            try {
              const absentAttendance = await EmployeeAttendance.create({
                employeeId: employee._id,
                date: today,
                status: "absent",
                cafeId: employee.cafeId,
                franchiseId: employee.franchiseId,
              });
              
              await absentAttendance.populate("employeeId", "name mobile employeeRole");
              attendance.push(absentAttendance.toObject());
              attendanceEmployeeIds.add(employeeId);
            } catch (err) {
              // If record already exists (race condition), skip
              if (err.code !== 11000) {
                console.error(`[ATTENDANCE] Error creating absent record for employee ${employeeId}:`, err.message);
              }
            }
          }
        }
      }
    }

    // Calculate real-time working hours for employees who are checked in but not checked out
    const attendanceWithWorkingHours = attendance.map((record) => {
      // If already checked out, use stored values
      if (record.checkOut?.time) {
        return record;
      }

      // If checked in but not checked out, calculate real-time working hours
      if (record.checkIn?.time) {
        const checkInTime = new Date(record.checkIn.time);
        const breakMinutes = record.breakDuration || 0;
        
        // Calculate working minutes (excluding breaks)
        // If on break, pause the timer at break start
        let workingMinutes = 0;
        if (record.isOnBreak && record.breakStart) {
          // PAUSED: Working timer is frozen at the moment break started
          const breakStartTime = new Date(record.breakStart);
          const workingTimeUntilBreak = Math.floor((breakStartTime - checkInTime) / (1000 * 60));
          // Subtract only completed breaks (breakDuration doesn't include current break)
          workingMinutes = Math.max(0, workingTimeUntilBreak - breakMinutes);
        } else {
          // ACTIVE: Working timer is running
          const totalDurationMinutes = Math.floor((now - checkInTime) / (1000 * 60));
          // Subtract completed break time
          workingMinutes = Math.max(0, totalDurationMinutes - breakMinutes);
        }

        // Add calculated fields for real-time display
        return {
          ...record,
          totalWorkingMinutes: workingMinutes,
          workingHours: Number((workingMinutes / 60).toFixed(2)),
        };
      }

      return record;
    });

    return res.json(attendanceWithWorkingHours);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get past attendance records
exports.getPastAttendance = async (req, res) => {
  try {
    const { employeeId, limit = 30 } = req.query;
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    
    const query = {
      ...hierarchyQuery,
      date: { $lt: new Date() }, // Past dates only
    };

    if (employeeId) {
      query.employeeId = employeeId;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    return res.json(attendance);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Check-in employee
exports.checkIn = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;

    // Determine employeeId - for mobile users, use their own employeeId
    let targetEmployeeId = employeeId;
    
    // If mobile user (waiter, cook, captain, manager) and no employeeId provided, use their own
    if (!targetEmployeeId && ["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const employee = await Employee.findOne({ userId: user._id });
      if (employee) {
        targetEmployeeId = employee._id;
      } else {
        return res.status(404).json({ message: "Employee record not found for this user" });
      }
    }
    
    if (!targetEmployeeId) {
      return res.status(400).json({ message: "Employee ID is required" });
    }

    // Verify employee exists and check hierarchy access
    const employee = await Employee.findById(targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Check hierarchy access
    if (user.role === "admin" && employee.cartId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (user.role === "franchise_admin" && employee.franchiseId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    // Mobile users can only check themselves in
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || userEmployee._id.toString() !== targetEmployeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only check yourself in." });
      }
    }

    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

    let attendance = await EmployeeAttendance.findOne({
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    });

    if (attendance && attendance.checkIn.time) {
      return res.status(400).json({ message: "Employee already checked in today" });
    }

    const checkInTime = new Date(); // Store in UTC (MongoDB default)

    // Get employee schedule to check if late
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    let status = "present";
    let isLate = false;

    if (schedule && schedule.weeklySchedule) {
      // Use IST date for day calculation
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.startTime) {
        const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
        // Create scheduled time in IST, then convert to UTC for comparison
        const istOffset = 5.5 * 60 * 60 * 1000;
        const scheduledTimeIST = new Date(istNow);
        scheduledTimeIST.setUTCHours(hours, minutes, 0, 0);
        scheduledTimeIST.setTime(scheduledTimeIST.getTime() - istOffset); // Convert to UTC
        
        // Compare checkInTime (UTC) with scheduledTime (UTC)
        if (checkInTime > scheduledTimeIST) {
          const lateMinutes = Math.floor((checkInTime - scheduledTimeIST) / (1000 * 60));
          if (lateMinutes > 15) {
            // Late if more than 15 minutes
            status = "late";
            isLate = true;
          }
        }
      }
    }

    if (attendance) {
      // Update existing record - ensure date is set to today's IST date
      attendance.date = today;
      attendance.checkIn = {
        time: checkInTime,
        location: location || "",
        notes: notes || "",
      };
      attendance.status = status;
      attendance.cartId = employee.cartId; // EmployeeAttendance model uses cartId, not cafeId
      attendance.franchiseId = employee.franchiseId;
      await attendance.save();
    } else {
      // Create new record
      attendance = await EmployeeAttendance.create({
        employeeId: targetEmployeeId,
        date: today,
        checkIn: {
          time: checkInTime,
          location: location || "",
          notes: notes || "",
        },
        status: status,
        cartId: employee.cartId, // EmployeeAttendance model uses cartId, not cafeId
        franchiseId: employee.franchiseId,
      });
    }

    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId; // Support both for backward compatibility
    if (io && emitToCafe && attendanceCartId) {
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_in", attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      message: isLate ? "Checked in (Late)" : "Checked in successfully",
      attendance,
      isLate,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Check-out employee
exports.checkOut = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;

    // Determine employeeId - for mobile users, use their own employeeId
    let targetEmployeeId = employeeId;
    
    // If mobile user (waiter, cook, captain, manager) and no employeeId provided, use their own
    if (!targetEmployeeId && ["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const employee = await Employee.findOne({ userId: user._id });
      if (employee) {
        targetEmployeeId = employee._id;
      } else {
        return res.status(404).json({ message: "Employee record not found for this user" });
      }
    }
    
    if (!targetEmployeeId) {
      return res.status(400).json({ message: "Employee ID is required" });
    }

    // Verify employee exists and check hierarchy access
    const employee = await Employee.findById(targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Check hierarchy access
    if (user.role === "admin" && employee.cartId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (user.role === "franchise_admin" && employee.franchiseId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    // Mobile users can only check themselves out
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || userEmployee._id.toString() !== targetEmployeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only check yourself out." });
      }
    }

    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

    const attendance = await EmployeeAttendance.findOne({
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    });

    if (!attendance || !attendance.checkIn.time) {
      return res.status(400).json({ message: "Employee has not checked in today" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ message: "Employee already checked out today" });
    }

    const checkOutTime = new Date(); // Store in UTC (MongoDB default)

    // Calculate working hours
    const checkInTime = new Date(attendance.checkIn.time);
    const workingMinutes = Math.floor((checkOutTime - checkInTime) / (1000 * 60));
    const workingHours = workingMinutes - (attendance.breakDuration || 0);

    // Get schedule to calculate overtime
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      // Use IST date for day calculation
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        // Create scheduled end time in IST, then convert to UTC for comparison
        const istOffset = 5.5 * 60 * 60 * 1000;
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setUTCHours(hours, minutes, 0, 0);
        scheduledEndTimeIST.setTime(scheduledEndTimeIST.getTime() - istOffset); // Convert to UTC
        
        // Compare checkOutTime (UTC) with scheduledEndTime (UTC)
        if (checkOutTime > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTime - scheduledEndTimeIST) / (1000 * 60));
        }
      }
    }

    // Ensure date field is set to today's IST date (in case it was set incorrectly)
    attendance.date = today;
    
    attendance.checkOut = {
      time: checkOutTime,
      location: location || "",
      notes: notes || "",
    };
    attendance.workingHours = Math.max(0, workingHours);
    attendance.overtime = Math.max(0, overtime);

    // Update status if half day
    if (workingHours < 240) {
      // Less than 4 hours
      attendance.status = "half_day";
    }

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId; // Support both for backward compatibility
    if (io && emitToCafe && attendanceCartId) {
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_out", attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      message: "Checked out successfully",
      attendance,
      totalWorkingMinutes: Math.max(0, workingHours),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Check-out by attendance ID (for mobile app)
exports.checkOutById = async (req, res) => {
  try {
    const { id } = req.params;
    const { location, notes } = req.body;
    const user = req.user;

    // Find attendance record
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    // Check access - mobile users can only manage their own attendance
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    if (!attendance.checkIn.time) {
      return res.status(400).json({ success: false, message: "Employee has not checked in" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ success: false, message: "Employee already checked out" });
    }

    // Check if on break - must end break before checkout
    if (attendance.isOnBreak || (attendance.breakStart && !attendance.checkOut?.time)) {
      return res.status(400).json({ success: false, message: "Cannot checkout while on break. Please end break first." });
    }

    const checkOutTime = new Date(); // Store in UTC (MongoDB default)

    // Calculate working hours
    const checkInTime = new Date(attendance.checkIn.time);
    const totalDurationMinutes = Math.floor((checkOutTime - checkInTime) / (1000 * 60));
    const breakMinutes = attendance.breakDuration || 0;
    const totalWorkingMinutes = Math.max(0, totalDurationMinutes - breakMinutes);

    // Get schedule to calculate overtime
    const schedule = await EmployeeSchedule.findOne({ employeeId: attendance.employeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      const istNow = getISTNow();
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        const istOffset = 5.5 * 60 * 60 * 1000;
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setUTCHours(hours, minutes, 0, 0);
        scheduledEndTimeIST.setTime(scheduledEndTimeIST.getTime() - istOffset); // Convert to UTC
        
        if (checkOutTime > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTime - scheduledEndTimeIST) / (1000 * 60));
        }
      }
    }

    // Get today's IST date to ensure date field is correct
    const { today } = getISTDateRange();
    
    // Ensure date field is set to today's IST date (in case it was set incorrectly)
    attendance.date = today;
    
    attendance.checkOut = {
      time: checkOutTime,
      location: location || "",
      notes: notes || "",
    };
    attendance.totalWorkingMinutes = totalWorkingMinutes;
    attendance.workingHours = Number((totalWorkingMinutes / 60).toFixed(2)); // Convert to hours with 2 decimal places
    attendance.overtime = Math.max(0, overtime);
    
    // Update status - if less than 4 hours, mark as half_day, otherwise completed
    if (totalWorkingMinutes < 240) {
      // Less than 4 hours
      attendance.status = "half_day";
    } else {
      attendance.status = "completed";
    }

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && attendance.cafeId) {
      emitToCafe(io, attendance.cafeId.toString(), "attendance:checked_out", attendance);
      emitToCafe(io, attendance.cafeId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      success: true,
      message: "Checked out successfully",
      data: attendance,
      totalWorkingMinutes: totalWorkingMinutes,
      workingHours: attendance.workingHours,
      overtime: attendance.overtime,
    });
  } catch (err) {
    console.error('[ATTENDANCE] Checkout by ID error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Start break
exports.startBreak = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Find attendance record
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    // Check access - mobile users can only manage their own attendance
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      // Mobile users: lookup Employee by email (since User.email matches Employee.email)
      const userEmployee = await Employee.findOne({ 
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    if (!attendance.checkIn.time) {
      return res.status(400).json({ success: false, message: "Employee has not checked in" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ success: false, message: "Employee has already checked out" });
    }

    // Check if already on break (using isOnBreak field or breakStart)
    if (attendance.isOnBreak || attendance.breakStart) {
      return res.status(400).json({ success: false, message: "Break already started" });
    }

    attendance.breakStart = new Date();
    attendance.isOnBreak = true;
    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && attendance.cafeId) {
      emitToCafe(io, attendance.cafeId.toString(), "attendance:break_started", attendance);
      emitToCafe(io, attendance.cafeId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      success: true,
      message: "Break started",
      data: attendance,
      attendance, // Keep for backward compatibility
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// End break
exports.endBreak = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Find attendance record
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Check access - mobile users can only manage their own attendance
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      // Mobile users: lookup Employee by email (since User.email matches Employee.email)
      const userEmployee = await Employee.findOne({ 
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    // Check if on break (using isOnBreak field or breakStart)
    if (!attendance.isOnBreak && !attendance.breakStart) {
      return res.status(400).json({ success: false, message: "Break has not been started" });
    }

    const breakEnd = new Date();
    const breakDuration = Math.floor((breakEnd - attendance.breakStart) / (1000 * 60)); // in minutes
    attendance.breakDuration = (attendance.breakDuration || 0) + breakDuration;
    attendance.breakStart = null; // Clear break start time
    attendance.isOnBreak = false; // Clear break status

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && attendance.cafeId) {
      emitToCafe(io, attendance.cafeId.toString(), "attendance:break_ended", attendance);
      emitToCafe(io, attendance.cafeId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      success: true,
      message: "Break ended",
      data: attendance,
      attendance, // Keep for backward compatibility
      breakDuration,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get attendance statistics
exports.getAttendanceStats = async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.query;
    const query = await buildHierarchyQuery(req.user);

    if (employeeId) {
      query.employeeId = employeeId;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
    }

    const attendance = await EmployeeAttendance.find(query).lean();

    const stats = {
      totalDays: attendance.length,
      present: attendance.filter((a) => a.status === "present").length,
      absent: attendance.filter((a) => a.status === "absent").length,
      late: attendance.filter((a) => a.status === "late").length,
      halfDay: attendance.filter((a) => a.status === "half_day").length,
      onLeave: attendance.filter((a) => a.status === "on_leave").length,
      sick: attendance.filter((a) => a.status === "sick").length,
      totalWorkingHours: attendance.reduce((sum, a) => sum + (a.workingHours || 0), 0),
      totalOvertime: attendance.reduce((sum, a) => sum + (a.overtime || 0), 0),
    };

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update attendance status manually (for admin)
exports.updateAttendanceStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Check hierarchy access
    const query = await buildHierarchyQuery(req.user);
    if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (query.franchiseId && attendance.franchiseId?.toString() !== query.franchiseId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (status) {
      attendance.status = status;
    }
    if (notes) {
      if (attendance.checkIn.time && !attendance.checkOut.time) {
        attendance.checkIn.notes = notes;
      } else if (attendance.checkOut.time) {
        attendance.checkOut.notes = notes;
      }
    }

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    return res.json(attendance);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
