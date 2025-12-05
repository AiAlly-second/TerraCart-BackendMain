const EmployeeSchedule = require("../models/employeeScheduleModel");
const Employee = require("../models/employeeModel");

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

// Get all schedules
exports.getAllSchedules = async (req, res) => {
  try {
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const schedules = await EmployeeSchedule.find(hierarchyQuery)
      .populate("employeeId", "name employeeRole mobile")
      .sort({ createdAt: -1 });
    return res.json(schedules);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get schedule for a specific employee
exports.getEmployeeSchedule = async (req, res) => {
  try {
    const { employeeId } = req.params || {};
    
    // Check if this is the /my-schedule route (no employeeId param)
    const isMyScheduleRoute = !employeeId || employeeId === 'my-schedule' || req.path === '/my-schedule' || req.originalUrl.includes('/my-schedule');
    
    // For mobile users, get their own schedule
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    let actualEmployeeId = employeeId;
    
    if (allowedMobileRoles.includes(req.user.role) && (isMyScheduleRoute || !employeeId)) {
      // Mobile user getting their own schedule
      let cartId = req.user.cafeId;
      
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
      
      const employee = await Employee.findOne({
        name: req.user.name,
        cafeId: cartId,
      });
      
      if (employee) {
        actualEmployeeId = employee._id.toString();
      } else {
        return res.status(404).json({ message: "Employee record not found" });
      }
    } else if (employeeId) {
      // Verify employee belongs to user's hierarchy
      const hierarchyQuery = buildHierarchyQuery(req.user);
      const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
    }
    
    let schedule = await EmployeeSchedule.findOne({ employeeId: actualEmployeeId })
      .populate("employeeId", "name employeeRole mobile");
    
    if (!schedule) {
      // Create default schedule if doesn't exist
      const employee = await Employee.findById(actualEmployeeId);
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
      schedule = await EmployeeSchedule.create({
        employeeId: actualEmployeeId,
        weeklySchedule: [],
        cafeId: employee.cafeId,
        franchiseId: employee.franchiseId,
      });
      await schedule.populate("employeeId", "name employeeRole mobile");
    }
    
    return res.json({
      success: true,
      data: schedule,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create or update schedule
exports.upsertSchedule = async (req, res) => {
  try {
    const { employeeId } = req.body;
    
    // For mobile users, auto-detect employeeId if not provided
    const allowedMobileRoles = ["waiter", "cook", "captain", "manager"];
    let actualEmployeeId = employeeId;
    
    if (allowedMobileRoles.includes(req.user.role) && !employeeId) {
      // Mobile user updating their own schedule
      let cartId = req.user.cafeId;
      
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
      
      const employee = await Employee.findOne({
        name: req.user.name,
        cafeId: cartId,
      });
      
      if (employee) {
        actualEmployeeId = employee._id.toString();
        req.body.employeeId = actualEmployeeId;
      } else {
        return res.status(404).json({ message: "Employee record not found" });
      }
    }
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: actualEmployeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    // Set hierarchy from employee
    req.body.cafeId = employee.cafeId;
    req.body.franchiseId = employee.franchiseId;
    
    const schedule = await EmployeeSchedule.findOneAndUpdate(
      { employeeId: actualEmployeeId },
      req.body,
      { new: true, upsert: true }
    ).populate("employeeId", "name employeeRole mobile");
    
    return res.json({
      success: true,
      data: schedule,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Update today's state
exports.updateTodayState = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { todayState } = req.body;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    let schedule = await EmployeeSchedule.findOne({ employeeId });
    if (!schedule) {
      schedule = await EmployeeSchedule.create({
        employeeId,
        weeklySchedule: [],
        todayState,
        cafeId: employee.cafeId,
        franchiseId: employee.franchiseId,
      });
    } else {
      schedule.todayState = todayState;
      await schedule.save();
    }
    
    await schedule.populate("employeeId", "name employeeRole mobile");
    return res.json(schedule);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete schedule
exports.deleteSchedule = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    await EmployeeSchedule.findOneAndDelete({ employeeId });
    return res.json({ message: "Schedule deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};













