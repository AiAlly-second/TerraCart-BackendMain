const mongoose = require('mongoose');

const DailyTaskInstance = require('../models/dailyTaskInstanceModel');
const Employee = require('../models/employeeModel');
const EmployeeSchedule = require('../models/employeeScheduleModel');
const Task = require('../models/taskModel');
const TaskTemplate = require('../models/taskTemplateModel');
const {
  formatISTDateKey,
  getISTDateRange,
  getISTDateRangeFromDateKey,
  getISTDayName,
} = require('../utils/istDateTime');

const STAFF_ROLE_SET = new Set(['waiter', 'cook', 'captain', 'manager', 'employee']);
const LEGACY_PENDING_STATUSES = ['pending', 'in_progress', 'late', 'half_day'];

const normalizeString = (value) => String(value || '').trim().toLowerCase();

const toObjectId = (value) => {
  if (!value) return null;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch (_error) {
    return null;
  }
};

const resolveDateContext = (dateOrKey = new Date()) => {
  if (typeof dateOrKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrKey.trim())) {
    return getISTDateRangeFromDateKey(dateOrKey.trim());
  }
  return getISTDateRange(dateOrKey);
};

const templateMatchesEmployeeRole = (template, employeeRole) => {
  const assignedRole = normalizeString(template?.assignedRole);
  if (!assignedRole || assignedRole === 'all') return true;
  return assignedRole === normalizeString(employeeRole);
};

const templateRunsOnDate = ({ template, dateKey, dayIndex }) => {
  const frequency = normalizeString(template?.frequency || 'daily');
  if (frequency === 'daily') {
    return true;
  }

  if (frequency === 'weekly') {
    const weeklyDays = Array.isArray(template?.weeklyDays)
      ? template.weeklyDays.map((value) => Number(value)).filter((value) => Number.isInteger(value))
      : [];
    if (!weeklyDays.length) {
      return true;
    }
    return weeklyDays.includes(dayIndex);
  }

  if (frequency === 'custom') {
    const customDates = Array.isArray(template?.customDates)
      ? template.customDates.map((value) => String(value).trim())
      : [];
    return customDates.includes(dateKey);
  }

  return true;
};

const employeeIsOffDay = ({ employee, schedule, dayName, dayIndex }) => {
  const weeklyOffDays = Array.isArray(employee?.weeklyOffDays)
    ? employee.weeklyOffDays.map((value) => Number(value)).filter((value) => Number.isInteger(value))
    : [];
  if (weeklyOffDays.includes(dayIndex)) {
    return true;
  }

  if (Array.isArray(schedule?.weeklySchedule)) {
    const daySchedule = schedule.weeklySchedule.find(
      (entry) => normalizeString(entry?.day) === normalizeString(dayName)
    );
    if (daySchedule && daySchedule.isWorking === false) {
      return true;
    }
  }

  return false;
};

const buildTemplateScopeQuery = ({ cartId, franchiseId }) => {
  const query = { active: true };

  if (franchiseId) {
    const franchiseObjectId = toObjectId(franchiseId);
    if (franchiseObjectId) {
      query.$or = [{ franchiseId: franchiseObjectId }, { franchiseId: null }, { franchiseId: { $exists: false } }];
    }
  }

  if (cartId) {
    const cartObjectId = toObjectId(cartId);
    if (cartObjectId) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [{ cartId: cartObjectId }, { cartId: null }, { cartId: { $exists: false } }],
      });
    }
  }

  return query;
};

