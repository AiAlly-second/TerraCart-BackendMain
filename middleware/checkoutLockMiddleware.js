const Employee = require("../models/employeeModel");
const EmployeeAttendance = require("../models/employeeAttendanceModel");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MOBILE_ROLES = new Set(["waiter", "cook", "captain", "manager", "employee"]);

const getISTNow = () => {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MS);
};

const istToUTC = (istDate) => {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
};

const getISTDateRange = () => {
  const istNow = getISTNow();
  const istDate = new Date(istNow);
  istDate.setHours(0, 0, 0, 0);
  const today = istToUTC(istDate);
  const tomorrow = new Date(today);
  tomorrow.setTime(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
};

const getCurrentEmployee = async (user) => {
  if (!user) return null;

  if (user.employeeId) {
    const byId = await Employee.findById(user.employeeId).lean();
    if (byId) return byId;
  }

  const byUserId = await Employee.findOne({ userId: user._id }).lean();
  if (byUserId) return byUserId;

  if (!user.email) return null;
  return Employee.findOne({ email: user.email.toLowerCase() }).lean();
};

exports.blockActionsIfCheckedOut = async (req, res, next) => {
  try {
    if (!req.user || !MOBILE_ROLES.has(req.user.role)) {
      return next();
    }

    // Managers can continue supervisory actions even after their own checkout.
    if (req.user.role === "manager") {
      return next();
    }

    const employee = await getCurrentEmployee(req.user);
    if (!employee?._id) {
      return next();
    }

    const { today, tomorrow } = getISTDateRange();
    const employeeCartId = employee.cartId || employee.cafeId;
    const attendanceQuery = {
      employeeId: employee._id,
      date: { $gte: today, $lt: tomorrow },
    };

    if (employeeCartId) {
      attendanceQuery.$or = [
        { cartId: employeeCartId },
        { cafeId: employeeCartId },
      ];
    }

    const attendance = await EmployeeAttendance.findOne(attendanceQuery).lean();
    if (!attendance) {
      return next();
    }

    const isCheckedOut = Boolean(
      attendance.isCheckedOut ||
      attendance.checkOut?.time ||
      attendance.attendanceStatus === "checked_out"
    );

    if (!isCheckedOut) {
      return next();
    }

    return res.status(403).json({
      message: "You have checked out for today. Read-only mode active.",
      code: "CHECKED_OUT_READ_ONLY",
    });
  } catch (err) {
    return next(err);
  }
};
