const LeaveRequest = require("../models/leaveRequestModel");
const Employee = require("../models/employeeModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");
const EmployeeSchedule = require("../models/employeeScheduleModel");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const getISTNow = () => {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MS);
};

const istToUTC = (istDate) => {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
};

const getISTDate = () => {
  const istNow = getISTNow();
  const istDate = new Date(istNow);
  istDate.setHours(0, 0, 0, 0);
  return istToUTC(istDate);
};

const getISTDateRange = () => {
  const today = getISTDate();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
};

const parseLeaveDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const istDate = new Date(parsed.getTime() + IST_OFFSET_MS);
  istDate.setHours(0, 0, 0, 0);
  return new Date(istDate.getTime() - IST_OFFSET_MS);
};

const normalizeObjectIdString = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return null;
};

const resolveEmployeeForUser = async (user) => {
  if (!user) return null;

  if (user.employeeId) {
    const byId = await Employee.findById(user.employeeId).lean();
    if (byId) return byId;
  }

  let employee = await Employee.findOne({ userId: user._id }).lean();
  if (!employee && user.email) {
    employee = await Employee.findOne({ email: user.email?.toLowerCase() }).lean();
  }

  return employee;
};

const getManagerCartId = async (user) => {
  const managerEmployee = await resolveEmployeeForUser(user);
  return (
    managerEmployee?.cartId ||
    managerEmployee?.cafeId ||
    user.cartId ||
    user.cafeId ||
    null
  );
};

const canManageLeaveRequest = async (user, leaveRequest) => {
  if (!user || !leaveRequest) return false;

  if (user.role === "super_admin") return true;

  const leaveCartId = normalizeObjectIdString(leaveRequest.cartId);
  const leaveFranchiseId = normalizeObjectIdString(leaveRequest.franchiseId);

  if (user.role === "franchise_admin") {
    return leaveFranchiseId === normalizeObjectIdString(user._id);
  }

  if (user.role === "admin") {
    return leaveCartId === normalizeObjectIdString(user._id);
  }

  if (user.role === "manager") {
    const managerCartId = normalizeObjectIdString(await getManagerCartId(user));
    return Boolean(managerCartId && leaveCartId && managerCartId === leaveCartId);
  }

  return false;
};

const buildLeaveListQuery = async (user) => {
  if (!user) return { _id: null };

  if (user.role === "super_admin") {
    return {};
  }

  if (user.role === "franchise_admin") {
    return { franchiseId: user._id };
  }

  if (user.role === "admin") {
    return { cartId: user._id };
  }

  if (user.role === "manager") {
    const managerCartId = await getManagerCartId(user);
    if (!managerCartId) return { _id: null };
    return { cartId: managerCartId };
  }

  const employee = await resolveEmployeeForUser(user);
  if (!employee) return { _id: null };
  return { employeeId: employee._id };
};

const hasApprovedLeaveForToday = async (employeeId, excludeLeaveRequestId = null) => {
  const { today } = getISTDateRange();
  const query = {
    employeeId,
    status: "approved",
    startDate: { $lte: today },
    endDate: { $gte: today },
  };

  if (excludeLeaveRequestId) {
    query._id = { $ne: excludeLeaveRequestId };
  }

  const existing = await LeaveRequest.findOne(query).select("_id").lean();
  return Boolean(existing);
};

const upsertTodayLeaveAttendance = async ({ employee }) => {
  if (!employee?._id) return;

  const { today, tomorrow } = getISTDateRange();

  let attendance = await EmployeeAttendance.findOne({
    employeeId: employee._id,
    date: { $gte: today, $lt: tomorrow },
  });

  // If the employee is already checked in/out, leave should not overwrite the active shift.
  if (
    attendance &&
    (attendance.checkIn?.time || attendance.checkOut?.time || attendance.isCheckedOut)
  ) {
    return;
  }

  if (!attendance) {
    attendance = new EmployeeAttendance({
      employeeId: employee._id,
      date: today,
      cartId: employee.cartId || employee.cafeId,
      franchiseId: employee.franchiseId,
    });
  }

  attendance.status = "on_leave";
  attendance.attendanceStatus = "absent";
  attendance.checkInStatus = "absent";
  attendance.canTakeBreak = false;
  attendance.isCheckedOut = false;
  attendance.isOnBreak = false;
  attendance.breakStart = null;
  attendance.breakDuration = 0;
  attendance.breaks = [];
  attendance.checkIn = { time: null, location: "", notes: "" };
  attendance.checkOut = { time: null, location: "", notes: "" };
  attendance.totalWorkingMinutes = 0;
  attendance.workingHours = 0;
  attendance.overtime = 0;
  attendance.cartId = employee.cartId || employee.cafeId;
  attendance.franchiseId = employee.franchiseId;

  await attendance.save();
};

