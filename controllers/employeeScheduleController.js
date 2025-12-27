const EmployeeSchedule = require("../models/employeeScheduleModel");
const Employee = require("../models/employeeModel");

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    query.cartId = user._id; // EmployeeSchedule model uses cartId, not cafeId
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users - get their employee record to find cartId
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      query.cartId = employee.cartId; // EmployeeSchedule model uses cartId, not cafeId
    }
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      query.cartId = employee.cartId; // EmployeeSchedule model uses cartId, not cafeId
    }
  }
  return query;
};

// Get all schedules
exports.getAllSchedules = async (req, res) => {
  try {
    const hierarchyQuery = await buildHierarchyQuery(req.user);
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
    const { employeeId } = req.params;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = await buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    let schedule = await EmployeeSchedule.findOne({ employeeId })
      .populate("employeeId", "name employeeRole mobile");
    
    if (!schedule) {
      // Create default schedule if doesn't exist
      schedule = await EmployeeSchedule.create({
        employeeId,
        weeklySchedule: [],
        cartId: employee.cartId, // EmployeeSchedule model uses cartId, not cafeId
        franchiseId: employee.franchiseId,
      });
      await schedule.populate("employeeId", "name employeeRole mobile");
    }
    
    return res.json(schedule);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get current user's schedule (for mobile app)
exports.getMySchedule = async (req, res) => {
  try {
    const user = req.user;
    
    // For mobile users, get their employee record
    let employee;
    if (["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      if (user.employeeId) {
        employee = await Employee.findById(user.employeeId);
      } else {
        employee = await Employee.findOne({
          $or: [
            { userId: user._id },
            { email: user.email?.toLowerCase() }
          ]
        });
      }
    }
    
    if (!employee) {
      return res.status(404).json({ message: "Employee record not found for this user" });
    }
    
    let schedule = await EmployeeSchedule.findOne({ employeeId: employee._id })
      .populate("employeeId", "name employeeRole mobile");
    
    if (!schedule) {
      // Create default schedule if doesn't exist
      schedule = await EmployeeSchedule.create({
        employeeId: employee._id,
        weeklySchedule: [],
        cartId: employee.cartId, // EmployeeSchedule model uses cartId, not cafeId
        franchiseId: employee.franchiseId,
      });
      await schedule.populate("employeeId", "name employeeRole mobile");
    }
    
    return res.json(schedule);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Create or update schedule
exports.upsertSchedule = async (req, res) => {
  try {
    const { employeeId } = req.body;
    const user = req.user;
    
    // Verify employee belongs to user's hierarchy OR is the current user's employee record
    const hierarchyQuery = await buildHierarchyQuery(user);
    let employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    
    // If not found in hierarchy, check if it's the current user's own employee record
    if (!employee && ["waiter", "cook", "captain", "manager", "employee"].includes(user.role)) {
      const userEmployee = await Employee.findOne({
        _id: employeeId,
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      });
      if (userEmployee) {
        employee = userEmployee;
      }
    }
    
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    // Set hierarchy from employee
    req.body.cartId = employee.cartId; // EmployeeSchedule model uses cartId, not cafeId
    req.body.franchiseId = employee.franchiseId;
    
    const schedule = await EmployeeSchedule.findOneAndUpdate(
      { employeeId },
      req.body,
      { new: true, upsert: true }
    ).populate("employeeId", "name employeeRole mobile");
    
    // Emit socket event for real-time updates
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const scheduleCartId = schedule.cartId || schedule.cafeId; // Support old cafeId field for backward compatibility
    if (io && emitToCafe && scheduleCartId) {
      emitToCafe(io, scheduleCartId.toString(), "schedule:updated", schedule);
    }
    
    return res.json(schedule);
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
    const hierarchyQuery = await buildHierarchyQuery(req.user);
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
        cartId: employee.cartId, // EmployeeSchedule model uses cartId, not cafeId
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
    const hierarchyQuery = await buildHierarchyQuery(req.user);
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













