const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
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

const getTodaySchedule = (schedule, dayName) => {
  if (!schedule || !Array.isArray(schedule.weeklySchedule)) return null;
  return schedule.weeklySchedule.find((entry) => entry.day === dayName) || null;
};

const normalizeBreaks = (attendance) => {
  if (!Array.isArray(attendance?.breaks)) return [];
  return attendance.breaks.map((entry) => ({
    breakStart: entry?.breakStart || null,
    breakEnd: entry?.breakEnd || null,
    durationMinutes: Number(entry?.durationMinutes || 0),
  }));
};

const inferAttendanceStatus = (attendance) => {
  if (attendance?.isCheckedOut || attendance?.checkOut?.time) return "checked_out";
  if (attendance?.isOnBreak || attendance?.breakStart) return "on_break";
  if (attendance?.checkIn?.time) return "checked_in";
  if (attendance?.status === "absent") return "absent";
  return "not_checked_in";
};

const inferCheckInStatus = (attendanceStatus) => {
  if (attendanceStatus === "checked_in" || attendanceStatus === "on_break") {
    return "checked_in";
  }
  if (attendanceStatus === "checked_out") return "checked_out";
  if (attendanceStatus === "absent") return "absent";
  return "not_checked_in";
};

const normalizeAttendanceRecord = (record) => {
  const plainRecord = record?.toObject ? record.toObject() : { ...record };
  const attendanceStatus = plainRecord.attendanceStatus || inferAttendanceStatus(plainRecord);
  const checkInStatus = plainRecord.checkInStatus || inferCheckInStatus(attendanceStatus);
  const isCheckedOut = Boolean(
    plainRecord.isCheckedOut ||
    attendanceStatus === "checked_out" ||
    plainRecord.checkOut?.time
  );
  const breaks = normalizeBreaks(plainRecord);
  const totalBreakMinutes = Number(
    plainRecord.breakDuration ??
    plainRecord.breakMinutes ??
    breaks.reduce((sum, entry) => sum + Number(entry.durationMinutes || 0), 0)
  );

  return {
    ...plainRecord,
    attendanceStatus,
    checkInStatus,
    canTakeBreak: plainRecord.canTakeBreak ?? (attendanceStatus === "checked_in" || attendanceStatus === "on_break"),
    isCheckedOut,
    breakDuration: totalBreakMinutes,
    breakMinutes: totalBreakMinutes,
    breaks,
    checkInTime: plainRecord.checkIn?.time || null,
    checkOutTime: plainRecord.checkOut?.time || null,
  };
};

const getRecordEmployeeId = (record) => {
  const employee = record?.employeeId;
  if (!employee) return null;
  if (typeof employee === "string") return employee;
  if (typeof employee === "object") {
    return (employee._id || employee.id || employee.toString())?.toString() || null;
  }
  return null;
};

const getAttendancePriority = (record) => {
  const status = normalizeAttendanceRecord(record)?.attendanceStatus;
  switch (status) {
    case "checked_out":
      return 4;
    case "on_break":
      return 3;
    case "checked_in":
      return 2;
    case "absent":
      return 1;
    default:
      return 0;
  }
};

const pickPreferredAttendanceRecord = (current, candidate) => {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentPriority = getAttendancePriority(current);
  const candidatePriority = getAttendancePriority(candidate);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }

  const currentTime = new Date(
    current.updatedAt ||
      current.checkOut?.time ||
      current.checkIn?.time ||
      current.createdAt ||
      current.date ||
      0
  ).getTime();
  const candidateTime = new Date(
    candidate.updatedAt ||
      candidate.checkOut?.time ||
      candidate.checkIn?.time ||
      candidate.createdAt ||
      candidate.date ||
      0
  ).getTime();

  return candidateTime >= currentTime ? candidate : current;
};