exports.createLeaveRequest = async (req, res) => {
  try {
    const user = req.user;
    const { startDate, endDate, reason, employeeId } = req.body;

    const normalizedReason = String(reason || "").trim();
    if (!normalizedReason) {
      return res.status(400).json({ message: "Reason is required" });
    }

    const normalizedStartDate = parseLeaveDate(startDate);
    const normalizedEndDate = parseLeaveDate(endDate || startDate);

    if (!normalizedStartDate || !normalizedEndDate) {
      return res.status(400).json({ message: "Valid start and end dates are required" });
    }

    if (normalizedEndDate < normalizedStartDate) {
      return res.status(400).json({ message: "End date cannot be before start date" });
    }

    let employee;

    if (
      employeeId &&
      ["admin", "franchise_admin", "super_admin", "manager"].includes(user.role)
    ) {
      employee = await Employee.findById(employeeId).lean();
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const mockRequest = {
        ...user,
        employeeId: null,
      };
      const hierarchyQuery = await buildLeaveListQuery(mockRequest);

      if (hierarchyQuery.cartId) {
        const employeeCartId = normalizeObjectIdString(employee.cartId || employee.cafeId);
        if (employeeCartId !== normalizeObjectIdString(hierarchyQuery.cartId)) {
          return res.status(403).json({ message: "Access denied for selected employee" });
        }
      }

      if (hierarchyQuery.franchiseId) {
        const employeeFranchiseId = normalizeObjectIdString(employee.franchiseId);
        if (
          employeeFranchiseId !== normalizeObjectIdString(hierarchyQuery.franchiseId)
        ) {
          return res.status(403).json({ message: "Access denied for selected employee" });
        }
      }
    } else {
      employee = await resolveEmployeeForUser(user);
      if (!employee) {
        return res.status(404).json({ message: "Employee profile not found" });
      }
    }

    const overlap = await LeaveRequest.findOne({
      employeeId: employee._id,
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: normalizedEndDate },
      endDate: { $gte: normalizedStartDate },
    })
      .select("_id")
      .lean();

    if (overlap) {
      return res.status(400).json({
        message: "An overlapping leave request already exists for the selected dates",
      });
    }

    const leaveRequest = await LeaveRequest.create({
      employeeId: employee._id,
      cartId: employee.cartId || employee.cafeId,
      franchiseId: employee.franchiseId,
      requestedBy: user._id,
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
      reason: normalizedReason,
    });

    await leaveRequest.populate("employeeId", "name employeeRole mobile");
    await leaveRequest.populate("requestedBy", "name role");

    return res.status(201).json({
      success: true,
      message: "Leave request submitted",
      data: leaveRequest,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.getMyLeaveRequests = async (req, res) => {
  try {
    const employee = await resolveEmployeeForUser(req.user);
    if (!employee) {
      return res.json([]);
    }

    const requests = await LeaveRequest.find({ employeeId: employee._id })
      .populate("employeeId", "name employeeRole mobile")
      .populate("requestedBy", "name role")
      .populate("reviewedBy", "name role")
      .sort({ startDate: -1, createdAt: -1 })
      .lean();

    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.getLeaveRequests = async (req, res) => {
  try {
    const { status, employeeId, startDate, endDate, cartId } = req.query;
    const query = await buildLeaveListQuery(req.user);

    if (employeeId) {
      query.employeeId = employeeId;
    }

    if (status) {
      query.status = String(status).toLowerCase();
    }

    if (cartId && ["super_admin", "franchise_admin"].includes(req.user.role)) {
      query.cartId = cartId;
    }

    const normalizedStartDate = parseLeaveDate(startDate);
    const normalizedEndDate = parseLeaveDate(endDate);

    if (normalizedStartDate || normalizedEndDate) {
      query.$and = query.$and || [];
      if (normalizedStartDate) {
        query.$and.push({ endDate: { $gte: normalizedStartDate } });
      }
      if (normalizedEndDate) {
        query.$and.push({ startDate: { $lte: normalizedEndDate } });
      }
      if (query.$and.length === 0) {
        delete query.$and;
      }
    }

    const requests = await LeaveRequest.find(query)
      .populate("employeeId", "name employeeRole mobile")
      .populate("requestedBy", "name role")
      .populate("reviewedBy", "name role")
      .sort({ createdAt: -1 })
      .lean();

    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.updateLeaveRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNote } = req.body;

    const normalizedStatus = String(status || "").toLowerCase();
    if (!["approved", "rejected", "cancelled"].includes(normalizedStatus)) {
      return res
        .status(400)
        .json({ message: "Status must be approved, rejected, or cancelled" });
    }

    const leaveRequest = await LeaveRequest.findById(id);
    if (!leaveRequest) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    const canManage = await canManageLeaveRequest(req.user, leaveRequest);
    if (!canManage) {
      return res.status(403).json({ message: "Access denied" });
    }

    leaveRequest.status = normalizedStatus;
    leaveRequest.reviewNote = String(reviewNote || "").trim();
    leaveRequest.reviewedBy = req.user._id;
    leaveRequest.reviewedAt = new Date();
    await leaveRequest.save();

    const employee = await Employee.findById(leaveRequest.employeeId).lean();
    const { today } = getISTDateRange();
    const includesToday =
      leaveRequest.startDate <= today && leaveRequest.endDate >= today;

    if (employee && includesToday) {
      if (normalizedStatus === "approved") {
        await EmployeeSchedule.findOneAndUpdate(
          { employeeId: employee._id },
          {
            $set: {
              employeeId: employee._id,
              cartId: employee.cartId || employee.cafeId,
              franchiseId: employee.franchiseId,
              todayState: "on_leave",
            },
          },
          { upsert: true, new: true }
        );

        await upsertTodayLeaveAttendance({ employee });
      } else {
        const hasAnotherApprovedLeave = await hasApprovedLeaveForToday(
          employee._id,
          leaveRequest._id
        );

        if (!hasAnotherApprovedLeave) {
          await EmployeeSchedule.findOneAndUpdate(
            { employeeId: employee._id },
            { $set: { todayState: "active" } },
            { new: true }
          );
        }
      }
    }

    await leaveRequest.populate("employeeId", "name employeeRole mobile");
    await leaveRequest.populate("requestedBy", "name role");
    await leaveRequest.populate("reviewedBy", "name role");

    return res.json({
      success: true,
      message: "Leave request updated",
      data: leaveRequest,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
