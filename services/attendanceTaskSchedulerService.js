const mongoose = require('mongoose');
const { attendanceDurations, closeBreakUpdate } = require('../utils/attendanceDuration');
const EmployeeAttendance = require('../models/employeeAttendanceModel');
const Employee = require('../models/employeeModel');
const User = require('../models/userModel');
const {
  generateDailyTasksForDate,
  getPendingTaskSummaryForEmployeeDate,
} = require('./dailyTaskService');
const { sendPushToTokens } = require('./pushNotificationService');
const {
  getDelayToNextISTMidnightMs,
  getISTDateKeyOffset,
  getISTDateRangeFromDateKey,
} = require('../utils/istDateTime');
const {attendanceDayFilter} = require('../utils/businessTime');

let midnightTimer = null;
let schedulerStarted = false;

const toSafeString = (value) => String(value || '').trim();
const toObjectId = (value) => {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
    return null;
  }
  return new mongoose.Types.ObjectId(String(value));
};

const buildAutoCheckoutQuery = (dateKey) => ({
  ...attendanceDayFilter(dateKey),
  'checkIn.time': {$ne: null}, isCheckedOut: {$ne: true},
  autoCheckedOut: {$ne: true}, 'checkOut.time': null,
});

const runAutoCheckoutForDate = async ({ dateKey, range, io, emitToCafe }) => {
  const openAttendances = await EmployeeAttendance.find(buildAutoCheckoutQuery(dateKey, range))
    .select(
      '_id employeeId cartId cafeId checkIn breakDuration breaks breakStart isOnBreak __v attendanceDateIST attendanceStatus checkInStatus status'
    )
    .lean();

  if (!openAttendances.length) {
    return {
      autoCheckedOutCount: 0,
      managerNotificationsSent: 0,
      pendingTaskWarnings: 0,
      dateKey,
    };
  }

  const employeeIds = [...new Set(openAttendances.map((row) => String(row.employeeId)).filter(Boolean))];
  const employees = await Employee.find({ _id: { $in: employeeIds } })
    .select('_id name autoCheckoutEnabled cartId cafeId employeeRole')
    .lean();
  const employeeMap = new Map(employees.map((employee) => [String(employee._id), employee]));

  let autoCheckedOutCount = 0;
  const managerWarningByCart = new Map();

  for (const attendance of openAttendances) {
    const employee = employeeMap.get(String(attendance.employeeId));
    if (!employee || employee.autoCheckoutEnabled === false) {
      continue;
    }

    const checkInTime = attendance?.checkIn?.time ? new Date(attendance.checkIn.time) : null;
    if (!checkInTime || Number.isNaN(checkInTime.getTime())) {
      continue;
    }

    const pendingSummary = await getPendingTaskSummaryForEmployeeDate({
      employeeId: attendance.employeeId,
      dateKey,
    });

    const cartId = attendance.cartId || attendance.cafeId || employee.cartId || employee.cafeId || null;
    const pendingCount = Number(pendingSummary.totalPendingTaskCount || 0);

    let snapshot = attendance;
    let confirmed = null;
    for (let attempt = 0; attempt < 3 && snapshot; attempt++) {
      if (snapshot.isCheckedOut || snapshot.checkOut?.time) break;
      const checkoutTime = new Date();
      const totalWorkingMinutes = Math.floor(attendanceDurations(snapshot, checkoutTime).workingMs / 60000);
      confirmed = await EmployeeAttendance.findOneAndUpdate({
        _id: snapshot._id, __v: snapshot.__v ?? {$exists: false},
        'checkOut.time': null, isCheckedOut: {$ne: true},
      }, {$set: {
        ...closeBreakUpdate(snapshot, checkoutTime), attendanceDateIST: dateKey,
        checkOut: {time: checkoutTime, location: 'AUTO_CHECKOUT_MIDNIGHT', notes: 'Auto checkout at midnight (business timezone scheduler).'},
        totalWorkingMinutes, workingHours: Number((totalWorkingMinutes / 60).toFixed(2)),
        overtime: 0, isOnBreak: false, breakStart: null, attendanceStatus: 'checked_out',
        checkInStatus: 'checked_out', canTakeBreak: false, isCheckedOut: true,
        autoCheckedOut: true, status: 'auto_closed', pendingTasksAtCheckout: pendingCount, managerOverrideUsed: false,
      }, $inc: {__v: 1}}, {new: true}).lean();
      if (confirmed) break;
      snapshot = await EmployeeAttendance.findById(attendance._id).lean();
    }
    if (!confirmed) continue;
    autoCheckedOutCount++;

    if (pendingCount > 0) {
      const cartKey = toSafeString(cartId);
      if (cartKey) {
        const existing = managerWarningByCart.get(cartKey) || [];
        existing.push({
          employeeName: employee.name || 'Employee',
          employeeId: String(employee._id),
          pendingCount,
          attendanceId: String(attendance._id),
        });
        managerWarningByCart.set(cartKey, existing);
      }
    }

    if (io && emitToCafe && cartId) {
      emitToCafe(io, String(cartId), 'attendance:checked_out', confirmed);
      emitToCafe(io, String(cartId), 'attendance:updated', confirmed);
    }
  }

  let managerNotificationsSent = 0;
  let pendingTaskWarnings = 0;

  for (const [cartId, warnings] of managerWarningByCart.entries()) {
    if (!warnings.length) continue;

    const cartObjectId = toObjectId(cartId);
    const cartMatchValue = cartObjectId || cartId;
    const managerUsers = await User.find({
      role: { $in: ['manager', 'admin'] },
      $or: [{ cartId: cartMatchValue }, { cafeId: cartMatchValue }, { _id: cartMatchValue }],
    })
      .select('_id fcmToken role')
      .lean();

    const managerTokens = managerUsers
      .map((user) => String(user.fcmToken || '').trim())
      .filter(Boolean);

    if (!managerTokens.length) {
      continue;
    }

    const headline = warnings[0];
    const body =
      warnings.length === 1
        ? `${headline.employeeName} auto checked-out with ${headline.pendingCount} pending tasks.`
        : `${warnings.length} employees auto checked-out with pending tasks.`;

    const pushResult = await sendPushToTokens(managerTokens, {
      title: 'Auto Checkout Alert',
      body,
      data: {
        notificationType: 'attendance_auto_checkout',
        dateKey,
        cartId,
        affectedEmployees: JSON.stringify(warnings),
      },
    });

    managerNotificationsSent += Number(pushResult.successCount || 0);
    pendingTaskWarnings += warnings.length;
  }

  return {
    autoCheckedOutCount,
    managerNotificationsSent,
    pendingTaskWarnings,
    dateKey,
  };
};

