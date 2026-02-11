const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    taskId: {
      type: String,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    assignedBy: {
      type: String,
      enum: ["admin", "self"],
      default: "self",
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "cancelled", "late", "half_day"],
      default: "pending",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      index: true,
    },
    assignedToUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    dueDate: { type: Date },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    notes: { type: String },
    // Hierarchy relationships
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // Changed from cafeId to cartId
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Task category/type - More specific categories
    category: {
      type: String,
      enum: [
        "cleaning",
        "maintenance",
        "inventory",
        "service",
        "food_preparation",
        "safety",
        "other",
      ],
      default: "other",
    },
    // Frequency for recurring tasks (days of week)
    frequency: {
      type: [{
        type: String,
        enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      }],
      default: [],
    },
    // Original due date (for recurring tasks)
    originalDueDate: { type: Date },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
taskSchema.index({ cartId: 1, status: 1 }); // Changed from cafeId to cartId
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ assignedToUser: 1, status: 1 });
taskSchema.index({ franchiseId: 1, status: 1 });
taskSchema.index({ dueDate: 1, status: 1 });

taskSchema.pre("save", function ensureTaskId(next) {
  if (!this.taskId) {
    this.taskId = this._id.toString();
  }
  next();
});

module.exports = mongoose.model("Task", taskSchema);

