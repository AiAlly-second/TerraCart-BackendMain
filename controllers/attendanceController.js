const EmployeeAttendance = require("../models/employeeAttendanceModel");
const Employee = require("../models/employeeModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");
const LeaveRequest = require("../models/leaveRequestModel");
const User = require("../models/userModel");
const {
  ensureDailyTasksForEmployeeDate,
  getPendingTaskSummaryForEmployeeDate,
} = require("../services/dailyTaskService");
const { sendPushToTokens } = require("../services/pushNotificationService");

// IST offset constant (UTC+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
const ATTENDANCE_IDEMPOTENCY_WINDOW_MS = 5 * 1000;
const ATTENDANCE_REQUEST_CACHE_TTL_MS = 60 * 1000;
const recentAttendanceRequestMap = new Map();

// Helper function to get current IST time
const getISTNow = () => {
  const now = new Date(); // Current UTC time
  return new Date(now.getTime() + IST_OFFSET_MS); // Convert to IST
};

// Helper function to convert IST time to UTC for MongoDB storage
const istToUTC = (istDate) => {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
};

// Helper function to convert UTC time to IST
const utcToIST = (utcDate) => {
  return new Date(utcDate.getTime() + IST_OFFSET_MS);
};

// Helper function to get IST date (start of day in IST, converted to UTC for MongoDB storage)
const getISTDate = () => {
  const istNow = getISTNow();
  // Get start of day in IST
  const istDate = new Date(istNow);
  istDate.setHours(0, 0, 0, 0); // Set to start of day in IST
  
  // Convert to UTC for MongoDB storage
  return istToUTC(istDate);
};

// IST day key for "today" lookups and unique constraint: YYYY-MM-DD
const getISTDateString = () => {
  const istNow = getISTNow();
  const y = istNow.getFullYear();
  const m = String(istNow.getMonth() + 1).padStart(2, "0");
  const d = String(istNow.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// Helper function to get IST date range (today start and tomorrow start in UTC for MongoDB)
const getISTDateRange = () => {
  const today = getISTDate();
  const tomorrow = new Date(today);
  tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
};

// Helper function to get day name in IST
const getISTDayName = () => {
  const istNow = getISTNow();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return dayNames[istNow.getDay()]; // Use getDay() for IST day
};

const getTodaySchedule = (schedule, dayName) => {
  if (!schedule || !Array.isArray(schedule.weeklySchedule)) return null;
  return schedule.weeklySchedule.find((entry) => entry.day === dayName) || null;
};

const normalizeBreaks = (attendance) => {
  if (!Array.isArray(attendance?.breaks)) return [];
  return attendance.breaks.map((entry) => ({
    breakStart: entry?.breakStart || null,
    breakEnd: entry?.breakEnd || null,
    durationMinutes: Number(entry?.durationMinutes || 0),
  }));
};

const inferAttendanceStatus = (attendance) => {
  if (attendance?.isCheckedOut || attendance?.checkOut?.time) return "checked_out";
  if (attendance?.isOnBreak || attendance?.breakStart) return "on_break";
  if (attendance?.checkIn?.time) return "checked_in";
  if (attendance?.status === "absent") return "absent";
  return "not_checked_in";
};

const inferCheckInStatus = (attendanceStatus) => {
  if (attendanceStatus === "checked_in" || attendanceStatus === "on_break") {
    return "checked_in";
  }
  if (attendanceStatus === "checked_out") return "checked_out";
  if (attendanceStatus === "absent") return "absent";
  return "not_checked_in";
};

const normalizeAttendanceRecord = (record) => {
  const plainRecord = record?.toObject ? record.toObject() : { ...record };
  const attendanceStatus = plainRecord.attendanceStatus || inferAttendanceStatus(plainRecord);
  const checkInStatus = plainRecord.checkInStatus || inferCheckInStatus(attendanceStatus);
  const isCheckedOut = Boolean(
    plainRecord.isCheckedOut ||
    attendanceStatus === "checked_out" ||
    plainRecord.checkOut?.time
  );
  const breaks = normalizeBreaks(plainRecord);
  const totalBreakMinutes = Number(
    plainRecord.breakDuration ??
    plainRecord.breakMinutes ??
    breaks.reduce((sum, entry) => sum + Number(entry.durationMinutes || 0), 0)
  );

  return {
    ...plainRecord,
    attendanceStatus,
    checkInStatus,
    canTakeBreak: plainRecord.canTakeBreak ?? (attendanceStatus === "checked_in" || attendanceStatus === "on_break"),
    isCheckedOut,
    breakDuration: totalBreakMinutes,
    breakMinutes: totalBreakMinutes,
    breaks,
    checkInTime: plainRecord.checkIn?.time || null,
    checkOutTime: plainRecord.checkOut?.time || null,
  };
};

const getRecordEmployeeId = (record) => {
  const employee = record?.employeeId;
  if (!employee) return null;
  if (typeof employee === "string") return employee;
  if (typeof employee === "object") {
    return (employee._id || employee.id || employee.toString())?.toString() || null;
  }
  return null;
};

const getAttendancePriority = (record) => {
  const status = normalizeAttendanceRecord(record)?.attendanceStatus;
  switch (status) {
    case "checked_out":
      return 4;
    case "on_break":
      return 3;
    case "checked_in":
      return 2;
    case "absent":
      return 1;
    default:
      return 0;
  }
};

const pickPreferredAttendanceRecord = (current, candidate) => {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentPriority = getAttendancePriority(current);
  const candidatePriority = getAttendancePriority(candidate);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }

  const currentTime = new Date(
    current.updatedAt ||
      current.checkOut?.time ||
      current.checkIn?.time ||
      current.createdAt ||
      current.date ||
      0
  ).getTime();
  const candidateTime = new Date(
    candidate.updatedAt ||
      candidate.checkOut?.time ||
      candidate.checkIn?.time ||
      candidate.createdAt ||
      candidate.date ||
      0
  ).getTime();

  return candidateTime >= currentTime ? candidate : current;
};

const dedupeAttendanceByEmployee = (records = []) => {
  const map = new Map();
  for (const record of records) {
    const employeeId = getRecordEmployeeId(record);
    if (!employeeId) continue;
    const existing = map.get(employeeId);
    map.set(employeeId, pickPreferredAttendanceRecord(existing, record));
  }
  return Array.from(map.values());
};

const getApprovedLeaveMapForDate = async ({ employeeIds = [], date }) => {
  const normalizedEmployeeIds = employeeIds
    .map((id) => id?.toString?.() || id)
    .filter(Boolean);
  if (!normalizedEmployeeIds.length || !date) {
    return new Map();
  }

  const approvedLeaves = await LeaveRequest.find({
    employeeId: { $in: normalizedEmployeeIds },
    status: "approved",
    startDate: { $lte: date },
    endDate: { $gte: date },
  })
    .select("employeeId")
    .lean();

  const leaveMap = new Map();
  approvedLeaves.forEach((row) => {
    const employeeId =
      row?.employeeId?.toString?.() || row?.employeeId || null;
    if (employeeId) {
      leaveMap.set(employeeId.toString(), true);
    }
  });

  return leaveMap;
};

const hasApprovedLeaveForToday = async (employeeId, today) => {
  if (!employeeId || !today) return false;
  const existing = await LeaveRequest.findOne({
    employeeId,
    status: "approved",
    startDate: { $lte: today },
    endDate: { $gte: today },
  })
    .select("_id")
    .lean();
  return Boolean(existing);
};

const parseRequestTimestampMs = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? null : ts;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
  }

  const asString = String(value).trim();
  if (!asString) return null;

  if (/^\d+$/.test(asString)) {
    const numeric = Number(asString);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    }
  }

  const parsed = new Date(asString);
  const ts = parsed.getTime();
  return Number.isNaN(ts) ? null : ts;
};

