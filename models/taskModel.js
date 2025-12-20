const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "cancelled"],
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
    cafeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
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
taskSchema.index({ cafeId: 1, status: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ assignedToUser: 1, status: 1 });
taskSchema.index({ franchiseId: 1, status: 1 });
taskSchema.index({ dueDate: 1, status: 1 });

module.exports = mongoose.model("Task", taskSchema);

