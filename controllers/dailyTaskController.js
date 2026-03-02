const mongoose = require('mongoose');

const DailyTaskInstance = require('../models/dailyTaskInstanceModel');
const Employee = require('../models/employeeModel');
const EmployeeAttendance = require('../models/employeeAttendanceModel');
const TaskTemplate = require('../models/taskTemplateModel');
const {
  ensureDailyTasksForEmployeeDate,
  generateDailyTasksForDate,
  getDailyTaskInstances,
  resolveDateContext,
} = require('../services/dailyTaskService');

const MANAGER_LEVEL_ROLES = new Set(['manager', 'admin', 'franchise_admin', 'super_admin']);
const STAFF_ROLES = new Set(['waiter', 'cook', 'captain', 'manager', 'employee']);

const normalizeString = (value) => String(value || '').trim();
const normalizeRole = (value) => normalizeString(value).toLowerCase();

const toObjectId = (value) => {
  if (!value) return null;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch (_error) {
    return null;
  }
};

const isValidFrequencyConfig = (frequency, weeklyDays, customDates) => {
  if (frequency === 'weekly') {
    return Array.isArray(weeklyDays) && weeklyDays.length > 0;
  }
  if (frequency === 'custom') {
    return (
      Array.isArray(customDates) &&
      customDates.length > 0 &&
      customDates.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()))
    );
  }
  return true;
};

const getEmployeeFromUser = async (user) => {
  if (!user) return null;

  if (user.employeeId) {
    const byLinkedId = await Employee.findById(user.employeeId).lean();
    if (byLinkedId) return byLinkedId;
  }

  const byUserId = await Employee.findOne({ userId: user._id }).lean();
  if (byUserId) return byUserId;

  if (!user.email) return null;
  return Employee.findOne({ email: user.email.toLowerCase() }).lean();
};

const resolveScope = async (user, providedCartId = null) => {
  const role = normalizeRole(user?.role);

  if (role === 'super_admin') {
    return {
      cartId: providedCartId ? toObjectId(providedCartId) : null,
      franchiseId: null,
      role,
      employee: null,
    };
  }

  if (role === 'franchise_admin') {
    const franchiseId = toObjectId(user?._id);
    const cartId = providedCartId ? toObjectId(providedCartId) : null;
    return { cartId, franchiseId, role, employee: null };
  }

  if (role === 'admin' || role === 'cart_admin') {
    const cartId = toObjectId(user?._id) || toObjectId(user?.cartId || user?.cafeId);
    const franchiseId = toObjectId(user?.franchiseId);
    return { cartId, franchiseId, role, employee: null };
  }

  const employee = await getEmployeeFromUser(user);
  if (!employee) {
    return {
      cartId: null,
      franchiseId: null,
      role,
      employee: null,
    };
  }

  return {
    cartId: toObjectId(employee.cartId || employee.cafeId || user?.cartId || user?.cafeId),
    franchiseId: toObjectId(employee.franchiseId || user?.franchiseId),
    role,
    employee,
  };
};

const getTaskTemplates = async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '').toLowerCase() === 'true';
    const scope = await resolveScope(req.user, req.query.cartId);

    if (!scope.cartId && !scope.franchiseId && scope.role !== 'super_admin') {
      return res.status(400).json({ message: 'Unable to resolve cart scope.' });
    }

    const query = {};
    if (!includeInactive) {
      query.active = true;
    }

    if (scope.cartId) {
      query.$or = [
        { cartId: scope.cartId },
        { cartId: null },
        { cartId: { $exists: false } },
      ];
    }

    if (scope.franchiseId) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { franchiseId: scope.franchiseId },
          { franchiseId: null },
          { franchiseId: { $exists: false } },
        ],
      });
    }

    const templates = await TaskTemplate.find(query)
      .sort({ active: -1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      count: templates.length,
      data: templates,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch task templates.',
    });
  }
};

