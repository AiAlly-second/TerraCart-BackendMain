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
      enum: ["present", "absent", "late", "half_day", "on_leave", "sick", "on_break", "completed"],
      default: "present",
    },
    isOnBreak: {
      type: Boolean,
      default: false,
    },
    breakStart: {
      type: Date,
    },
    breakEnd: {
      type: Date,
    },
    breakMinutes: {
      type: Number, // Total break duration in minutes
      default: 0,
    },
    totalWorkingMinutes: {
      type: Number, // Total working minutes (excluding breaks)
      default: 0,
    },
    workingHours: {
      type: Number, // Total working hours in minutes (deprecated, use totalWorkingMinutes)
      default: 0,
    },
    overtime: {
      type: Number, // Overtime in minutes
      default: 0,
    },
    breakDuration: {
      type: Number, // Break duration in minutes (deprecated, use breakMinutes)
      default: 0,
    },
    // Hierarchy relationships
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

// Compound index to ensure one attendance record per employee per day
employeeAttendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeAttendance", employeeAttendanceSchema);