const getAttendanceRequestMeta = (req) => {
  const requestTimestampRaw =
    req.body?.requestTimestamp ??
    req.headers["x-request-timestamp"] ??
    req.headers["x-request-time"] ??
    null;
  const requestTimestampMs = parseRequestTimestampMs(requestTimestampRaw);
  const rawDeviceId =
    req.body?.deviceId ??
    req.headers["x-device-id"] ??
    req.headers["x-deviceid"] ??
    "unknown";
  const deviceId = String(rawDeviceId || "unknown").trim() || "unknown";

  return {
    deviceId,
    requestTimestampRaw,
    requestTimestampMs,
  };
};

const purgeExpiredAttendanceRequestCache = (nowMs = Date.now()) => {
  for (const [key, value] of recentAttendanceRequestMap.entries()) {
    if (!value || nowMs - value.receivedAtMs > ATTENDANCE_REQUEST_CACHE_TTL_MS) {
      recentAttendanceRequestMap.delete(key);
    }
  }
};

const isDuplicateAttendanceRequest = ({
  action,
  employeeId,
  userId,
  deviceId,
  requestTimestampMs,
}) => {
  if (!requestTimestampMs || !employeeId) {
    return false;
  }

  const nowMs = Date.now();
  purgeExpiredAttendanceRequestCache(nowMs);

  const key = [
    action,
    employeeId.toString(),
    userId?.toString() || "anonymous",
    deviceId || "unknown",
  ].join(":");

  const previous = recentAttendanceRequestMap.get(key);
  if (
    previous &&
    Math.abs(previous.requestTimestampMs - requestTimestampMs) <=
      ATTENDANCE_IDEMPOTENCY_WINDOW_MS &&
    nowMs - previous.receivedAtMs <= ATTENDANCE_IDEMPOTENCY_WINDOW_MS
  ) {
    return true;
  }

  recentAttendanceRequestMap.set(key, {
    requestTimestampMs,
    receivedAtMs: nowMs,
  });

  return false;
};

const buildCartMatchClause = (cartId) => {
  if (!cartId) return null;
  return {
    $or: [{ cartId }, { cartId: null }, { cartId: { $exists: false } }],
  };
};

const buildActiveSessionQuery = ({ employeeId, today, tomorrow, cartId }) => {
  const query = {
    employeeId,
    "checkIn.time": { $ne: null },
    isCheckedOut: { $ne: true },
    $and: [{ $or: [{ "checkOut.time": null }, { "checkOut.time": { $exists: false } }] }],
  };

  if (today && tomorrow) {
    query.date = { $gte: today, $lt: tomorrow };
  }

  const cartClause = buildCartMatchClause(cartId);
  if (cartClause) {
    query.$and.push(cartClause);
  }

  return query;
};

const logAttendanceEvent = ({
  action,
  outcome,
  employeeId,
  attendanceId = null,
  userId = null,
  role = null,
  deviceId = "unknown",
  requestTimestampMs = null,
  message = "",
}) => {
  const payload = {
    action,
    outcome,
    employeeId: employeeId ? employeeId.toString() : null,
    attendanceId: attendanceId ? attendanceId.toString() : null,
    userId: userId ? userId.toString() : null,
    role: role || null,
    deviceId: deviceId || "unknown",
    requestTimestamp: requestTimestampMs ? new Date(requestTimestampMs).toISOString() : null,
    timestamp: new Date().toISOString(),
    message,
  };

  console.log(`[ATTENDANCE_EVENT] ${JSON.stringify(payload)}`);
};