const generateDailyTasksForDate = async ({
  targetDate = new Date(),
  employeeIds = null,
  cartId = null,
  franchiseId = null,
  generatedBy = null,
  forceRegenerate = false,
} = {}) => {
  const dateContext = resolveDateContext(targetDate);
  if (!dateContext) {
    return {
      dateKey: null,
      generatedCount: 0,
      skippedOffDayCount: 0,
      employeeCount: 0,
      templateCount: 0,
    };
  }

  const { startUTC, dateKey, dayIndex, dayName } = dateContext;

  const employeeQuery = {
    isActive: true,
    employeeRole: { $in: Array.from(STAFF_ROLE_SET) },
  };

  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    employeeQuery._id = {
      $in: employeeIds
        .map((value) => toObjectId(value))
        .filter(Boolean),
    };
  }

  if (cartId) {
    const cartObjectId = toObjectId(cartId);
    if (cartObjectId) {
      employeeQuery.$or = [{ cartId: cartObjectId }, { cafeId: cartObjectId }];
    }
  }

  if (franchiseId) {
    const franchiseObjectId = toObjectId(franchiseId);
    if (franchiseObjectId) {
      employeeQuery.franchiseId = franchiseObjectId;
    }
  }

  const employees = await Employee.find(employeeQuery)
    .select('_id employeeRole cartId cafeId franchiseId weeklyOffDays autoCheckoutEnabled isActive')
    .lean();

  if (!employees.length) {
    return {
      dateKey,
      generatedCount: 0,
      skippedOffDayCount: 0,
      employeeCount: 0,
      templateCount: 0,
    };
  }

  const employeeIdList = employees.map((employee) => employee._id);
  const schedules = await EmployeeSchedule.find({
    employeeId: { $in: employeeIdList },
  })
    .select('employeeId weeklySchedule')
    .lean();

  const scheduleMap = new Map();
  schedules.forEach((schedule) => {
    if (!schedule?.employeeId) return;
    scheduleMap.set(String(schedule.employeeId), schedule);
  });

  const templateScopeQuery = buildTemplateScopeQuery({ cartId, franchiseId });
  const templates = await TaskTemplate.find(templateScopeQuery)
    .select('_id title description assignedRole frequency weeklyDays customDates priority cartId franchiseId active')
    .lean();

  if (!templates.length) {
    return {
      dateKey,
      generatedCount: 0,
      skippedOffDayCount: 0,
      employeeCount: employees.length,
      templateCount: 0,
    };
  }

  const bulkOps = [];
  let skippedOffDayCount = 0;

  for (const employee of employees) {
    const schedule = scheduleMap.get(String(employee._id)) || null;
    const offDay = employeeIsOffDay({ employee, schedule, dayName, dayIndex });
    if (offDay) {
      skippedOffDayCount += 1;
      continue;
    }

    const applicableTemplates = templates.filter((template) => {
      if (!templateMatchesEmployeeRole(template, employee.employeeRole)) {
        return false;
      }
      return templateRunsOnDate({
        template,
        dateKey,
        dayIndex,
      });
    });

    for (const template of applicableTemplates) {
      const baseSet = {
        title: template.title,
        description: template.description || '',
        assignedRole: template.assignedRole || 'all',
        priority: template.priority || 'medium',
        cartId: employee.cartId || employee.cafeId || template.cartId || null,
        franchiseId: employee.franchiseId || template.franchiseId || null,
      };

      if (forceRegenerate) {
        bulkOps.push({
          updateOne: {
            filter: {
              employeeId: employee._id,
              taskTemplateId: template._id,
              dateKey,
            },
            update: {
              $set: {
                ...baseSet,
                date: startUTC,
                generatedBy: generatedBy || null,
              },
              $setOnInsert: {
                status: 'pending',
                completed: false,
                source: 'template',
                autoGenerated: true,
              },
            },
            upsert: true,
          },
        });
        continue;
      }

      bulkOps.push({
        updateOne: {
          filter: {
            employeeId: employee._id,
            taskTemplateId: template._id,
            dateKey,
          },
          update: {
            $setOnInsert: {
              ...baseSet,
              dateKey,
              date: startUTC,
              status: 'pending',
              completed: false,
              source: 'template',
              autoGenerated: true,
              employeeId: employee._id,
              taskTemplateId: template._id,
              generatedBy: generatedBy || null,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (!bulkOps.length) {
    return {
      dateKey,
      generatedCount: 0,
      skippedOffDayCount,
      employeeCount: employees.length,
      templateCount: templates.length,
    };
  }

  const writeResult = await DailyTaskInstance.bulkWrite(bulkOps, {
    ordered: false,
  });

  const generatedCount =
    Number(writeResult?.upsertedCount || 0) + Number(writeResult?.insertedCount || 0);

  return {
    dateKey,
    generatedCount,
    skippedOffDayCount,
    employeeCount: employees.length,
    templateCount: templates.length,
  };
};

const ensureDailyTasksForEmployeeDate = async ({
  employee,
  targetDate = new Date(),
  generatedBy = null,
} = {}) => {
  if (!employee?._id) {
    return {
      dateKey: null,
      generatedCount: 0,
      skippedOffDayCount: 0,
      employeeCount: 0,
      templateCount: 0,
    };
  }

  return generateDailyTasksForDate({
    targetDate,
    employeeIds: [employee._id],
    cartId: employee.cartId || employee.cafeId || null,
    franchiseId: employee.franchiseId || null,
    generatedBy,
  });
};

const getPendingTaskSummaryForEmployeeDate = async ({
  employeeId,
  dateKey = null,
  targetDate = new Date(),
} = {}) => {
  if (!employeeId) {
    return {
      pendingDailyTaskCount: 0,
      pendingLegacyTaskCount: 0,
      totalPendingTaskCount: 0,
      dateKey: null,
    };
  }

  const dateContext = dateKey
    ? resolveDateContext(dateKey)
    : resolveDateContext(targetDate);

  if (!dateContext) {
    return {
      pendingDailyTaskCount: 0,
      pendingLegacyTaskCount: 0,
      totalPendingTaskCount: 0,
      dateKey: null,
    };
  }

  const employeeObjectId = toObjectId(employeeId);
  if (!employeeObjectId) {
    return {
      pendingDailyTaskCount: 0,
      pendingLegacyTaskCount: 0,
      totalPendingTaskCount: 0,
      dateKey: dateContext.dateKey,
    };
  }

  const [pendingDailyTaskCount, pendingLegacyTaskCount] = await Promise.all([
    DailyTaskInstance.countDocuments({
      employeeId: employeeObjectId,
      dateKey: dateContext.dateKey,
      completed: false,
      status: { $ne: 'cancelled' },
    }),
    Task.countDocuments({
      assignedTo: employeeObjectId,
      status: { $in: LEGACY_PENDING_STATUSES },
      $or: [
        {
          dueDate: {
            $gte: dateContext.startUTC,
            $lt: dateContext.endUTC,
          },
        },
        {
          frequency: getISTDayName(dateContext.startUTC),
        },
      ],
    }),
  ]);

  return {
    pendingDailyTaskCount,
    pendingLegacyTaskCount,
    totalPendingTaskCount: pendingDailyTaskCount + pendingLegacyTaskCount,
    dateKey: dateContext.dateKey,
  };
};

const getDailyTaskInstances = async ({
  employeeId = null,
  dateKey = null,
  cartId = null,
  status = null,
} = {}) => {
  const context = resolveDateContext(dateKey || new Date());
  const query = {
    dateKey: context?.dateKey || formatISTDateKey(),
  };

  const employeeObjectId = toObjectId(employeeId);
  if (employeeObjectId) {
    query.employeeId = employeeObjectId;
  }

  const cartObjectId = toObjectId(cartId);
  if (cartObjectId) {
    query.cartId = cartObjectId;
  }

  if (status) {
    query.status = normalizeString(status);
  }

  return DailyTaskInstance.find(query)
    .populate('employeeId', 'name employeeRole cartId franchiseId')
    .populate('taskTemplateId', 'title assignedRole frequency')
    .sort({ priority: -1, createdAt: 1 })
    .lean();
};

module.exports = {
  generateDailyTasksForDate,
  ensureDailyTasksForEmployeeDate,
  getPendingTaskSummaryForEmployeeDate,
  getDailyTaskInstances,
  resolveDateContext,
  employeeIsOffDay,
  templateRunsOnDate,
};