const createTaskTemplate = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can create task templates.' });
    }

    const {
      title,
      description,
      assignedRole,
      frequency = 'daily',
      weeklyDays = [],
      customDates = [],
      priority = 'medium',
      active = true,
    } = req.body || {};

    if (!normalizeString(title)) {
      return res.status(400).json({ message: 'title is required.' });
    }

    const normalizedFrequency = normalizeRole(frequency);
    if (!['daily', 'weekly', 'custom'].includes(normalizedFrequency)) {
      return res.status(400).json({ message: 'Invalid frequency. Use daily, weekly, or custom.' });
    }

    if (!isValidFrequencyConfig(normalizedFrequency, weeklyDays, customDates)) {
      return res.status(400).json({
        message:
          normalizedFrequency === 'weekly'
            ? 'weeklyDays is required for weekly frequency.'
            : 'customDates is required for custom frequency.',
      });
    }

    const scope = await resolveScope(req.user, req.body?.cartId);

    const template = await TaskTemplate.create({
      title: normalizeString(title),
      description: normalizeString(description),
      assignedRole: normalizeRole(assignedRole) || 'all',
      frequency: normalizedFrequency,
      weeklyDays: Array.isArray(weeklyDays)
        ? weeklyDays.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
        : [],
      customDates: Array.isArray(customDates)
        ? customDates.map((value) => String(value).trim()).filter(Boolean)
        : [],
      priority: normalizeRole(priority) || 'medium',
      active: Boolean(active),
      cartId: scope.cartId || null,
      franchiseId: scope.franchiseId || null,
      createdBy: req.user?._id || null,
      updatedBy: req.user?._id || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Task template created successfully.',
      data: template,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create task template.',
    });
  }
};

const updateTaskTemplate = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can update task templates.' });
    }

    const templateId = toObjectId(req.params.id);
    if (!templateId) {
      return res.status(400).json({ message: 'Invalid template id.' });
    }

    const template = await TaskTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found.' });
    }

    const scope = await resolveScope(req.user, req.body?.cartId);

    if (
      scope.cartId &&
      template.cartId &&
      String(template.cartId) !== String(scope.cartId) &&
      role !== 'super_admin'
    ) {
      return res.status(403).json({ message: 'Access denied for this template.' });
    }

    const updates = req.body || {};

    if (updates.title !== undefined) {
      template.title = normalizeString(updates.title);
    }
    if (updates.description !== undefined) {
      template.description = normalizeString(updates.description);
    }
    if (updates.assignedRole !== undefined) {
      template.assignedRole = normalizeRole(updates.assignedRole) || 'all';
    }
    if (updates.frequency !== undefined) {
      const normalizedFrequency = normalizeRole(updates.frequency);
      if (!['daily', 'weekly', 'custom'].includes(normalizedFrequency)) {
        return res.status(400).json({ message: 'Invalid frequency value.' });
      }
      template.frequency = normalizedFrequency;
    }
    if (updates.weeklyDays !== undefined) {
      template.weeklyDays = Array.isArray(updates.weeklyDays)
        ? updates.weeklyDays
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
        : [];
    }
    if (updates.customDates !== undefined) {
      template.customDates = Array.isArray(updates.customDates)
        ? updates.customDates
            .map((value) => String(value).trim())
            .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
        : [];
    }
    if (updates.priority !== undefined) {
      template.priority = normalizeRole(updates.priority) || 'medium';
    }
    if (updates.active !== undefined) {
      template.active = Boolean(updates.active);
    }

    if (!isValidFrequencyConfig(template.frequency, template.weeklyDays, template.customDates)) {
      return res.status(400).json({
        message:
          template.frequency === 'weekly'
            ? 'weeklyDays is required for weekly frequency.'
            : 'customDates is required for custom frequency.',
      });
    }

    template.updatedBy = req.user?._id || null;
    await template.save();

    return res.json({
      success: true,
      message: 'Task template updated successfully.',
      data: template,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update task template.',
    });
  }
};

const deleteTaskTemplate = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can delete task templates.' });
    }

    const templateId = toObjectId(req.params.id);
    if (!templateId) {
      return res.status(400).json({ message: 'Invalid template id.' });
    }

    const template = await TaskTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json({ message: 'Task template not found.' });
    }

    const scope = await resolveScope(req.user);
    if (
      scope.cartId &&
      template.cartId &&
      String(template.cartId) !== String(scope.cartId) &&
      role !== 'super_admin'
    ) {
      return res.status(403).json({ message: 'Access denied for this template.' });
    }

    template.active = false;
    template.updatedBy = req.user?._id || null;
    await template.save();

    return res.json({
      success: true,
      message: 'Task template deactivated successfully.',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete task template.',
    });
  }
};