const notifyEmployeePendingCheckoutTasks = async ({
  employeeId,
  pendingTaskCount,
  dateKey,
}) => {
  try {
    const employee = await Employee.findById(employeeId)
      .select("_id userId email")
      .lean();
    if (!employee) return;

    const userFilters = [];
    if (employee.userId) {
      userFilters.push({ _id: employee.userId });
    }
    userFilters.push({ employeeId: employee._id });
    if (employee.email) {
      userFilters.push({ email: employee.email.toLowerCase() });
    }

    const users = await User.find({ $or: userFilters })
      .select("_id fcmToken")
      .lean();
    const tokens = users
      .map((user) => String(user.fcmToken || "").trim())
      .filter(Boolean);

    if (!tokens.length) return;

    await sendPushToTokens(tokens, {
      title: "Checkout Blocked",
      body: `Complete ${pendingTaskCount} pending task(s) before checkout.`,
      data: {
        notificationType: "attendance_checkout_blocked",
        pendingTasks: String(pendingTaskCount),
        dateKey: String(dateKey || ""),
      },
    });
  } catch (_error) {
    // Non-blocking notification side effect.
  }
};

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user.role === "admin") {
    // Support both cartId (new) and cafeId (old) during migration
    query.$or = [
      { cartId: user._id },
      { cafeId: user._id }
    ];
  } else if (user.role === "franchise_admin") {
    query.franchiseId = user._id;
  } else if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
    // Mobile users (waiter, cook, captain, manager) - only show their own attendance
    // Get their employee record to find cartId and employeeId
    let employee = await Employee.findOne({ userId: user._id }).lean();
    if (!employee && user.email) {
      // Fallback: find by email
      employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
    }
    if (employee) {
      // Support both cartId (new) and cafeId (old) during migration.
      // Include null/missing cartId so legacy attendance records still show for this employee.
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId },
        { cartId: null },
        { cartId: { $exists: false } }
      ];
      // For individual mobile users, only show their own attendance
      query.employeeId = employee._id;
    } else {
      // If no employee record found, use a query that will return no results
      query.employeeId = { $exists: false }; // This will ensure no results are returned
    }
  } else if (user.role === "employee") {
    // Legacy employee role - look up Employee
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (employee) {
      // Support both cartId (new) and cafeId (old) during migration
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId }
      ];
      query.employeeId = employee._id;
    } else {
      // If no employee record found, use a query that will return no results
      query.employeeId = { $exists: false }; // This will ensure no results are returned
    }
  } else {
    // For any other role, ensure they can only see their own attendance if they have an employee record
    // Otherwise, return no results
    const employee = await Employee.findOne({ userId: user._id }).lean();
    if (!employee && user.email) {
      const employeeByEmail = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (employeeByEmail) {
        // Support both cartId (new) and cafeId (old) during migration
        query.$or = [
          { cartId: employeeByEmail.cartId },
          { cafeId: employeeByEmail.cartId }
        ];
        query.employeeId = employeeByEmail._id;
      } else {
        query.employeeId = { $exists: false }; // No employee record found, return no results
      }
    } else if (employee) {
      // Support both cartId (new) and cafeId (old) during migration
      query.$or = [
        { cartId: employee.cartId },
        { cafeId: employee.cartId }
      ];
      query.employeeId = employee._id;
    } else {
      query.employeeId = { $exists: false }; // No employee record found, return no results
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

    if (req.query.cartId) {
      const cartFilter = { $or: [{ cartId: req.query.cartId }, { cafeId: req.query.cartId }] };
      if (query.$or) {
        query.$and = [{ $or: query.$or }, cartFilter];
        delete query.$or;
      } else {
        Object.assign(query, cartFilter);
      }
    }

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    // Check if querying for today's attendance
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();
    const now = new Date();

    // If querying today's attendance, mark absent employees
    const isQueryingToday = (!startDate && !endDate) || 
      (startDate && new Date(startDate) <= today && (!endDate || new Date(endDate) >= today));

    if (isQueryingToday && !employeeId) {
      // Get all employees in the hierarchy
      const employeeQuery = await buildHierarchyQuery(req.user);
      const employees = await Employee.find(employeeQuery)
        .select("_id name employeeRole cafeId franchiseId")
        .lean();
      const employeeIds = employees.map((emp) => emp._id);
      const approvedLeaveMap = await getApprovedLeaveMapForDate({
        employeeIds,
        date: today,
      });

      // Get existing attendance for today
      const todayQuery = {
        ...query,
        date: { $gte: today, $lt: tomorrow },
      };
      const existingAttendance = await EmployeeAttendance.find(todayQuery)
        .select("employeeId")
        .lean();
      const attendanceEmployeeIds = new Set(
        existingAttendance.map((a) => a.employeeId?.toString() || a.employeeId?._id?.toString())
      );

      // Get day name for today in IST
      const todayDay = getISTDayName();

      // Mark absent for employees who haven't checked in on working days
      for (const employee of employees) {
        const empId = employee._id.toString();
        
        if (attendanceEmployeeIds.has(empId)) {
          continue;
        }

        const schedule = await EmployeeSchedule.findOne({ employeeId: employee._id }).lean();
        const hasApprovedLeaveToday = approvedLeaveMap.get(empId) === true;

        if (hasApprovedLeaveToday) {
          try {
            await EmployeeAttendance.create({
              employeeId: employee._id,
              date: today,
              attendanceDateIST: getISTDateString(),
              status: "on_leave",
              attendanceStatus: "absent",
              checkInStatus: "absent",
              canTakeBreak: false,
              isCheckedOut: false,
              cartId: employee.cartId,
              franchiseId: employee.franchiseId,
            });
          } catch (err) {
            if (err.code !== 11000) {
              console.error(`[ATTENDANCE] Error creating leave record:`, err.message);
            }
          }
          continue;
        }

        if (schedule && schedule.weeklySchedule) {
          const todayState = String(schedule.todayState || "").toLowerCase();
          if (todayState === "on_leave" || todayState === "sick") {
            try {
              await EmployeeAttendance.create({
                employeeId: employee._id,
                date: today,
                attendanceDateIST: getISTDateString(),
                status: todayState,
                attendanceStatus: "absent",
                checkInStatus: "absent",
                canTakeBreak: false,
                isCheckedOut: false,
                cartId: employee.cartId, // EmployeeAttendance model uses cartId
                franchiseId: employee.franchiseId,
              });
            } catch (err) {
              if (err.code !== 11000) {
                console.error(`[ATTENDANCE] Error creating leave/sick record:`, err.message);
              }
            }
            continue;
          }

          const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);
          
          if (todaySchedule && todaySchedule.isWorking) {
          const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
          // Create scheduled start time in IST
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
          
          // Add 30 minute buffer in IST
          const bufferTimeIST = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
            
            if (istNow >= bufferTimeIST) {
              try {
                await EmployeeAttendance.create({
                  employeeId: employee._id,
                  date: today,
                  attendanceDateIST: getISTDateString(),
                  status: "absent",
                  attendanceStatus: "absent",
                  checkInStatus: "absent",
                  canTakeBreak: false,
                  isCheckedOut: false,
                  cartId: employee.cartId, // EmployeeAttendance model uses cartId, not cafeId
                  franchiseId: employee.franchiseId,
                });
              } catch (err) {
                if (err.code !== 11000) {
                  console.error(`[ATTENDANCE] Error creating absent record:`, err.message);
                }
              }
            }
          }
        }
      }
    }

    if (startDate || endDate) {
      query.date = {};
      // Convert dates to IST boundaries (UTC-5:30)
      const IST_OFFSET_MINS = 330; // 5.5 hours * 60

      if (startDate) {
        const d = new Date(startDate);
        // Calculate Start of Day in IST (00:00 IST), converted to UTC
        // Default new Date(YYYY-MM-DD) is 00:00 UTC. 
        // 00:00 IST is 18:30 Prev Day UTC. Subtract 5.5 hours.
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$gte = d;
      }
      if (endDate) {
        const d = new Date(endDate);
        // Calculate End of Day in IST (23:59:59 IST), converted to UTC
        d.setHours(23, 59, 59, 999);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$lte = d;
      }
    } else if (isQueryingToday) {
      // If querying today (or no dates provided), ensure date filter is set to today
      // UNLESS searching for all history (no dates provided) - wait, isQueryingToday logic handles that
      // If startDate/endDate undefined, isQueryingToday is TRUE.
      // So default behavior is SHOW TODAY ONLY.
      // If user wants ALL history, they must provide wide date range or we change default.
      query.date = { $gte: today, $lt: tomorrow };
    }

    if (status) {
      query.status = status;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(attendance.map((record) => normalizeAttendanceRecord(record)));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get today's attendance for all employees
exports.getTodayAttendance = async (req, res) => {
  try {
    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();
    const now = new Date();

    let hierarchyQuery = await buildHierarchyQuery(req.user);
    // Captain and manager see all employees' attendance in their cart (not just their own)
    if (["manager", "captain"].includes(req.user.role)) {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const supervisorCartId =
        employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      if (supervisorCartId) {
        hierarchyQuery = { $or: [{ cartId: supervisorCartId }, { cafeId: supervisorCartId }] };
      }
    }
    const query = {
      ...hierarchyQuery,
      date: { $gte: today, $lt: tomorrow },
    };

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    // Get existing attendance records
    // For mobile users, query should already filter by employeeId
    console.log('[ATTENDANCE] getTodayAttendance query:', JSON.stringify(query, null, 2));
    let attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ "checkIn.time": -1 })
      .lean();
    console.log('[ATTENDANCE] getTodayAttendance found records:', attendance.length);

    // Get all employees in the hierarchy to check for absent employees
    let employeeQuery = await buildHierarchyQuery(req.user);
    if (["manager", "captain"].includes(req.user.role)) {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const supervisorCartId =
        employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      if (supervisorCartId) {
        employeeQuery = { $or: [{ cartId: supervisorCartId }, { cafeId: supervisorCartId }] };
      }
    }
    const employees = await Employee.find(employeeQuery)
      .select("_id name employeeRole cartId cafeId franchiseId")
      .lean();
    const employeeIds = employees.map((emp) => emp._id);
    const approvedLeaveMap = await getApprovedLeaveMapForDate({
      employeeIds,
      date: today,
    });

    // Get day name for today in IST
    const todayDay = getISTDayName();

    // Check each employee and mark absent if they haven't checked in on a working day
    const attendanceEmployeeIds = new Set(
      attendance.map((a) => a.employeeId?._id?.toString() || a.employeeId?.toString())
    );
    const employeeById = new Map(
      employees.map((emp) => [emp._id?.toString(), emp])
    );

    // Recovery path for legacy/misaligned rows:
    // If a same-day record exists for an in-scope employee but was filtered out
    // due to stale/missing cart linkage, include it and backfill cartId.
    if (employeeIds.length > 0) {
      const fallbackRows = await EmployeeAttendance.find({
        employeeId: { $in: employeeIds },
        date: { $gte: today, $lt: tomorrow },
      })
        .populate("employeeId", "name mobile employeeRole")
        .sort({ "checkIn.time": -1, updatedAt: -1, createdAt: -1 });

      for (const row of fallbackRows) {
        const rowEmployeeId =
          row?.employeeId?._id?.toString() || row?.employeeId?.toString() || null;
        if (!rowEmployeeId || attendanceEmployeeIds.has(rowEmployeeId)) {
          continue;
        }

        const employeeMeta = employeeById.get(rowEmployeeId);
        const resolvedCartId =
          employeeMeta?.cartId ||
          employeeMeta?.cafeId ||
          req.user?.cafeId ||
          req.user?.cartId ||
          null;

        if (!row.cartId && resolvedCartId) {
          row.cartId = resolvedCartId;
          if (!row.franchiseId && employeeMeta?.franchiseId) {
            row.franchiseId = employeeMeta.franchiseId;
          }
          await row.save();
        }

        attendance.push(row.toObject ? row.toObject() : row);
        attendanceEmployeeIds.add(rowEmployeeId);
      }
    }

    for (const employee of employees) {
      const employeeId = employee._id.toString();
      
      // Skip if attendance already exists
      if (attendanceEmployeeIds.has(employeeId)) {
        continue;
      }

      // Get employee's work schedule
      const schedule = await EmployeeSchedule.findOne({ employeeId: employee._id }).lean();
      const hasApprovedLeaveToday = approvedLeaveMap.get(employeeId) === true;

      if (hasApprovedLeaveToday) {
        try {
          const leaveAttendance = await EmployeeAttendance.create({
            employeeId: employee._id,
            date: today,
            attendanceDateIST: getISTDateString(),
            status: "on_leave",
            attendanceStatus: "absent",
            checkInStatus: "absent",
            canTakeBreak: false,
            isCheckedOut: false,
            cartId: employee.cartId || employee.cafeId,
            franchiseId: employee.franchiseId,
          });

          await leaveAttendance.populate("employeeId", "name mobile employeeRole");
          attendance.push(leaveAttendance.toObject());
          attendanceEmployeeIds.add(employeeId);
        } catch (err) {
          if (err.code !== 11000) {
            console.error(
              `[ATTENDANCE] Error creating approved leave record for employee ${employeeId}:`,
              err.message
            );
          }
        }
        continue;
      }
      
      if (schedule && schedule.weeklySchedule) {
        const todayState = String(schedule.todayState || "").toLowerCase();
        if (todayState === "on_leave" || todayState === "sick") {
          try {
            const leaveAttendance = await EmployeeAttendance.create({
              employeeId: employee._id,
              date: today,
              attendanceDateIST: getISTDateString(),
              status: todayState,
              attendanceStatus: "absent",
              checkInStatus: "absent",
              canTakeBreak: false,
              isCheckedOut: false,
              cartId: employee.cartId || employee.cafeId,
              franchiseId: employee.franchiseId,
            });

            await leaveAttendance.populate("employeeId", "name mobile employeeRole");
            attendance.push(leaveAttendance.toObject());
            attendanceEmployeeIds.add(employeeId);
          } catch (err) {
            if (err.code !== 11000) {
              console.error(
                `[ATTENDANCE] Error creating leave/sick record for employee ${employeeId}:`,
                err.message
              );
            }
          }
          continue;
        }

        const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);
        
        // If today is a working day and employee hasn't checked in, mark as absent
        if (todaySchedule && todaySchedule.isWorking) {
          // Check if it's past the scheduled start time (with 30 minute buffer)
          const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
          // Create scheduled start time in IST
          const scheduledStartTimeIST = new Date(istNow);
          scheduledStartTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
          
          // Add 30 minute buffer in IST - only mark absent if it's 30 minutes past scheduled start time
          const bufferTimeIST = new Date(scheduledStartTimeIST.getTime() + 30 * 60 * 1000);
          
            if (istNow >= bufferTimeIST) {
            // Create absent attendance record
            try {
              const absentAttendance = await EmployeeAttendance.create({
                employeeId: employee._id,
                date: today,
                attendanceDateIST: getISTDateString(),
                status: "absent",
                attendanceStatus: "absent",
                checkInStatus: "absent",
                canTakeBreak: false,
                isCheckedOut: false,
                cartId: employee.cartId || employee.cafeId,
                franchiseId: employee.franchiseId,
              });
              
              await absentAttendance.populate("employeeId", "name mobile employeeRole");
              attendance.push(absentAttendance.toObject());
              attendanceEmployeeIds.add(employeeId);
            } catch (err) {
              // If record already exists (race condition), skip
              if (err.code !== 11000) {
                console.error(`[ATTENDANCE] Error creating absent record for employee ${employeeId}:`, err.message);
              }
            }
          }
        }
      }
    }

    attendance = dedupeAttendanceByEmployee(attendance);

    // Calculate real-time working hours for employees who are checked in but not checked out
    const attendanceWithWorkingHours = attendance.map((record) => {
      // If already checked out, use stored values
      if (record.checkOut?.time) {
        return normalizeAttendanceRecord(record);
      }

      // If checked in but not checked out, calculate real-time working hours
      if (record.checkIn?.time) {
        const checkInTime = new Date(record.checkIn.time);
        const breakMinutes = record.breakDuration || 0;
        
        // Calculate working minutes (excluding breaks)
        // If on break, pause the timer at break start
        let workingMinutes = 0;
        if (record.isOnBreak && record.breakStart) {
          // PAUSED: Working timer is frozen at the moment break started
          const breakStartTime = new Date(record.breakStart);
          const workingTimeUntilBreak = Math.floor((breakStartTime - checkInTime) / (1000 * 60));
          // Subtract only completed breaks (breakDuration doesn't include current break)
          workingMinutes = Math.max(0, workingTimeUntilBreak - breakMinutes);
        } else {
          // ACTIVE: Working timer is running
          const totalDurationMinutes = Math.floor((now - checkInTime) / (1000 * 60));
          // Subtract completed break time
          workingMinutes = Math.max(0, totalDurationMinutes - breakMinutes);
        }

        // Live working time for UI timer (not 0:0:0)
        const hours = Math.floor(workingMinutes / 60);
        const mins = Math.floor(workingMinutes % 60);
        const secs = 0; // UI can tick seconds client-side if needed
        const liveWorkingHMS = { hours, minutes: mins, seconds: secs };

        return normalizeAttendanceRecord({
          ...record,
          totalWorkingMinutes: workingMinutes,
          workingHours: Number((workingMinutes / 60).toFixed(2)),
          liveWorkingMinutes: workingMinutes,
          liveWorkingHMS,
        });
      }

      return normalizeAttendanceRecord(record);
    });

    return res.json(attendanceWithWorkingHours);
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

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    const attendance = await EmployeeAttendance.find(query)
      .populate("employeeId", "name mobile employeeRole")
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    return res.json(attendance.map((record) => normalizeAttendanceRecord(record)));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Check-in employee
exports.checkIn = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;
    const requestMeta = getAttendanceRequestMeta(req);

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

    logAttendanceEvent({
      action: "checkin",
      outcome: "attempt",
      employeeId: targetEmployeeId,
      userId: user._id,
      role: user.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: "Check-in request received",
    });

    // Verify employee exists and check hierarchy access
    const employee = await Employee.findById(targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Resolve cart linkage robustly for mixed legacy/new data:
    // Employee.cartId (current) -> Employee.cafeId (legacy) -> User.cafeId (mobile token context).
    const employeeCartId = employee.cartId || employee.cafeId || user.cafeId || user.cartId || null;

    // Check hierarchy access
    if (user.role === "admin" && employeeCartId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (user.role === "franchise_admin" && employee.franchiseId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    // Mobile users: waiter/cook/captain can only check themselves in; manager can check in employees in their cart
    if (["waiter", "cook", "captain"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || userEmployee._id.toString() !== targetEmployeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only check yourself in." });
      }
    }
    if (user.role === "manager" && employeeId) {
      // Manager can manual check-in for employees in their cart
      const managerEmployee = await Employee.findOne({ userId: user._id }).lean();
      const managerCartId = managerEmployee?.cartId || managerEmployee?.cafeId || user.cartId || user.cafeId;
      const empCartId = employeeCartId;
      if (!managerCartId || !empCartId || empCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied. Employee must be in your cart." });
      }
    }

    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

    if (
      isDuplicateAttendanceRequest({
        action: "checkin",
        employeeId: targetEmployeeId,
        userId: user._id,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
      })
    ) {
      const duplicateQuery = {
        employeeId: targetEmployeeId,
        date: { $gte: today, $lt: tomorrow },
      };
      const cartClause = buildCartMatchClause(employeeCartId);
      if (cartClause) {
        duplicateQuery.$and = [cartClause];
      }
      const duplicateAttendance = await EmployeeAttendance.findOne(duplicateQuery)
        .sort({ updatedAt: -1, createdAt: -1 });
      const normalizedDuplicateAttendance = duplicateAttendance
        ? normalizeAttendanceRecord(duplicateAttendance)
        : {};

      logAttendanceEvent({
        action: "checkin",
        outcome: "duplicate_ignored",
        employeeId: targetEmployeeId,
        attendanceId: duplicateAttendance?._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Duplicate check-in request ignored within idempotency window",
      });

      return res.status(200).json({
        success: true,
        message: "Duplicate request ignored",
        ignored: true,
        data: normalizedDuplicateAttendance,
        attendance: normalizedDuplicateAttendance,
      });
    }

    const activeSessionQuery = buildActiveSessionQuery({
      employeeId: targetEmployeeId,
      today,
      tomorrow,
      cartId: employeeCartId,
    });
    const existingActiveSession = await EmployeeAttendance.findOne(activeSessionQuery)
      .sort({ date: -1, updatedAt: -1, createdAt: -1 });

    if (existingActiveSession) {
      logAttendanceEvent({
        action: "checkin",
        outcome: "rejected_already_checked_in",
        employeeId: targetEmployeeId,
        attendanceId: existingActiveSession._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Active check-in session already exists",
      });

      await existingActiveSession.populate("employeeId", "name mobile employeeRole");
      const normalizedExisting = normalizeAttendanceRecord(existingActiveSession);
      return res.status(409).json({
        message: "Already checked in",
        code: "ALREADY_CHECKED_IN",
        attendance: normalizedExisting,
      });
    }

    // Build query with cartId to ensure consistency with getTodayAttendance
    // This ensures we only find attendance records that match both employeeId AND cartId
    const attendanceQuery = {
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
    };
    
    // Add cartId filter if we could resolve a cart id from employee/user context.
    if (employeeCartId) {
      attendanceQuery.$or = [{ cartId: employeeCartId }, { cafeId: employeeCartId }];
    }
    
    console.log('[ATTENDANCE] checkIn query:', JSON.stringify(attendanceQuery, null, 2));
    let attendance = await EmployeeAttendance.findOne(attendanceQuery);
    console.log('[ATTENDANCE] checkIn found record:', attendance ? 'YES' : 'NO');
    
    // If no record found with cartId, check for old records without cartId (migration fix)
    if (!attendance && employeeCartId) {
      const fallbackQuery = {
        employeeId: targetEmployeeId,
        date: { $gte: today, $lt: tomorrow },
        $or: [
          { cartId: { $exists: false } },
          { cartId: null },
          { cafeId: employeeCartId },
        ],
      };
      console.log('[ATTENDANCE] checkIn fallback query (no cartId):', JSON.stringify(fallbackQuery, null, 2));
      attendance = await EmployeeAttendance.findOne(fallbackQuery);
      if (attendance) {
        console.log('[ATTENDANCE] checkIn - Found old record without cartId, updating...');
        attendance.cartId = employeeCartId;
        await attendance.save();
        console.log('[ATTENDANCE] checkIn - Updated cartId on old record');
      }
    }
    
    if (attendance) {
      console.log('[ATTENDANCE] checkIn record details:', {
        _id: attendance._id,
        employeeId: attendance.employeeId?.toString(),
        cartId: attendance.cartId?.toString(),
        date: attendance.date,
        hasCheckIn: !!attendance.checkIn?.time,
      });
    }

    // Get employee schedule to validate off-day and late status (all comparisons in IST)
    const schedule = await EmployeeSchedule.findOne({ employeeId: targetEmployeeId });
    const todayDay = getISTDayName();
    const todaySchedule = getTodaySchedule(schedule, todayDay);
    const canOverrideNonWorkingDay = ["admin", "franchise_admin", "super_admin"].includes(
      user.role
    );

    if (todaySchedule && todaySchedule.isWorking === false && !canOverrideNonWorkingDay) {
      return res.status(400).json({
        message: "Today is your off day. Check-in is disabled.",
        code: "OFF_DAY",
      });
    }

    const todayState = String(schedule?.todayState || "").toLowerCase();
    const isMarkedOnLeaveState = todayState === "on_leave" || todayState === "sick";
    const hasApprovedLeaveToday = await hasApprovedLeaveForToday(
      targetEmployeeId,
      today
    );
    if ((isMarkedOnLeaveState || hasApprovedLeaveToday) && !canOverrideNonWorkingDay) {
      return res.status(400).json({
        message: isMarkedOnLeaveState
          ? todayState === "on_leave"
            ? "You are marked on leave for today."
            : "You are marked sick for today."
          : "You are on approved leave for today.",
        code: "LEAVE_DAY",
      });
    }

    if (attendance && (attendance.isCheckedOut || attendance.checkOut?.time)) {
      logAttendanceEvent({
        action: "checkin",
        outcome: "rejected_already_checked_out",
        employeeId: targetEmployeeId,
        attendanceId: attendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Employee has already checked out today",
      });

      return res.status(400).json({
        message: "You have already checked out for today. Check-in is locked.",
        code: "ALREADY_CHECKED_OUT",
      });
    }

    const checkedInTodayQuery = {
      employeeId: targetEmployeeId,
      date: { $gte: today, $lt: tomorrow },
      "checkIn.time": { $ne: null },
    };

    const checkedInToday = await EmployeeAttendance.findOne(checkedInTodayQuery)
      .sort({ updatedAt: -1, createdAt: -1 });

    if (checkedInToday) {
      // Backfill missing cart linkage on legacy records so admin/web filters can see them.
      if (!checkedInToday.cartId && employeeCartId) {
        checkedInToday.cartId = employeeCartId;
        checkedInToday.franchiseId = employee.franchiseId;
        await checkedInToday.save();
      }
      const alreadyCheckedOut = checkedInToday.isCheckedOut || checkedInToday.checkOut?.time;

      logAttendanceEvent({
        action: "checkin",
        outcome: alreadyCheckedOut
          ? "rejected_already_checked_out"
          : "already_checked_in_200",
        employeeId: targetEmployeeId,
        attendanceId: checkedInToday._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: alreadyCheckedOut ? "Check-in locked (already checked out)" : "Already checked in, return 200 for UI sync",
      });

      if (alreadyCheckedOut) {
        return res.status(400).json({
          message: "You have already checked out for today. Check-in is locked.",
          code: "ALREADY_CHECKED_OUT",
        });
      }

      await checkedInToday.populate("employeeId", "name mobile employeeRole");
      const normalized = normalizeAttendanceRecord(checkedInToday);
      return res.status(200).json({
        alreadyCheckedIn: true,
        message: "Already checked in",
        code: "ALREADY_CHECKED_IN",
        attendance: normalized,
      });
    }

    // Get current time in IST, then convert to UTC for MongoDB storage
    const checkInTimeIST = getISTNow();
    const checkInTime = istToUTC(checkInTimeIST); // Store in UTC (MongoDB default)

    let status = "present";
    let isLate = false;

    if (todaySchedule && todaySchedule.isWorking && todaySchedule.startTime) {
      const [hours, minutes] = todaySchedule.startTime.split(":").map(Number);
        // Create scheduled time in IST for today
        const scheduledTimeIST = new Date(istNow);
        scheduledTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
        
        // Compare checkInTime (IST) with scheduledTime (IST)
        if (checkInTimeIST > scheduledTimeIST) {
          const lateMinutes = Math.floor((checkInTimeIST - scheduledTimeIST) / (1000 * 60));
          if (lateMinutes > 15) {
            // Late if more than 15 minutes
            status = "late";
            isLate = true;
          }
        }
    }

    const istDateKey = getISTDateString();
    try {
      if (attendance) {
        // Update existing record - ensure date and IST day key set
        attendance.date = today;
        attendance.attendanceDateIST = istDateKey;
        attendance.checkIn = {
          time: checkInTime,
          location: location || "",
          notes: notes || "",
        };
        attendance.status = status;
        attendance.attendanceStatus = "checked_in";
        attendance.checkInStatus = "checked_in";
        attendance.canTakeBreak = true;
        attendance.isCheckedOut = false;
        attendance.isOnBreak = false;
        attendance.breakStart = null;
        attendance.breaks = [];
        attendance.breakDuration = 0;
        attendance.cartId = employeeCartId; // Keep cart linkage stable for admin/web queries.
        attendance.franchiseId = employee.franchiseId;
        await attendance.save();
      } else {
        // Create new record
        attendance = await EmployeeAttendance.create({
          employeeId: targetEmployeeId,
          date: today,
          attendanceDateIST: istDateKey,
          checkIn: {
            time: checkInTime,
            location: location || "",
            notes: notes || "",
          },
          status: status,
          attendanceStatus: "checked_in",
          checkInStatus: "checked_in",
          canTakeBreak: true,
          isCheckedOut: false,
          isOnBreak: false,
          breakDuration: 0,
          breaks: [],
          cartId: employeeCartId, // EmployeeAttendance model uses cartId, not cafeId
          franchiseId: employee.franchiseId,
        });
      }
    } catch (saveErr) {
      if (saveErr?.code === 11000) {
        logAttendanceEvent({
          action: "checkin",
          outcome: "rejected_duplicate_day_record",
          employeeId: targetEmployeeId,
          userId: user._id,
          role: user.role,
          deviceId: requestMeta.deviceId,
          requestTimestampMs: requestMeta.requestTimestampMs,
          message: "Duplicate day attendance record blocked by unique validation",
        });

        return res.status(409).json({
          message: "Already checked in",
          code: "ALREADY_CHECKED_IN",
        });
      }
      throw saveErr;
    }

    try {
      await ensureDailyTasksForEmployeeDate({
        employee,
        targetDate: new Date(),
        generatedBy: user._id || null,
      });
    } catch (taskGenerationError) {
      console.error(
        `[ATTENDANCE] Failed to ensure daily tasks on check-in for employee ${targetEmployeeId}: ${taskGenerationError.message}`
      );
    }

    await attendance.populate("employeeId", "name mobile employeeRole");
    const normalizedAttendance = normalizeAttendanceRecord(attendance);

    logAttendanceEvent({
      action: "checkin",
      outcome: "success",
      employeeId: targetEmployeeId,
      attendanceId: attendance._id,
      userId: user._id,
      role: user.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: "Check-in recorded successfully",
    });

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId; // Support both for backward compatibility
    if (io && emitToCafe && attendanceCartId) {
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_in", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      message: isLate ? "Checked in (Late)" : "Checked in successfully",
      attendance: normalizeAttendanceRecord(attendance),
      isLate,
    });
  } catch (err) {
    const requestMeta = getAttendanceRequestMeta(req);
    logAttendanceEvent({
      action: "checkin",
      outcome: "error",
      employeeId: req.body?.employeeId,
      userId: req.user?._id,
      role: req.user?.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: err.message,
    });
    return res.status(500).json({ message: err.message });
  }
};

// Check-out employee
exports.checkOut = async (req, res) => {
  try {
    const { employeeId, location, notes } = req.body;
    const user = req.user;
    const requestMeta = getAttendanceRequestMeta(req);

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

    logAttendanceEvent({
      action: "checkout",
      outcome: "attempt",
      employeeId: targetEmployeeId,
      userId: user._id,
      role: user.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: "Check-out request received",
    });

    // Verify employee exists and check hierarchy access
    const employee = await Employee.findById(targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Check hierarchy access
    if (user.role === "admin" && employee.cartId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (user.role === "franchise_admin" && employee.franchiseId?.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    // waiter/cook/captain can only check themselves out
    if (["waiter", "cook", "captain"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id });
      if (!userEmployee || userEmployee._id.toString() !== targetEmployeeId.toString()) {
        return res.status(403).json({ message: "Access denied. You can only check yourself out." });
      }
    }
    if (user.role === "manager" && employeeId) {
      // Manager can manual check-out for employees in their cart
      const managerEmployee = await Employee.findOne({ userId: user._id }).lean()
        || await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      const managerCartId =
        managerEmployee?.cartId || managerEmployee?.cafeId || user.cartId || user.cafeId;
      const empCartId = employee.cartId || employee.cafeId;
      if (!managerCartId || !empCartId || empCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied. Employee must be in your cart." });
      }
    }

    // Get today's date in IST (using helper function)
    const { today, tomorrow } = getISTDateRange();
    const istNow = getISTNow();

    if (
      isDuplicateAttendanceRequest({
        action: "checkout",
        employeeId: targetEmployeeId,
        userId: user._id,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
      })
    ) {
      const duplicateQuery = {
        employeeId: targetEmployeeId,
        date: { $gte: today, $lt: tomorrow },
      };
      const cartClause = buildCartMatchClause(employee.cartId);
      if (cartClause) {
        duplicateQuery.$and = [cartClause];
      }
      const duplicateAttendance = await EmployeeAttendance.findOne(duplicateQuery)
        .sort({ updatedAt: -1, createdAt: -1 });
      const normalizedDuplicateAttendance = duplicateAttendance
        ? normalizeAttendanceRecord(duplicateAttendance)
        : {};

      logAttendanceEvent({
        action: "checkout",
        outcome: "duplicate_ignored",
        employeeId: targetEmployeeId,
        attendanceId: duplicateAttendance?._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Duplicate check-out request ignored within idempotency window",
      });

      return res.status(200).json({
        success: true,
        message: "Duplicate request ignored",
        ignored: true,
        data: normalizedDuplicateAttendance,
        attendance: normalizedDuplicateAttendance,
      });
    }

    const activeSessionQuery = buildActiveSessionQuery({
      employeeId: targetEmployeeId,
      today,
      tomorrow,
    });
    console.log('[ATTENDANCE] checkOut query:', JSON.stringify(activeSessionQuery, null, 2));

    const attendance = await EmployeeAttendance.findOne(activeSessionQuery)
      .sort({ updatedAt: -1, createdAt: -1 });
    console.log('[ATTENDANCE] checkOut found active session:', attendance ? 'YES' : 'NO');

    if (!attendance) {
      logAttendanceEvent({
        action: "checkout",
        outcome: "rejected_no_active_session",
        employeeId: targetEmployeeId,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "No active check-in session found for checkout",
      });

      const latestToday = await EmployeeAttendance.findOne({
        employeeId: targetEmployeeId,
        date: { $gte: today, $lt: tomorrow },
      })
        .sort({ updatedAt: -1 })
        .populate("employeeId", "name mobile employeeRole")
        .lean();
      return res.status(200).json({
        message: "No active session found",
        reason: "No active session found",
        attendance: latestToday ? normalizeAttendanceRecord(latestToday) : null,
      });
    }

    if (attendance.isOnBreak || attendance.breakStart) {
      logAttendanceEvent({
        action: "checkout",
        outcome: "rejected_on_break",
        employeeId: targetEmployeeId,
        attendanceId: attendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Cannot checkout while break is active",
      });

      await attendance.populate("employeeId", "name mobile employeeRole");
      return res.status(200).json({
        message: "Cannot checkout while on break. Please end break first.",
        reason: "Cannot checkout while on break. Please end break first.",
        attendance: normalizeAttendanceRecord(attendance),
      });
    }

    // Canonical checkout: delegate to PATCH /:id/checkout (same guards and logic)
    const prevParams = req.params;
    req.params = { id: attendance._id.toString() };
    try {
      return await exports.checkOutById(req, res);
    } finally {
      req.params = prevParams;
    }
  } catch (err) {
    const requestMeta = getAttendanceRequestMeta(req);
    logAttendanceEvent({
      action: "checkout",
      outcome: "error",
      employeeId: req.body?.employeeId,
      userId: req.user?._id,
      role: req.user?.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: err.message,
    });
    return res.status(500).json({ message: err.message });
  }
};

// Check-out by attendance ID (for mobile app) - canonical checkout
exports.checkOutById = async (req, res) => {
  try {
    const { id } = req.params;
    const { location, notes } = req.body;
    const user = req.user;
    const requestMeta = getAttendanceRequestMeta(req);

    // Find attendance record
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    logAttendanceEvent({
      action: "checkout",
      outcome: "attempt",
      employeeId: attendance.employeeId,
      attendanceId: attendance._id,
      userId: user._id,
      role: user.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: "Check-out-by-id request received",
    });

    // Mobile role access checks
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      const userEmployee = await Employee.findOne({ userId: user._id }).lean()
        || await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
      if (!userEmployee) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      if (user.role === "manager") {
        const managerCartId =
          userEmployee.cartId || userEmployee.cafeId || user.cartId || user.cafeId;
        const attendanceCartId = attendance.cartId || attendance.cafeId;
        if (
          !managerCartId ||
          !attendanceCartId ||
          attendanceCartId.toString() !== managerCartId.toString()
        ) {
          return res.status(403).json({ success: false, message: "Access denied" });
        }
      } else if (attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    const { today, tomorrow } = getISTDateRange();

    if (
      isDuplicateAttendanceRequest({
        action: "checkout",
        employeeId: attendance.employeeId,
        userId: user._id,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
      })
    ) {
      const duplicateQuery = {
        employeeId: attendance.employeeId,
        date: { $gte: today, $lt: tomorrow },
      };
      const cartClause = buildCartMatchClause(attendance.cartId || attendance.cafeId);
      if (cartClause) {
        duplicateQuery.$and = [cartClause];
      }
      const duplicateAttendance = await EmployeeAttendance.findOne(duplicateQuery)
        .sort({ updatedAt: -1, createdAt: -1 });
      const normalizedDuplicateAttendance = duplicateAttendance
        ? normalizeAttendanceRecord(duplicateAttendance)
        : {};

      logAttendanceEvent({
        action: "checkout",
        outcome: "duplicate_ignored",
        employeeId: attendance.employeeId,
        attendanceId: duplicateAttendance?._id || attendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Duplicate checkout-by-id request ignored within idempotency window",
      });

      return res.status(200).json({
        success: true,
        message: "Duplicate request ignored",
        ignored: true,
        data: normalizedDuplicateAttendance,
        attendance: normalizedDuplicateAttendance,
      });
    }

    const activeSessionQuery = buildActiveSessionQuery({
      employeeId: attendance.employeeId,
      today,
      tomorrow,
    });
    const activeAttendance = await EmployeeAttendance.findOne(activeSessionQuery)
      .sort({ updatedAt: -1, createdAt: -1 });

    if (!activeAttendance) {
      logAttendanceEvent({
        action: "checkout",
        outcome: "rejected_no_active_session",
        employeeId: attendance.employeeId,
        attendanceId: attendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "No active check-in session found for checkout-by-id",
      });

      await attendance.populate("employeeId", "name mobile employeeRole");
      return res.status(200).json({
        success: false,
        message: "No active session found",
        reason: "No active session found",
        attendance: normalizeAttendanceRecord(attendance),
      });
    }

    // Check if on break - must end break before checkout
    if (activeAttendance.isOnBreak || (activeAttendance.breakStart && !activeAttendance.checkOut?.time)) {
      logAttendanceEvent({
        action: "checkout",
        outcome: "rejected_on_break",
        employeeId: activeAttendance.employeeId,
        attendanceId: activeAttendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: "Cannot checkout while break is active",
      });

      await activeAttendance.populate("employeeId", "name mobile employeeRole");
      return res.status(200).json({
        success: false,
        message: "Cannot checkout while on break. Please end break first.",
        reason: "Cannot checkout while on break. Please end break first.",
        attendance: normalizeAttendanceRecord(activeAttendance),
      });
    }

    const managerOverrideRequested =
      req.body?.managerOverride === true ||
      String(req.body?.managerOverride || "").toLowerCase() === "true";
    const managerOverrideReason = String(
      req.body?.managerOverrideReason || req.body?.overrideReason || ""
    ).trim();
    const canUseManagerOverride = [
      "manager",
      "admin",
      "franchise_admin",
      "super_admin",
    ].includes(user.role);

    if (managerOverrideRequested && !canUseManagerOverride) {
      return res.status(403).json({
        success: false,
        message: "Manager override is not allowed for your role.",
        code: "MANAGER_OVERRIDE_NOT_ALLOWED",
      });
    }

    const pendingTaskSummary = await getPendingTaskSummaryForEmployeeDate({
      employeeId: activeAttendance.employeeId,
      dateKey: activeAttendance.attendanceDateIST || getISTDateString(),
    });
    const pendingTaskCount = Number(
      pendingTaskSummary.totalPendingTaskCount || 0
    );

    if (pendingTaskCount > 0 && !(managerOverrideRequested && canUseManagerOverride)) {
      await notifyEmployeePendingCheckoutTasks({
        employeeId: activeAttendance.employeeId,
        pendingTaskCount,
        dateKey: pendingTaskSummary.dateKey,
      });

      logAttendanceEvent({
        action: "checkout",
        outcome: "rejected_pending_tasks",
        employeeId: activeAttendance.employeeId,
        attendanceId: activeAttendance._id,
        userId: user._id,
        role: user.role,
        deviceId: requestMeta.deviceId,
        requestTimestampMs: requestMeta.requestTimestampMs,
        message: `Checkout blocked due to ${pendingTaskCount} pending task(s)`,
      });

      await activeAttendance.populate("employeeId", "name mobile employeeRole");
      return res.status(409).json({
        success: false,
        code: "PENDING_TASKS_BLOCK_CHECKOUT",
        message: "Complete assigned tasks before checkout or request manager override.",
        pendingTaskCount,
        managerOverrideAllowed: canUseManagerOverride,
        attendance: normalizeAttendanceRecord(activeAttendance),
      });
    }

    // Get current time in IST, then convert to UTC for MongoDB storage
    const checkOutTimeIST = getISTNow();
    const checkOutTime = istToUTC(checkOutTimeIST); // Store in UTC (MongoDB default)

    // Calculate working hours (convert stored UTC times to IST for calculation)
    const checkInTimeUTC = new Date(activeAttendance.checkIn.time);
    const checkInTimeIST = utcToIST(checkInTimeUTC);
    const totalDurationMinutes = Math.floor((checkOutTimeIST - checkInTimeIST) / (1000 * 60));
    const breakMinutes = activeAttendance.breakDuration || 0;
    const totalWorkingMinutes = Math.max(0, totalDurationMinutes - breakMinutes);

    // Get schedule to calculate overtime (all comparisons in IST)
    const schedule = await EmployeeSchedule.findOne({ employeeId: activeAttendance.employeeId });
    let overtime = 0;

    if (schedule && schedule.weeklySchedule) {
      const istNow = getISTNow();
      const todayDay = getISTDayName();
      const todaySchedule = schedule.weeklySchedule.find((s) => s.day === todayDay);

      if (todaySchedule && todaySchedule.isWorking && todaySchedule.endTime) {
        const [hours, minutes] = todaySchedule.endTime.split(":").map(Number);
        // Create scheduled end time in IST for today
        const scheduledEndTimeIST = new Date(istNow);
        scheduledEndTimeIST.setHours(hours, minutes, 0, 0); // Set time in IST
        
        // Compare checkOutTime (IST) with scheduledEndTime (IST)
        if (checkOutTimeIST > scheduledEndTimeIST) {
          overtime = Math.floor((checkOutTimeIST - scheduledEndTimeIST) / (1000 * 60));
        }
      }
    }

    // Ensure date field is set to today's IST date (in case it was set incorrectly)
    activeAttendance.date = today;
    
    activeAttendance.checkOut = {
      time: checkOutTime,
      location: location || "",
      notes: notes || "",
    };
    activeAttendance.totalWorkingMinutes = totalWorkingMinutes;
    activeAttendance.workingHours = Number((totalWorkingMinutes / 60).toFixed(2)); // Convert to hours with 2 decimal places
    activeAttendance.overtime = Math.max(0, overtime);
    activeAttendance.isOnBreak = false;
    activeAttendance.breakStart = null;
    activeAttendance.attendanceStatus = "checked_out";
    activeAttendance.checkInStatus = "checked_out";
    activeAttendance.canTakeBreak = false;
    activeAttendance.isCheckedOut = true;
    activeAttendance.pendingTasksAtCheckout = pendingTaskCount;
    activeAttendance.managerOverrideUsed =
      managerOverrideRequested && canUseManagerOverride;
    activeAttendance.managerOverrideBy =
      managerOverrideRequested && canUseManagerOverride ? user._id : null;
    activeAttendance.managerOverrideReason =
      managerOverrideRequested && canUseManagerOverride
        ? managerOverrideReason
        : "";
    activeAttendance.autoCheckedOut = false;
    
    // Update status - if less than 4 hours, mark as half_day, otherwise completed
    if (totalWorkingMinutes < 240) {
      // Less than 4 hours
      activeAttendance.status = "half_day";
    } else {
      activeAttendance.status = "completed";
    }

    await activeAttendance.save();
    await activeAttendance.populate("employeeId", "name mobile employeeRole");
    const normalizedAttendance = normalizeAttendanceRecord(activeAttendance);

    logAttendanceEvent({
      action: "checkout",
      outcome: "success",
      employeeId: activeAttendance.employeeId,
      attendanceId: activeAttendance._id,
      userId: user._id,
      role: user.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message:
        activeAttendance._id.toString() === attendance._id.toString()
          ? "Checkout recorded successfully"
          : `Checkout completed using active session ${activeAttendance._id.toString()} for requested record ${attendance._id.toString()}`,
    });

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = activeAttendance.cartId || activeAttendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      emitToCafe(io, attendanceCartId.toString(), "attendance:checked_out", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Checked out successfully",
      data: normalizedAttendance,
      attendance: normalizedAttendance,
      pendingTaskCount,
      totalWorkingMinutes: totalWorkingMinutes,
      workingHours: activeAttendance.workingHours,
      overtime: activeAttendance.overtime,
    });
  } catch (err) {
    console.error('[ATTENDANCE] Checkout by ID error:', err);
    const requestMeta = getAttendanceRequestMeta(req);
    logAttendanceEvent({
      action: "checkout",
      outcome: "error",
      employeeId: req.body?.employeeId,
      userId: req.user?._id,
      role: req.user?.role,
      deviceId: requestMeta.deviceId,
      requestTimestampMs: requestMeta.requestTimestampMs,
      message: err.message,
    });
    return res.status(500).json({ success: false, message: err.message });
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
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    // Check access - mobile users can only manage their own attendance
    if (["waiter", "cook", "captain", "manager"].includes(user.role)) {
      // Mobile users: lookup Employee by email (since User.email matches Employee.email)
      const userEmployee = await Employee.findOne({ 
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    await attendance.populate("employeeId", "name mobile employeeRole");
    const normalizedForResponse = normalizeAttendanceRecord(attendance);

    if (!attendance.checkIn?.time) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Employee has not checked in",
      });
    }

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Employee has already checked out",
      });
    }

    if (attendance.canTakeBreak === false) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Break not allowed before check-in",
      });
    }

    // Check if already on break (using isOnBreak field or breakStart)
    if (attendance.isOnBreak || attendance.breakStart) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Break already started",
      });
    }

    attendance.breakStart = new Date();
    attendance.isOnBreak = true;
    attendance.attendanceStatus = "on_break";
    attendance.checkInStatus = "checked_in";
    attendance.canTakeBreak = true;
    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:break_started", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Break started",
      data: normalizeAttendanceRecord(attendance),
      attendance: normalizeAttendanceRecord(attendance), // Keep for backward compatibility
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
      // Mobile users: lookup Employee by email (since User.email matches Employee.email)
      const userEmployee = await Employee.findOne({ 
        $or: [
          { userId: user._id },
          { email: user.email?.toLowerCase() }
        ]
      });
      if (!userEmployee || attendance.employeeId.toString() !== userEmployee._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    } else {
      // Admin access check
      const query = await buildHierarchyQuery(user);
      if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
    }

    await attendance.populate("employeeId", "name mobile employeeRole");
    const normalizedForResponse = normalizeAttendanceRecord(attendance);

    // Check if on break (using isOnBreak field or breakStart)
    if (!attendance.isOnBreak && !attendance.breakStart) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Break has not been started",
      });
    }

    if (attendance.isCheckedOut || attendance.checkOut?.time) {
      return res.status(200).json({
        success: false,
        attendance: normalizedForResponse,
        reason: "Employee has already checked out",
      });
    }

    const breakEnd = new Date();
    const breakStart = attendance.breakStart ? new Date(attendance.breakStart) : breakEnd;
    const breakDuration = Math.max(0, Math.floor((breakEnd - breakStart) / (1000 * 60))); // in minutes
    attendance.breakDuration = (attendance.breakDuration || 0) + breakDuration;
    if (!Array.isArray(attendance.breaks)) {
      attendance.breaks = [];
    }
    attendance.breaks.push({
      breakStart,
      breakEnd,
      durationMinutes: breakDuration,
    });
    attendance.breakStart = null; // Clear break start time
    attendance.isOnBreak = false; // Clear break status
    attendance.attendanceStatus = "checked_in";
    attendance.checkInStatus = "checked_in";
    attendance.canTakeBreak = true;

    await attendance.save();
    await attendance.populate("employeeId", "name mobile employeeRole");

    // Emit socket event for real-time update
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      const normalizedAttendance = normalizeAttendanceRecord(attendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:break_ended", normalizedAttendance);
      emitToCafe(io, attendanceCartId.toString(), "attendance:updated", normalizedAttendance);
    }

    return res.json({
      success: true,
      message: "Break ended",
      data: normalizeAttendanceRecord(attendance),
      attendance: normalizeAttendanceRecord(attendance), // Keep for backward compatibility
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

    if (req.query.cartId) {
      query.cartId = req.query.cartId;
    }

    if (startDate || endDate) {
      query.date = {};
      // Convert dates to IST boundaries (UTC-5:30)
      const IST_OFFSET_MINS = 330; 

      if (startDate) {
        const d = new Date(startDate);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$gte = d;
      }
      if (endDate) {
        const d = new Date(endDate);
        d.setHours(23, 59, 59, 999);
        d.setMinutes(d.getMinutes() - IST_OFFSET_MINS);
        query.date.$lte = d;
      }
    }

    const attendance = await EmployeeAttendance.find(query).lean();

    const isWorkingStatus = (row) => {
      const status = String(row?.status || "").toLowerCase();
      if (["present", "late", "half_day", "completed"].includes(status)) {
        return true;
      }
      if (row?.checkIn?.time) return true;
      if (Number(row?.totalWorkingMinutes || 0) > 0) return true;
      if (Number(row?.workingHours || 0) > 0) return true;
      return false;
    };

    const leaveStatusSet = new Set(["on_leave", "sick"]);
    const workingDays = attendance.filter((row) => isWorkingStatus(row)).length;
    const leaveDays = attendance.filter((row) =>
      leaveStatusSet.has(String(row?.status || "").toLowerCase())
    ).length;

    const stats = {
      totalDays: attendance.length,
      present: attendance.filter((a) => a.status === "present").length,
      absent: attendance.filter((a) => a.status === "absent").length,
      late: attendance.filter((a) => a.status === "late").length,
      halfDay: attendance.filter((a) => a.status === "half_day").length,
      onLeave: attendance.filter((a) => a.status === "on_leave").length,
      sick: attendance.filter((a) => a.status === "sick").length,
      workingDays,
      leaveDays,
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
    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      const attCartId = attendance.cartId || attendance.cafeId;
      if (!managerCartId || !attCartId || attCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (query.cafeId && attendance.cafeId?.toString() !== query.cafeId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    } else if (query.franchiseId && attendance.franchiseId?.toString() !== query.franchiseId.toString()) {
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
    const normalizedAttendance = normalizeAttendanceRecord(attendance);

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    const attendanceCartId = attendance.cartId || attendance.cafeId;
    if (io && emitToCafe && attendanceCartId) {
      emitToCafe(
        io,
        attendanceCartId.toString(),
        "attendance:updated",
        normalizedAttendance
      );
    }

    return res.json(normalizedAttendance);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Delete attendance record (admin, manager - for erroneous records)
exports.deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const attendance = await EmployeeAttendance.findById(id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    if (req.user.role === "manager") {
      const employee = await Employee.findOne({ userId: req.user._id }).lean()
        || await Employee.findOne({ email: req.user.email?.toLowerCase() }).lean();
      const managerCartId = employee?.cartId || employee?.cafeId || req.user.cartId || req.user.cafeId;
      const attCartId = attendance.cartId || attendance.cafeId;
      if (!managerCartId || !attCartId || attCartId.toString() !== managerCartId.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (!["admin", "franchise_admin", "super_admin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const attendanceCartId = attendance.cartId || attendance.cafeId;
    await EmployeeAttendance.findByIdAndDelete(id);

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");
    if (io && emitToCafe && attendanceCartId) {
      const deletedPayload = {
        _id: id,
        employeeId: attendance.employeeId,
        deleted: true,
      };
      emitToCafe(
        io,
        attendanceCartId.toString(),
        "attendance:deleted",
        deletedPayload
      );
      emitToCafe(
        io,
        attendanceCartId.toString(),
        "attendance:updated",
        deletedPayload
      );
    }

    return res.json({ message: "Attendance record deleted" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
