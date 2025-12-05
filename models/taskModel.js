const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    category: {
      type: String,
      required: true,
      enum: ["daily", "weekly", "monthly", "compliance", "maintenance", "cleaning", "inventory", "other"],
      default: "daily",
      index: true,
    },
    frequency: {
      type: String,
      enum: ["daily", "weekly", "monthly", "one_time"],
      default: "daily",
      index: true,
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
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "overdue", "cancelled", "incomplete", "complete"],
      default: "pending",
      index: true,
    },
    dueDate: {
      type: Date,
      required: true,
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },
    completedAt: {
      type: Date,
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    notes: {
      type: String,
      trim: true,
    },
    // Hierarchy relationships for data isolation
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
taskSchema.index({ cafeId: 1, status: 1, dueDate: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ franchiseId: 1, category: 1 });

// Virtual for checking if task is overdue
taskSchema.virtual("isOverdue").get(function () {
  if (this.status === "completed" || this.status === "cancelled") {
    return false;
  }
  return this.dueDate < new Date();
});

// Pre-save middleware to update status to overdue if past due date
taskSchema.pre("save", function (next) {
  if (this.status !== "completed" && this.status !== "cancelled") {
    if (this.dueDate < new Date()) {
      this.status = "overdue";
    }
  }
  next();
});

module.exports = mongoose.model("Task", taskSchema);

