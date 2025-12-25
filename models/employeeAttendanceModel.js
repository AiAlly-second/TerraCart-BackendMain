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
      enum: ["present", "absent", "late", "half_day", "on_leave", "sick", "completed"],
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
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

// Compound index to ensure one attendance record per employee per day
employeeAttendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeAttendance", employeeAttendanceSchema);