const triggerDailyTaskGeneration = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can trigger generation.' });
    }

    const targetDate = normalizeString(req.body?.date) || new Date();
    const scope = await resolveScope(req.user, req.body?.cartId || req.query?.cartId);

    const result = await generateDailyTasksForDate({
      targetDate,
      cartId: scope.cartId,
      franchiseId: scope.franchiseId,
      generatedBy: req.user?._id || null,
      forceRegenerate: String(req.body?.forceRegenerate || '').toLowerCase() === 'true',
    });

    return res.json({
      success: true,
      message: 'Daily task generation completed.',
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate daily tasks.',
    });
  }
};

const getDailyTasks = async (req, res) => {
  try {
    const scope = await resolveScope(req.user, req.query?.cartId);
    const role = normalizeRole(req.user?.role);

    let employeeId = req.query?.employeeId;
    if (STAFF_ROLES.has(role) && role !== 'manager') {
      employeeId = scope.employee?._id || req.user?.employeeId;
    }

    const tasks = await getDailyTaskInstances({
      employeeId,
      dateKey: req.query?.date || null,
      cartId: scope.cartId,
      status: req.query?.status || null,
    });

    return res.json({
      success: true,
      count: tasks.length,
      data: tasks,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch daily tasks.',
    });
  }
};

const createManualDailyTask = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can assign tasks.' });
    }

    const { employeeId, title, description = '', priority = 'medium', date } = req.body || {};

    if (!employeeId || !mongoose.Types.ObjectId.isValid(String(employeeId))) {
      return res.status(400).json({ message: 'Valid employeeId is required.' });
    }
    if (!normalizeString(title)) {
      return res.status(400).json({ message: 'title is required.' });
    }

    const employee = await Employee.findById(employeeId).lean();
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found.' });
    }

    const scope = await resolveScope(req.user, req.body?.cartId);
    const employeeCartId = toObjectId(employee.cartId || employee.cafeId);
    if (
      scope.cartId &&
      employeeCartId &&
      String(scope.cartId) !== String(employeeCartId) &&
      role !== 'super_admin'
    ) {
      return res.status(403).json({ message: 'Employee is outside your cart scope.' });
    }
    if (
      scope.franchiseId &&
      employee.franchiseId &&
      String(scope.franchiseId) !== String(employee.franchiseId) &&
      role !== 'super_admin'
    ) {
      return res.status(403).json({ message: 'Employee is outside your franchise scope.' });
    }

    const dateContext = resolveDateContext(date || new Date());
    if (!dateContext) {
      return res.status(400).json({ message: 'Invalid task date.' });
    }

    const taskInstance = await DailyTaskInstance.create({
      employeeId: employee._id,
      taskTemplateId: null,
      dateKey: dateContext.dateKey,
      date: dateContext.startUTC,
      title: normalizeString(title),
      description: normalizeString(description),
      assignedRole: normalizeRole(employee.employeeRole) || 'employee',
      priority: normalizeRole(priority) || 'medium',
      status: 'pending',
      completed: false,
      autoGenerated: false,
      source: 'manual',
      cartId: employee.cartId || employee.cafeId || null,
      franchiseId: employee.franchiseId || null,
      generatedBy: req.user?._id || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Manual daily task assigned successfully.',
      data: taskInstance,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create manual daily task.',
    });
  }
};

const completeDailyTask = async (req, res) => {
  try {
    const taskId = toObjectId(req.params.id);
    if (!taskId) {
      return res.status(400).json({ message: 'Invalid task id.' });
    }

    const task = await DailyTaskInstance.findById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Daily task not found.' });
    }

    const role = normalizeRole(req.user?.role);
    const scope = await resolveScope(req.user);

    const isOwner = scope.employee?._id && String(scope.employee._id) === String(task.employeeId);
    const canOverride = MANAGER_LEVEL_ROLES.has(role);

    if (!isOwner && !canOverride) {
      return res.status(403).json({ message: 'Access denied for this task.' });
    }

    task.completed = true;
    task.status = 'completed';
    task.completedAt = new Date();
    task.completedByUserId = req.user?._id || null;
    await task.save();

    return res.json({
      success: true,
      message: 'Daily task marked as completed.',
      data: task,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to complete daily task.',
    });
  }
};

