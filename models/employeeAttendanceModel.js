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
      enum: ["present", "absent", "late", "half_day", "on_leave", "sick"],
      default: "present",
    },
    workingHours: {
      type: Number, // Total working hours in minutes
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
    // Hierarchy relationships
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

// Compound index to ensure one attendance record per employee per day
employeeAttendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeAttendance", employeeAttendanceSchema);