const dedupeAttendanceByEmployee = (records = []) => {
  const map = new Map();
  for (const record of records) {
    const employeeId = getRecordEmployeeId(record);
    if (!employeeId) continue;
    const existing = map.get(employeeId);
    map.set(employeeId, pickPreferredAttendanceRecord(existing, record));
  }
  return Array.from(map.values());
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    // Support both cartId (new) and cafeId (old) during migration
    query.$or = [
      { cartId: user._id },
      { cafeId: user._id }
    ];
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
      // Support both cartId (new) and cafeId (old) during migration
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId } // Use cartId value for both fields
      ];
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
      // Support both cartId (new) and cafeId (old) during migration
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId }
      ];
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
        // Support both cartId (new) and cafeId (old) during migration
        query.$or = [
          { cartId: employeeByEmail.cartId },
          { cafeId: employeeByEmail.cartId }
        ];
        query.employeeId = employeeByEmail._id;
      } else {
        query.employeeId = { $exists: false }; // No employee record found, return no results
      }
    } else if (employee) {
      // Support both cartId (new) and cafeId (old) during migration
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId }
      ];
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

    if (req.query.cartId) {
      const cartFilter = { $or: [{ cartId: req.query.cartId }, { cafeId: req.query.cartId }] };
      if (query.$or) {
        query.$and = [{ $or: query.$or }, cartFilter];
        delete query.$or;
      } else {
        Object.assign(query, cartFilter);
      }
    }

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
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
          // Create scheduled start time in IST
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
          
          // Add 30 minute buffer in IST
          const bufferTimeIST = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
            
            if (istNow >= bufferTimeIST) {
              try {
                await EmployeeAttendance.create({
                  employeeId: employee._id,
                  date: today,
                  status: "absent",
                  attendanceStatus: "absent",
                  checkInStatus: "absent",
                  canTakeBreak: false,
                  isCheckedOut: false,
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
      // Convert dates to IST boundaries (UTC-5:30)
      const IST_OFFSET_MINS = 330; // 5.5 hours * 60

      if (startDate) {
        const d = new Date(startDate);
        // Calculate Start of Day in IST (00:00 IST), converted to UTC
        // Default new Date(YYYY-MM-DD) is 00:00 UTC. 
        // 00:00 IST is 18:30 Prev Day UTC. Subtract 5.5 hours.
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$gte = d;
      }
      if (endDate) {
        const d = new Date(endDate);
        // Calculate End of Day in IST (23:59:59 IST), converted to UTC
        d.setHours(23, 59, 59, 999);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$lte = d;
      }
    } else if (isQueryingToday) {
      // If querying today (or no dates provided), ensure date filter is set to today
      // UNLESS searching for all history (no dates provided) - wait, isQueryingToday logic handles that
      // If startDate/endDate undefined, isQueryingToday is TRUE.
      // So default behavior is SHOW TODAY ONLY.
      // If user wants ALL history, they must provide wide date range or we change default.
      query.date = { $gte: today, $lt: tomorrow };
    }

    if (status) {
      query.status = status;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(attendance.map((record) => normalizeAttendanceRecord(record)));
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

    let hierarchyQuery = await buildHierarchyQuery(req.user);
    // Manager sees all employees' attendance in their cart (not just their own)
    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      if (managerCartId) {
        hierarchyQuery = { $or: [{ cartId: managerCartId }, { cafeId: managerCartId }] };
      }
    }
    const query = {
      ...hierarchyQuery,
      date: { $gte: today, $lt: tomorrow },
    };

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    // Get existing attendance records
    // For mobile users, query should already filter by employeeId
    console.log('[ATTENDANCE] getTodayAttendance query:', JSON.stringify(query, null, 2));
    let attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ "checkIn.time": -1 })
      .lean();
    console.log('[ATTENDANCE] getTodayAttendance found records:', attendance.length);

    // Get all employees in the hierarchy to check for absent employees
    let employeeQuery = await buildHierarchyQuery(req.user);
    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      if (managerCartId) {
        employeeQuery = { $or: [{ cartId: managerCartId }, { cafeId: managerCartId }] };
      }
    }
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
          // Create scheduled start time in IST
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
          
          // Add 30 minute buffer in IST - only mark absent if it's 30 minutes past scheduled start time
          const bufferTimeIST = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
          
            if (istNow >= bufferTimeIST) {
            // Create absent attendance record
            try {
              const absentAttendance = await EmployeeAttendance.create({
                employeeId: employee._id,
                date: today,
                status: "absent",
                attendanceStatus: "absent",
                checkInStatus: "absent",
                canTakeBreak: false,
                isCheckedOut: false,
                cartId: employee.cartId || employee.cafeId,
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

    attendance = dedupeAttendanceByEmployee(attendance);

    // Calculate real-time working hours for employees who are checked in but not checked out
    const attendanceWithWorkingHours = attendance.map((record) => {
      // If already checked out, use stored values
      if (record.checkOut?.time) {
        return normalizeAttendanceRecord(record);
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
        return normalizeAttendanceRecord({
          ...record,
          totalWorkingMinutes: workingMinutes,
          workingHours: Number((workingMinutes / 60).toFixed(2)),
        });
      }

      return normalizeAttendanceRecord(record);
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

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    return res.json(attendance.map((record) => normalizeAttendanceRecord(record)));
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
    // Mobile users: waiter/cook/captain can only check themselves in; manager can check in employees in their cart
    if (["waiter", "cook", "captain"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || userEmployee._id.toString() !== targetEmployeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only check yourself in." });
      }
    }
    if (user.role === "manager" && employeeId) {
      // Manager can manual check-in for employees in their cart
      const managerEmployee = await Employee.findOne({ userId: user._id }).lean();
      const managerCartId = managerEmployee?.cartId || managerEmployee?.cafeId || user.cartId || user.cafeId;
      const empCartId = employee.cartId || employee.cafeId;
      if (!managerCartId || !empCartId || empCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied. Employee must be in your cart." });
      }
    }

    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

    // Build query with cartId to ensure consistency with getTodayAttendance
    // This ensures we only find attendance records that match both employeeId AND cartId
    const attendanceQuery = {
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    };
    
    // Add cartId filter if employee has cartId (should always have it)
    if (employee.cartId) {
      attendanceQuery.cartId = employee.cartId;
    }
    
    console.log('[ATTENDANCE] checkIn query:', JSON.stringify(attendanceQuery, null, 2));
    let attendance = await EmployeeAttendance.findOne(attendanceQuery);
    console.log('[ATTENDANCE] checkIn found record:', attendance ? 'YES' : 'NO');
    
    // If no record found with cartId, check for old records without cartId (migration fix)
    if (!attendance && employee.cartId) {
      const fallbackQuery = {
        employeeId: targetEmployeeId,
        date: { $gte: today, $lt: tomorrow },
        $or: [
          { cartId: { $exists: false } },
          { cartId: null },
        ],
      };
      console.log('[ATTENDANCE] checkIn fallback query (no cartId):', JSON.stringify(fallbackQuery, null, 2));
      attendance = await EmployeeAttendance.findOne(fallbackQuery);
      if (attendance) {
        console.log('[ATTENDANCE] checkIn - Found old record without cartId, updating...');
        attendance.cartId = employee.cartId;
        await attendance.save();
        console.log('[ATTENDANCE] checkIn - Updated cartId on old record');
      }
    }
    
    if (attendance) {
      console.log('[ATTENDANCE] checkIn record details:', {
        _id: attendance._id,
        employeeId: attendance.employeeId?.toString(),
        cartId: attendance.cartId?.toString(),
        date: attendance.date,
        hasCheckIn: !!attendance.checkIn?.time,
      });
    }

    // Get employee schedule to validate off-day and late status (all comparisons in IST)
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    const todayDay = getISTDayName();
    const todaySchedule = getTodaySchedule(schedule, todayDay);
    if (todaySchedule && todaySchedule.isWorking === false) {
      return res.status(400).json({
        message: "Today is your off day. Check-in is disabled.",
        code: "OFF_DAY",
      });
    }

    if (attendance && (attendance.isCheckedOut || attendance.checkOut?.time)) {
      return res.status(400).json({
        message: "You have already checked out for today. Check-in is locked.",
        code: "ALREADY_CHECKED_OUT",
      });
    }

    if (attendance && attendance.checkIn && attendance.checkIn.time) {
      console.log('[ATTENDANCE] checkIn - Employee already checked in');
      if (!attendance.cartId && employee.cartId) {
        attendance.cartId = employee.cartId;
        await attendance.save();
        console.log('[ATTENDANCE] checkIn - Updated cartId on existing record');
      }
      await attendance.populate("employeeId", "name mobile employeeRole");
      return res.json({
        message: "Already checked in today",
        attendance: normalizeAttendanceRecord(attendance),
        isLate: false,
      });
    }

    // Get current time in IST, then convert to UTC for MongoDB storage
    const checkInTimeIST = getISTNow();
    const checkInTime = istToUTC(checkInTimeIST); // Store in UTC (MongoDB default)

    let status = "present";
    let isLate = false;

    if (todaySchedule && todaySchedule.isWorking && todaySchedule.startTime) {
      const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
        // Create scheduled time in IST for today
        const scheduledTimeIST = new Date(istNow);
        scheduledTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
        
        // Compare checkInTime (IST) with scheduledTime (IST)
        if (checkInTimeIST > scheduledTimeIST) {
          const lateMinutes = Math.floor((checkInTimeIST - scheduledTimeIST) / (1000 * 60));
          if (lateMinutes > 15) {
            // Late if more than 15 minutes
            status = "late";
            isLate = true;
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
      attendance.attendanceStatus = "checked_in";
      attendance.checkInStatus = "checked_in";
      attendance.canTakeBreak = true;
      attendance.isCheckedOut = false;
      attendance.isOnBreak = false;
      attendance.breakStart = null;
      attendance.breaks = [];
      attendance.breakDuration = 0;
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
        attendanceStatus: "checked_in",
        checkInStatus: "checked_in",
        canTakeBreak: true,
        isCheckedOut: false,
        isOnBreak: false,
        breakDuration: 0,
        breaks: [],
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
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_in", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      message: isLate ? "Checked in (Late)" : "Checked in successfully",
      attendance: normalizeAttendanceRecord(attendance),
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

    // Build query with cartId to ensure consistency with getTodayAttendance
    const attendanceQuery = {
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    };
    
    // Add cartId filter if employee has cartId
    if (employee.cartId) {
      attendanceQuery.cartId = employee.cartId;
    }
    
    console.log('[ATTENDANCE] checkOut query:', JSON.stringify(attendanceQuery, null, 2));
    const attendance = await EmployeeAttendance.findOne(attendanceQuery);
    console.log('[ATTENDANCE] checkOut found record:', attendance ? 'YES' : 'NO');

    if (!attendance || !attendance.checkIn || !attendance.checkIn.time) {
      return res.status(400).json({ message: "Employee has not checked in today" });
    }

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(400).json({ message: "Employee already checked out today" });
    }

    if (attendance.isOnBreak || attendance.breakStart) {
      return res.status(400).json({ message: "Cannot checkout while on break. Please end break first." });
    }

    // Get current time in IST, then convert to UTC for MongoDB storage
    const checkOutTimeIST = getISTNow();
    const checkOutTime = istToUTC(checkOutTimeIST); // Store in UTC (MongoDB default)

    // Calculate working hours (convert stored UTC times to IST for calculation)
    const checkInTimeUTC = new Date(attendance.checkIn.time);
    const checkInTimeIST = utcToIST(checkInTimeUTC);
    const workingMinutes = Math.floor((checkOutTimeIST - checkInTimeIST) / (1000 * 60));
    const totalWorkingMinutes = Math.max(0, workingMinutes - (attendance.breakDuration || 0));

    // Get schedule to calculate overtime (all comparisons in IST)
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      // Use IST date for day calculation
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        // Create scheduled end time in IST for today
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
        
        // Compare checkOutTime (IST) with scheduledEndTime (IST)
        if (checkOutTimeIST > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTimeIST - scheduledEndTimeIST) / (1000 * 60));
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
    attendance.totalWorkingMinutes = totalWorkingMinutes;
    attendance.workingHours = Number((totalWorkingMinutes / 60).toFixed(2));
    attendance.overtime = Math.max(0, overtime);
    attendance.isOnBreak = false;
    attendance.breakStart = null;
    attendance.attendanceStatus = "checked_out";
    attendance.checkInStatus = "checked_out";
    attendance.canTakeBreak = false;
    attendance.isCheckedOut = true;

    // Update status if half day
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
    const attendanceCartId = attendance.cartId || attendance.cafeId; // Support both for backward compatibility
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_out", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      message: "Checked out successfully",
      attendance: normalizeAttendanceRecord(attendance),
      totalWorkingMinutes,
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

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(400).json({ success: false, message: "Employee already checked out" });
    }

    // Check if on break - must end break before checkout
    if (attendance.isOnBreak || (attendance.breakStart && !attendance.checkOut?.time)) {
      return res.status(400).json({ success: false, message: "Cannot checkout while on break. Please end break first." });
    }

    // Get current time in IST, then convert to UTC for MongoDB storage
    const checkOutTimeIST = getISTNow();
    const checkOutTime = istToUTC(checkOutTimeIST); // Store in UTC (MongoDB default)

    // Calculate working hours (convert stored UTC times to IST for calculation)
    const checkInTimeUTC = new Date(attendance.checkIn.time);
    const checkInTimeIST = utcToIST(checkInTimeUTC);
    const totalDurationMinutes = Math.floor((checkOutTimeIST - checkInTimeIST) / (1000 * 60));
    const breakMinutes = attendance.breakDuration || 0;
    const totalWorkingMinutes = Math.max(0, totalDurationMinutes - breakMinutes);

    // Get schedule to calculate overtime (all comparisons in IST)
    const schedule = await EmployeeSchedule.findOne({ employeeId: attendance.employeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      const istNow = getISTNow();
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        // Create scheduled end time in IST for today
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
        
        // Compare checkOutTime (IST) with scheduledEndTime (IST)
        if (checkOutTimeIST > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTimeIST - scheduledEndTimeIST) / (1000 * 60));
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
    attendance.isOnBreak = false;
    attendance.breakStart = null;
    attendance.attendanceStatus = "checked_out";
    attendance.checkInStatus = "checked_out";
    attendance.canTakeBreak = false;
    attendance.isCheckedOut = true;
    
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
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_out", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Checked out successfully",
      data: normalizeAttendanceRecord(attendance),
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

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(400).json({ success: false, message: "Employee has already checked out" });
    }

    if (attendance.canTakeBreak === false) {
      return res.status(400).json({ success: false, message: "Break not allowed before check-in" });
    }

    // Check if already on break (using isOnBreak field or breakStart)
    if (attendance.isOnBreak || attendance.breakStart) {
      return res.status(400).json({ success: false, message: "Break already started" });
    }

    attendance.breakStart = new Date();
    attendance.isOnBreak = true;
    attendance.attendanceStatus = "on_break";
    attendance.checkInStatus = "checked_in";
    attendance.canTakeBreak = true;
    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:break_started", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Break started",
      data: normalizeAttendanceRecord(attendance),
      attendance: normalizeAttendanceRecord(attendance), // Keep for backward compatibility
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

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(400).json({ success: false, message: "Employee has already checked out" });
    }

    const breakEnd = new Date();
    const breakStart = attendance.breakStart ? new Date(attendance.breakStart) : breakEnd;
    const breakDuration = Math.max(0, Math.floor((breakEnd - breakStart) / (1000 * 60))); // in minutes
    attendance.breakDuration = (attendance.breakDuration || 0) + breakDuration;
    if (!Array.isArray(attendance.breaks)) {
      attendance.breaks = [];
    }
    attendance.breaks.push({
      breakStart,
      breakEnd,
      durationMinutes: breakDuration,
    });
    attendance.breakStart = null; // Clear break start time
    attendance.isOnBreak = false; // Clear break status
    attendance.attendanceStatus = "checked_in";
    attendance.checkInStatus = "checked_in";
    attendance.canTakeBreak = true;

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:break_ended", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Break ended",
      data: normalizeAttendanceRecord(attendance),
      attendance: normalizeAttendanceRecord(attendance), // Keep for backward compatibility
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

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    if (startDate || endDate) {
      query.date = {};
      // Convert dates to IST boundaries (UTC-5:30)
      const IST_OFFSET_MINS = 330; 

      if (startDate) {
        const d = new Date(startDate);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$gte = d;
      }
      if (endDate) {
        const d = new Date(endDate);
        d.setHours(23, 59, 59, 999);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$lte = d;
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
    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      const attCartId = attendance.cartId || attendance.cafeId;
      if (!managerCartId || !attCartId || attCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    } else if (query.franchiseId && attendance.franchiseId?.toString() !== query.franchiseId.toString()) {
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

    return res.json(normalizeAttendanceRecord(attendance));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete attendance record (admin, manager - for erroneous records)
exports.deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      const attCartId = attendance.cartId || attendance.cafeId;
      if (!managerCartId || !attCartId || attCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (!["admin", "franchise_admin", "super_admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    await EmployeeAttendance.findByIdAndDelete(id);
    return res.json({ message: "Attendance record deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
