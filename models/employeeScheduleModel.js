const mongoose = require("mongoose");

const dayScheduleSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      required: true,
    },
    startTime: { type: String, required: true }, // Format: "HH:mm" (e.g., "09:00")
    endTime: { type: String, required: true }, // Format: "HH:mm" (e.g., "17:00")
    isWorking: { type: Boolean, default: true },
  },
  { _id: false }
);

const employeeScheduleSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      unique: true,
      index: true,
    },
    weeklySchedule: [dayScheduleSchema],
    todayState: {
      type: String,
      enum: ["active", "inactive", "on_leave", "sick"],
      default: "active",
    },
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeSchedule", employeeScheduleSchema);













