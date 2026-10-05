const EmployeeSchedule = require("../models/employeeScheduleModel");
const Employee = require("../models/employeeModel");
const mongoose = require("mongoose");

const DAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const validateWeek = (week) => {
  if (!Array.isArray(week) || week.length > 7) return "Provide a weekly schedule with at most seven days";
  const seen = new Set();
  for (const entry of week) {
    if (!entry || !DAYS.has(entry.day) || seen.has(entry.day)) return "Choose each valid day only once";
    seen.add(entry.day);
    if (typeof entry.isWorking !== "boolean" || typeof entry.startTime !== "string" ||
        typeof entry.endTime !== "string" || !TIME.test(entry.startTime) || !TIME.test(entry.endTime)) {
      return "Provide valid HH:mm start and end times and a working-day selection";
    }
    // Attendance uses start and end on the same Kolkata business day.
    if (entry.isWorking && entry.startTime >= entry.endTime) return "Start time must be before end time on working days";
  }
  return null;
};

const createDefaultSchedule = (employee) => EmployeeSchedule.findOneAndUpdate(
  { employeeId: employee._id },
  { $setOnInsert: { employeeId: employee._id, weeklySchedule: [],
      cartId: employee.cartId || employee.cafeId, franchiseId: employee.franchiseId,
      createdAt: new Date(), updatedAt: new Date() } },
  { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true, timestamps: false }
).populate("employeeId", "name employeeRole mobile");

const SELF_ONLY_ROLES = new Set(["waiter", "cook", "employee"]);
const CART_SCOPED_ROLES = new Set(["manager", "captain"]);

const buildNoAccessQuery = () => ({ employeeId: { $in: [] } });

const resolveEmployeeForUser = async (user) => {
  if (!user) return null;

  if (user.employeeId) {
    const byId = await Employee.findById(user.employeeId).lean();
    if (byId) return byId;
  }

  const byUserId = await Employee.findOne({ userId: user._id }).lean();
  if (byUserId) return byUserId;

  if (!user.email) return null;
  return Employee.findOne({ email: String(user.email).toLowerCase() }).lean();
};

const applyCartScope = (query, cartId) => {
  if (!cartId) return false;
  query.$or = [{ cartId }, { cafeId: cartId }];
  return true;
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  if (!user?.role) return buildNoAccessQuery();

  const role = String(user.role).toLowerCase();
  const query = {};

  if (role === "super_admin") {
    return query;
  }

  if (role === "admin") {
    if (applyCartScope(query, user._id)) {
      return query;
    }
    return buildNoAccessQuery();
  }

  if (role === "franchise_admin") {
    query.franchiseId = user._id;
    return query;
  }

  if (CART_SCOPED_ROLES.has(role)) {
    const employee = await resolveEmployeeForUser(user);
    const employeeCartId = employee?.cartId || employee?.cafeId || null;
    if (applyCartScope(query, employeeCartId)) {
      return query;
    }
    return buildNoAccessQuery();
  }

  if (SELF_ONLY_ROLES.has(role)) {
    const employee = await resolveEmployeeForUser(user);
    if (employee) {
      query.employeeId = employee._id;
      return query;
    }
    return buildNoAccessQuery();
  }

  return buildNoAccessQuery();
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
    const role = String(req.user?.role || "").toLowerCase();

    const targetEmployee = await Employee.findById(employeeId).lean();
    if (!targetEmployee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    if (SELF_ONLY_ROLES.has(role)) {
      const selfEmployee = await resolveEmployeeForUser(req.user);
      if (!selfEmployee || selfEmployee._id.toString() !== targetEmployee._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else {
      // Verify employee belongs to user's hierarchy
      const hierarchyQuery = await buildHierarchyQuery(req.user);
      const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery }).lean();
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
    }

    let schedule = await EmployeeSchedule.findOne({ employeeId })
      .populate("employeeId", "name employeeRole mobile");

    if (!schedule) {
      // Create default schedule if doesn't exist
      schedule = await createDefaultSchedule(targetEmployee);
    }

    return res.json(schedule);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get current user's schedule (for mobile app)
exports.getMySchedule = async (req, res) => {
  try {
    const employee = await resolveEmployeeForUser(req.user);
    if (!employee) {
      return res.status(404).json({ message: "Employee record not found for this user" });
    }

    let schedule = await EmployeeSchedule.findOne({ employeeId: employee._id })
      .populate("employeeId", "name employeeRole mobile");

    if (!schedule) {
      // Create default schedule if doesn't exist
      schedule = await createDefaultSchedule(employee);
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
    const role = String(user?.role || "").toLowerCase();

    if (!mongoose.isObjectIdOrHexString(employeeId)) {
      return res.status(400).json({ message: "A valid employee is required" });
    }
    const validation = validateWeek(req.body.weeklySchedule);
    if (validation) return res.status(400).json({ message: validation });

    const targetEmployee = await Employee.findById(employeeId).lean();
    if (!targetEmployee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    if (SELF_ONLY_ROLES.has(role)) {
      const selfEmployee = await resolveEmployeeForUser(user);
      if (!selfEmployee || selfEmployee._id.toString() !== targetEmployee._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else {
      // Verify employee belongs to user's hierarchy OR is the current user's employee record
      const hierarchyQuery = await buildHierarchyQuery(user);
      const employee = await Employee.findOne({ _id: employeeId, ...hierarchyQuery }).lean();
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
    }

    const cartId = targetEmployee.cartId || targetEmployee.cafeId;
    if (!cartId) return res.status(400).json({ message: "Employee must be assigned to an outlet before saving a schedule" });
    // Accept schedule fields only; ownership and hierarchy come from Employee.
    const update = {
      employeeId, cartId, franchiseId: targetEmployee.franchiseId,
      weeklySchedule: req.body.weeklySchedule.map(({ day, startTime, endTime, isWorking }) =>
        ({ day, startTime, endTime, isWorking })),
    };
    if (req.body.todayState !== undefined) update.todayState = req.body.todayState;

    const schedule = await EmployeeSchedule.findOneAndUpdate(
      { employeeId },
      { $set: update },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
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
    if (err.name === "ValidationError" || err.name === "CastError") {
      return res.status(400).json({ message: "Invalid schedule details" });
    }
    return res.status(500).json({ message: err.message });
  }
};

// Update today's state
exports.updateTodayState = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { todayState } = req.body;
    const user = req.user;

    // Verify employee belongs to user's hierarchy
    const hierarchyQuery = await buildHierarchyQuery(user);
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
        cartId: employee.cartId || employee.cafeId,
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












