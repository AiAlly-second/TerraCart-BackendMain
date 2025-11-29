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
    const { employeeId } = req.params;
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
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
        cafeId: employee.cafeId,
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
    
    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = buildHierarchyQuery(req.user);
    const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    
    // Set hierarchy from employee
    req.body.cafeId = employee.cafeId;
    req.body.franchiseId = employee.franchiseId;
    
    const schedule = await EmployeeSchedule.findOneAndUpdate(
      { employeeId },
      req.body,
      { new: true, upsert: true }
    ).populate("employeeId", "name employeeRole mobile");
    
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













