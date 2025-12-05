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

    // For mobile users, get only their own attendance
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    if (allowedMobileRoles.includes(req.user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = req.user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employee = await Employee.findOne({
        name: req.user.name,
        cafeId: cartId,
      });

      if (employee) {
        query.employeeId = employee._id;
      } else {
        // No employee found, return empty
        return res.json({
          success: true,
          data: [],
        });
      }
    } else if (employeeId) {
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

    return res.json({
      success: true,
      data: attendance,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get past attendance (excluding today) for mobile users
exports.getPastAttendance = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const query = {
      ...buildHierarchyQuery(req.user),
      date: { $lt: today }, // Only dates before today
    };

    // For mobile users, get only their own attendance
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    if (allowedMobileRoles.includes(req.user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = req.user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employee = await Employee.findOne({
        name: req.user.name,
        cafeId: cartId,
      });

      if (employee) {
        query.employeeId = employee._id;
      } else {
        // No employee found, return empty
        return res.json({
          success: true,
          data: [],
        });
      }
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1 }) // Most recent first
      .limit(10) // Limit to last 10 records
      .lean();

    return res.json({
      success: true,
      data: attendance,
    });
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

    // For mobile users, get only their own attendance
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    if (allowedMobileRoles.includes(req.user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = req.user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employee = await Employee.findOne({
        name: req.user.name,
        cafeId: cartId,
      });

      if (employee) {
        query.employeeId = employee._id;
      } else {
        // No employee found, return empty
        return res.json({
          success: true,
          data: [],
        });
      }
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ "checkIn.time": -1 })
      .lean();

    return res.json({
      success: true,
      data: attendance,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Check-in employee
exports.checkIn = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;

    // Determine employeeId
    let targetEmployeeId = employeeId;

    // For mobile users (waiter, cook, captain, manager), auto-detect employeeId
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    let determinedCartId = null; // Store cartId for later validation
    
    if (!targetEmployeeId && allowedMobileRoles.includes(user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      // If user doesn't have cafeId, try to find a cart admin to associate with
      let cartId = user.cafeId;
      
      if (!cartId) {
        // Try to find a cart admin (user with role "admin") to associate with
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id franchiseId").lean();
        
        if (cartAdmin) {
          cartId = cartAdmin._id;
          // Update user's cafeId for future use (optional - don't fail if update fails)
          try {
            await User.findByIdAndUpdate(user._id, { cafeId: cartId, franchiseId: cartAdmin.franchiseId });
            console.log(`[ATTENDANCE] Auto-linked ${user.name} to cart admin: ${cartId}`);
            // Refresh user object to get updated cafeId
            const updatedUser = await User.findById(user._id).select("cafeId franchiseId").lean();
            if (updatedUser) {
              user.cafeId = updatedUser.cafeId;
              user.franchiseId = updatedUser.franchiseId;
            }
          } catch (updateError) {
            console.warn(`[ATTENDANCE] Could not update user cafeId:`, updateError.message);
          }
        } else {
          return res.status(400).json({ 
            message: "Your account is not associated with a cart. Please contact admin to set up your employee profile and link you to a cart." 
          });
        }
      }

      determinedCartId = cartId; // Store for validation later

      // Find employee by user name and cafeId (cartId)
      let employee = await Employee.findOne({
        name: user.name,
        cafeId: cartId,
      });

      // If employee doesn't exist, create one automatically for mobile users
      if (!employee) {
        try {
          // Get franchiseId from cart admin if not set
          let franchiseId = user.franchiseId;
          if (!franchiseId && cartId) {
            const User = require("../models/userModel");
            const cartAdmin = await User.findById(cartId).select("franchiseId").lean();
            if (cartAdmin && cartAdmin.franchiseId) {
              franchiseId = cartAdmin.franchiseId;
            }
          }
          
          // Provide default values for required fields
          const defaultDateOfBirth = new Date();
          defaultDateOfBirth.setFullYear(defaultDateOfBirth.getFullYear() - 25); // Default to 25 years ago
          
          // Map user roles to valid employeeRole enum values
          const roleMapping = {
            "waiter": "waiter",
            "cook": "chef", // Map "cook" to "chef"
            "captain": "waiter", // Map "captain" to "waiter" (or could be "other")
            "manager": "manager",
          };
          
          const employeeRole = roleMapping[user.role] || "other";
          
          employee = await Employee.create({
            name: user.name,
            mobile: user.mobile || "0000000000", // Provide default mobile if not available
            dateOfBirth: defaultDateOfBirth,
            employeeRole: employeeRole,
            cafeId: cartId, // This is actually the cart admin's user ID
            franchiseId: franchiseId,
            isActive: true,
          });
          
          console.log(`[ATTENDANCE] Auto-created employee record for ${user.name} (${user.role}) linked to cart: ${cartId}`);
        } catch (createError) {
          // Log the actual error for debugging
          console.error("[ATTENDANCE] Error creating employee:", createError);
          
          // Extract validation error message if available
          let errorMessage = createError.message;
          if (createError.errors) {
            const validationErrors = Object.values(createError.errors).map(err => err.message).join(", ");
            errorMessage = validationErrors;
          }
          
          return res.status(400).json({ 
            message: `Unable to create employee record: ${errorMessage}. Please contact admin to set up your employee profile.` 
          });
        }
      }

      if (employee) {
        targetEmployeeId = employee._id;
      } else {
        return res.status(400).json({ 
          message: "Unable to find or create employee record. Please contact admin to set up your employee profile." 
        });
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

    // For mobile users, ensure they can only check in themselves
    if (allowedMobileRoles.includes(user.role)) {
      // Use determinedCartId if available (from auto-linking), otherwise use user.cafeId
      const expectedCartId = determinedCartId || user.cafeId;
      
      // Validate: employee name must match user name, and employee must belong to the same cart
      if (employee.name !== user.name) {
        return res.status(403).json({ 
          message: "Access denied. You can only check in yourself. Employee name mismatch." 
        });
      }
      
      // For waiters, cafeId in employee represents the cart admin's ID
      // Check if employee belongs to the correct cart
      if (expectedCartId && employee.cafeId?.toString() !== expectedCartId.toString()) {
        return res.status(403).json({ 
          message: "Access denied. You can only check in yourself. Cart association mismatch." 
        });
      }
      
      // If no cartId was determined and employee has a cafeId, that's also valid
      // (This handles cases where user already had cafeId set)
      if (!expectedCartId && !employee.cafeId) {
        // Both are null/undefined, which is fine for non-cart employees
      }
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
    const user = req.user;
    const query = buildHierarchyQuery(user);

    // For mobile users, get only their own attendance stats
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    if (allowedMobileRoles.includes(user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employee = await Employee.findOne({
        name: user.name,
        cafeId: cartId,
      });

      if (employee) {
        query.employeeId = employee._id;
      } else {
        // No employee found, return empty stats
        return res.json({
          success: true,
          data: {
            totalDays: 0,
            workingDays: 0,
            leaveDays: 0,
            totalWorkingHours: 0,
            totalOvertime: 0,
            present: 0,
            absent: 0,
            late: 0,
            halfDay: 0,
            onLeave: 0,
            sick: 0,
          },
        });
      }
    } else if (employeeId) {
      // Admin can specify employeeId
      query.employeeId = employeeId;
    }

    // Default to current month if no dates specified
    if (!startDate && !endDate) {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      query.date = { $gte: firstDay, $lte: lastDay };
    } else {
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
        }
      }
    }

    const attendance = await EmployeeAttendance.find(query).lean();

    // Calculate stats using totalWorkingMinutes for accuracy
    const stats = {
      totalDays: attendance.length,
      workingDays: attendance.filter((a) => 
        a.status === "present" || 
        a.status === "late" || 
        a.status === "completed" ||
        (a.checkIn?.time && !a.checkOut?.time)
      ).length,
      leaveDays: attendance.filter((a) => 
        a.status === "on_leave" || 
        a.status === "absent"
      ).length,
      present: attendance.filter((a) => a.status === "present" || a.status === "completed").length,
      absent: attendance.filter((a) => a.status === "absent").length,
      late: attendance.filter((a) => a.status === "late").length,
      halfDay: attendance.filter((a) => a.status === "half_day").length,
      onLeave: attendance.filter((a) => a.status === "on_leave").length,
      sick: attendance.filter((a) => a.status === "sick").length,
      // Use totalWorkingMinutes if available, fallback to workingHours
      totalWorkingHours: attendance.reduce((sum, a) => {
        const minutes = a.totalWorkingMinutes || a.workingHours || 0;
        return sum + minutes;
      }, 0),
      totalOvertime: attendance.reduce((sum, a) => sum + (a.overtime || 0), 0),
    };

    return res.json({
      success: true,
      data: stats,
    });
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

// Start break - PATCH /api/attendance/:id/start-break
exports.startBreak = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Check if user role is allowed for mobile app
    const allowedRoles = ["waiter", "cook", "captain", "manager"];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Access denied. This feature is only available for waiter, cook, captain, and manager roles." });
    }

    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Verify ownership - employee must own this attendance
    const employee = await Employee.findById(attendance.employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // For mobile users, verify they own this attendance
    // Check if user email/name matches employee
    if (allowedRoles.includes(user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employeeByUser = await Employee.findOne({
        name: user.name,
        cafeId: cartId,
      });

      if (!employeeByUser || employeeByUser._id.toString() !== attendance.employeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only manage your own attendance." });
      }
    }

    if (!attendance.checkIn.time) {
      return res.status(400).json({ message: "Must check in before starting a break" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ message: "Cannot start break after checkout" });
    }

    if (attendance.isOnBreak) {
      return res.status(400).json({ message: "Already on break" });
    }

    const breakStartTime = new Date();
    attendance.isOnBreak = true;
    attendance.breakStart = breakStartTime;
    attendance.status = "on_break";

    // Calculate working minutes up to break start
    const checkInTime = new Date(attendance.checkIn.time);
    const workingMinutesBeforeBreak = Math.floor((breakStartTime - checkInTime) / (1000 * 60)) - (attendance.breakMinutes || 0);
    attendance.totalWorkingMinutes = Math.max(0, workingMinutesBeforeBreak);

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    return res.json({
      message: "Break started successfully",
      attendance,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// End break - PATCH /api/attendance/:id/end-break
exports.endBreak = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Check if user role is allowed for mobile app
    const allowedRoles = ["waiter", "cook", "captain", "manager"];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Access denied. This feature is only available for waiter, cook, captain, and manager roles." });
    }

    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Verify ownership
    const employee = await Employee.findById(attendance.employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    if (allowedRoles.includes(user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employeeByUser = await Employee.findOne({
        name: user.name,
        cafeId: cartId,
      });

      if (!employeeByUser || employeeByUser._id.toString() !== attendance.employeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only manage your own attendance." });
      }
    }

    if (!attendance.isOnBreak) {
      return res.status(400).json({ message: "Not currently on break" });
    }

    if (!attendance.breakStart) {
      return res.status(400).json({ message: "Break start time not found" });
    }

    const breakEndTime = new Date();
    const breakDuration = Math.floor((breakEndTime - attendance.breakStart) / (1000 * 60));

    attendance.isOnBreak = false;
    attendance.breakEnd = breakEndTime;
    attendance.breakMinutes = (attendance.breakMinutes || 0) + breakDuration;
    attendance.status = "present";

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    return res.json({
      message: "Break ended successfully",
      attendance,
      breakDuration,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Checkout - PATCH /api/attendance/:id/checkout
exports.checkout = async (req, res) => {
  try {
    const { id } = req.params;
    const { location, notes } = req.body;
    const user = req.user;

    // Check if user role is allowed for mobile app
    const allowedRoles = ["waiter", "cook", "captain", "manager"];
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Access denied. This feature is only available for waiter, cook, captain, and manager roles." });
    }

    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    // Verify ownership
    const employee = await Employee.findById(attendance.employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    if (allowedRoles.includes(user.role)) {
      // For waiters, cafeId represents the cart admin's user ID
      let cartId = user.cafeId;
      
      // If no cartId, try to find one from cart admin
      if (!cartId) {
        const User = require("../models/userModel");
        const cartAdmin = await User.findOne({ 
          role: "admin", 
          isActive: true,
          isApproved: true 
        }).select("_id").lean();
        if (cartAdmin) {
          cartId = cartAdmin._id;
        }
      }
      
      // Find employee by user name and cartId (cafeId)
      const employeeByUser = await Employee.findOne({
        name: user.name,
        cafeId: cartId,
      });

      if (!employeeByUser || employeeByUser._id.toString() !== attendance.employeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only manage your own attendance." });
      }
    }

    if (!attendance.checkIn.time) {
      return res.status(400).json({ message: "Must check in before checking out" });
    }

    if (attendance.checkOut.time) {
      return res.status(400).json({ message: "Already checked out" });
    }

    if (attendance.isOnBreak) {
      return res.status(400).json({ message: "Cannot checkout while on break. Please end break first." });
    }

    const checkOutTime = new Date();

    // Calculate final working hours
    const checkInTime = new Date(attendance.checkIn.time);
    const totalMinutes = Math.floor((checkOutTime - checkInTime) / (1000 * 60));
    const totalWorkingMinutes = totalMinutes - (attendance.breakMinutes || 0);

    attendance.checkOut = {
      time: checkOutTime,
      location: location || "",
      notes: notes || "",
    };
    attendance.totalWorkingMinutes = Math.max(0, totalWorkingMinutes);
    attendance.workingHours = Math.max(0, totalWorkingMinutes); // Keep for backward compatibility
    attendance.status = "completed";

    // Calculate overtime if schedule exists
    const schedule = await EmployeeSchedule.findOne({ employeeId: attendance.employeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
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

    attendance.overtime = Math.max(0, overtime);

    // Update status if half day
    if (totalWorkingMinutes < 240) {
      attendance.status = "half_day";
    }

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    return res.json({
      message: "Checked out successfully",
      attendance,
      totalWorkingMinutes,
      overtime,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};