const runMidnightAttendanceAndTaskJobs = async ({ io, emitToCafe } = {}) => {
  const previousDateKey = getISTDateKeyOffset(-1);
  const previousDateRange = getISTDateRangeFromDateKey(previousDateKey);

  const autoCheckoutSummary = previousDateRange
    ? await runAutoCheckoutForDate({
        dateKey: previousDateKey,
        range: previousDateRange,
        io,
        emitToCafe,
      })
    : {
        autoCheckedOutCount: 0,
        managerNotificationsSent: 0,
        pendingTaskWarnings: 0,
        dateKey: previousDateKey,
      };

  const generationSummary = await generateDailyTasksForDate({
    targetDate: new Date(),
    generatedBy: null,
  });

  return {
    autoCheckoutSummary,
    generationSummary,
  };
};

const scheduleNextMidnightRun = ({ io, emitToCafe }) => {
  if (!schedulerStarted) return;
  if (midnightTimer) {
    clearTimeout(midnightTimer);
  }

  const delayMs = getDelayToNextISTMidnightMs();
  midnightTimer = setTimeout(async () => {
    try {
      await runMidnightAttendanceAndTaskJobs({ io, emitToCafe });
    } catch (error) {
      console.error('[ATTENDANCE_TASK_SCHEDULER] Midnight job failed:', error.message);
    } finally {
      if (schedulerStarted) scheduleNextMidnightRun({ io, emitToCafe });
    }
  }, delayMs);
  midnightTimer.unref?.();
};

const startAttendanceTaskSchedulers = ({ io, emitToCafe } = {}) => {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  // Self-heal on restart: ensure today's tasks exist even if process restarted during day.
  generateDailyTasksForDate({
    targetDate: new Date(),
    generatedBy: null,
  }).catch((error) => {
    console.error('[ATTENDANCE_TASK_SCHEDULER] Startup task generation failed:', error.message);
  });

  scheduleNextMidnightRun({ io, emitToCafe });
};

const stopAttendanceTaskSchedulers = () => {
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
  schedulerStarted = false;
};

module.exports = {
  startAttendanceTaskSchedulers,
  stopAttendanceTaskSchedulers,
  runMidnightAttendanceAndTaskJobs,
  runAutoCheckoutForDate,
};
