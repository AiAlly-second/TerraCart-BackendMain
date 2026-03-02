const mongoose = require("mongoose");

const employeeAttendanceSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    checkIn: {
      time: { type: Date },
      location: { type: String }, // Optional: GPS location or IP-based location
      notes: { type: String },
    },
    checkOut: {
      time: { type: Date },
      location: { type: String },
      notes: { type: String },
    },
    status: {
      type: String,
      enum: [
        "present",
        "absent",
        "late",
        "half_day",
        "on_leave",
        "sick",
        "completed",
        "auto_closed",
      ],
      default: "present",
    },
    workingHours: {
      type: Number, // Total working hours in hours (decimal)
      default: 0,
    },
    totalWorkingMinutes: {
      type: Number, // Total working minutes (excluding breaks)
      default: 0,
    },
    overtime: {
      type: Number, // Overtime in minutes
      default: 0,
    },
    breakDuration: {
      type: Number, // Break duration in minutes
      default: 0,
    },
    breakStart: {
      type: Date, // When break started (temporary, cleared when break ends)
    },
    isOnBreak: {
      type: Boolean,
      default: false, // Indicates if employee is currently on break
    },
    attendanceStatus: {
      type: String,
      enum: ["not_checked_in", "checked_in", "on_break", "checked_out", "absent"],
      default: "not_checked_in",
      index: true,
    },
    checkInStatus: {
      type: String,
      enum: ["not_checked_in", "checked_in", "checked_out", "absent"],
      default: "not_checked_in",
      index: true,
    },
    canTakeBreak: {
      type: Boolean,
      default: false,
    },
    isCheckedOut: {
      type: Boolean,
      default: false,
      index: true,
    },
    autoCheckedOut: {
      type: Boolean,
      default: false,
      index: true,
    },
    pendingTasksAtCheckout: {
      type: Number,
      default: 0,
    },
    managerOverrideUsed: {
      type: Boolean,
      default: false,
    },
    managerOverrideBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    managerOverrideReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },
    breaks: [
      {
        breakStart: { type: Date },
        breakEnd: { type: Date },
        durationMinutes: { type: Number, default: 0 },
      },
    ],
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // IST day key (YYYY-MM-DD) for consistent "today" lookups and one-record-per-day rule
    attendanceDateIST: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

// Compound index to ensure one attendance record per employee per day (by date)
employeeAttendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });
// One record per employee per IST day (canonical for "today" lookups)
employeeAttendanceSchema.index({ employeeId: 1, attendanceDateIST: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("EmployeeAttendance", employeeAttendanceSchema);













