const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cafeId = user._id;
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  }
  return query;
};

// Get all attendance records
exports.getAllAttendance = async (req, res) => {
  try {
    const { employeeId, startDate, endDate, status } = req.query;
    const query = buildHierarchyQuery(req.user);

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

    const query = {
      ...buildHierarchyQuery(req.user),
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

// Check-in employee
exports.checkIn = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;

    // Determine employeeId - must be provided in body
    const targetEmployeeId = employeeId;

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

    // Check if already checked in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let attendance = await EmployeeAttendance.findOne({
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    });

    if (attendance && attendance.checkIn.time) {
      return res.status(400).json({ message: "Employee already checked in today" });
    }

    const checkInTime = new Date();

    // Get employee schedule to check if late
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    let status = "present";
    let isLate = false;

    if (schedule && schedule.weeklySchedule) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const todayDay = dayNames[today.getDay()];
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.startTime) {
        const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
        const scheduledTime = new Date(today);
        scheduledTime.setHours(hours, minutes, 0, 0);

        if (checkInTime > scheduledTime) {
          const lateMinutes = Math.floor((checkInTime - scheduledTime) / (1000 * 60));
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

    // Determine employeeId - must be provided in body
    const targetEmployeeId = employeeId;

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

    // Find today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

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

    const checkOutTime = new Date();

    // Calculate working hours
    const checkInTime = new Date(attendance.checkIn.time);
    const workingMinutes = Math.floor((checkOutTime - checkInTime) / (1000 * 60));
    const workingHours = workingMinutes - (attendance.breakDuration || 0);

    // Get schedule to calculate overtime
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const todayDay = dayNames[today.getDay()];
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        const scheduledEndTime = new Date(today);
        scheduledEndTime.setHours(hours, minutes, 0, 0);

        if (checkOutTime > scheduledEndTime) {
          overtime = Math.floor((checkOutTime - scheduledEndTime) / (1000 * 60));
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

    return res.json({
      message: "Checked out successfully",
      attendance,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get attendance statistics
exports.getAttendanceStats = async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.query;
    const query = buildHierarchyQuery(req.user);

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
    const query = buildHierarchyQuery(req.user);
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