const getManagerOverview = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!MANAGER_LEVEL_ROLES.has(role)) {
      return res.status(403).json({ message: 'Only managers/admins can access overview.' });
    }

    const dateContext = resolveDateContext(req.query?.date || new Date());
    if (!dateContext) {
      return res.status(400).json({ message: 'Invalid date filter.' });
    }

    const scope = await resolveScope(req.user, req.query?.cartId);
    if (!scope.cartId && role !== 'super_admin' && !scope.franchiseId) {
      return res.status(400).json({ message: 'Unable to resolve cart/franchise scope.' });
    }

    const employeeQuery = {
      isActive: true,
      employeeRole: { $in: Array.from(STAFF_ROLES) },
    };

    if (scope.cartId) {
      employeeQuery.$or = [{ cartId: scope.cartId }, { cafeId: scope.cartId }];
    }

    if (scope.franchiseId) {
      employeeQuery.franchiseId = scope.franchiseId;
    }

    const employees = await Employee.find(employeeQuery)
      .select('_id name employeeRole cartId franchiseId')
      .sort({ name: 1 })
      .lean();

    if (!employees.length) {
      return res.json({ success: true, count: 0, data: [] });
    }

    const employeeIds = employees.map((employee) => employee._id);

    const [attendanceRows, taskRows] = await Promise.all([
      EmployeeAttendance.find({
        employeeId: { $in: employeeIds },
        date: { $gte: dateContext.startUTC, $lt: dateContext.endUTC },
      })
        .select(
          'employeeId checkIn checkOut attendanceStatus checkInStatus status isCheckedOut autoCheckedOut pendingTasksAtCheckout'
        )
        .lean(),
      DailyTaskInstance.find({
        employeeId: { $in: employeeIds },
        dateKey: dateContext.dateKey,
      })
        .select('employeeId completed status')
        .lean(),
    ]);

    const attendanceMap = new Map();
    attendanceRows.forEach((row) => {
      if (!row?.employeeId) return;
      attendanceMap.set(String(row.employeeId), row);
    });

    const taskSummaryMap = new Map();
    taskRows.forEach((task) => {
      if (!task?.employeeId) return;
      const employeeKey = String(task.employeeId);
      const existing = taskSummaryMap.get(employeeKey) || {
        total: 0,
        completed: 0,
        pending: 0,
      };
      existing.total += 1;
      if (task.completed || String(task.status).toLowerCase() === 'completed') {
        existing.completed += 1;
      } else if (String(task.status).toLowerCase() !== 'cancelled') {
        existing.pending += 1;
      }
      taskSummaryMap.set(employeeKey, existing);
    });

    const rows = employees.map((employee) => {
      const attendance = attendanceMap.get(String(employee._id)) || null;
      const taskSummary = taskSummaryMap.get(String(employee._id)) || {
        total: 0,
        completed: 0,
        pending: 0,
      };

      const checkInTime = attendance?.checkIn?.time || null;
      const checkOutTime = attendance?.checkOut?.time || null;
      const status =
        attendance?.attendanceStatus || attendance?.checkInStatus || attendance?.status || 'not_checked_in';

      return {
        employeeId: employee._id,
        name: employee.name,
        role: employee.employeeRole,
        checkInTime,
        checkOutTime,
        tasksCompleted: taskSummary.completed,
        pendingTasks: taskSummary.pending,
        totalTasks: taskSummary.total,
        status,
        autoCheckedOut: Boolean(attendance?.autoCheckedOut),
      };
    });

    return res.json({
      success: true,
      dateKey: dateContext.dateKey,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load manager overview.',
    });
  }
};

module.exports = {
  getTaskTemplates,
  createTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
  triggerDailyTaskGeneration,
  getDailyTasks,
  createManualDailyTask,
  completeDailyTask,
  getManagerOverview,
};
