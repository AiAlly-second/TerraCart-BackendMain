const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - get their employee record to find cafeId
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      query.cafeId = employee.cafeId;
      // For individual mobile users, only show their own attendance
      query.employeeId = employee._id;
    }
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      query.cafeId = employee.cafeId;
      query.employeeId = employee._id;
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

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const query = {
      ...hierarchyQuery,
      date: { $gte: today, $lt: tomorrow },
    };

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ "checkIn.time": -1 })
      .lean();

    return res.json(attendance);
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
    if (user.role === "admin" && employee.cafeId?.toString() !== user._id.toString()) {
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

    // Check if already checked in today (using IST timezone)
    // IST is UTC+5:30
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds
    const istNow = new Date(now.getTime() + istOffset);
    
    // Get today's date in IST
    const today = new Date(istNow);
    today.setUTCHours(0, 0, 0, 0);
    today.setTime(today.getTime() - istOffset); // Convert back to UTC for MongoDB query
    
    const tomorrow = new Date(today);
    tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);

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
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      // Use IST date for day calculation
      const todayDay = dayNames[istNow.getUTCDay()];
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.startTime) {
        const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
        // Create scheduled time in IST, then convert to UTC for comparison
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
      // Update existing record
      attendance.checkIn = {
        time: checkInTime,
        location: location || "",
        notes: notes || "",
      };
      attendance.status = status;
      attendance.cafeId = employee.cafeId;
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
        cafeId: employee.cafeId,
        franchiseId: employee.franchiseId,
      });
    }

    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && attendance.cafeId) {
      emitToCafe(io, attendance.cafeId.toString(), "attendance:checked_in", attendance);
      emitToCafe(io, attendance.cafeId.toString(), "attendance:updated", attendance);
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
    if (user.role === "admin" && employee.cafeId?.toString() !== user._id.toString()) {
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

    // Find today's attendance (using IST timezone)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds
    const istNow = new Date(now.getTime() + istOffset);
    
    // Get today's date in IST
    const today = new Date(istNow);
    today.setUTCHours(0, 0, 0, 0);
    today.setTime(today.getTime() - istOffset); // Convert back to UTC for MongoDB query
    
    const tomorrow = new Date(today);
    tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);

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
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      // Use IST date for day calculation
      const todayDay = dayNames[istNow.getUTCDay()];
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        // Create scheduled end time in IST, then convert to UTC for comparison
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setUTCHours(hours, minutes, 0, 0);
        scheduledEndTimeIST.setTime(scheduledEndTimeIST.getTime() - istOffset); // Convert to UTC
        
        // Compare checkOutTime (UTC) with scheduledEndTime (UTC)
        if (checkOutTime > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTime - scheduledEndTimeIST) / (1000 * 60));
        }
      }
    }

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
    if (io && emitToCafe && attendance.cafeId) {
      emitToCafe(io, attendance.cafeId.toString(), "attendance:checked_out", attendance);
      emitToCafe(io, attendance.cafeId.toString(), "attendance:updated", attendance);
    }

    return res.json({
      message: "Checked out successfully",
      attendance,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
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
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Check access - mobile users can only manage their own attendance
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    if (!attendance.checkIn.time) {
      return res.status(400).json({ message: "Employee has not checked in" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ message: "Employee has already checked out" });
    }

    if (attendance.breakStart) {
      return res.status(400).json({ message: "Break already started" });
    }

    attendance.breakStart = new Date();
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
      message: "Break started",
      attendance,
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
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    if (!attendance.breakStart) {
      return res.status(400).json({ message: "Break has not been started" });
    }

    const breakEnd = new Date();
    const breakDuration = Math.floor((breakEnd - attendance.breakStart) / (1000 * 60)); // in minutes
    attendance.breakDuration = (attendance.breakDuration || 0) + breakDuration;
    attendance.breakStart = null; // Clear break start time

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
      message: "Break ended",
      attendance,
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
