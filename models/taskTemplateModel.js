const mongoose = require('mongoose');

const taskTemplateSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    assignedRole: {
      type: String,
      enum: ['waiter', 'cook', 'captain', 'manager', 'employee', 'all'],
      default: 'all',
      index: true,
    },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'custom'],
      default: 'daily',
      index: true,
    },
    weeklyDays: {
      type: [Number],
      default: [],
      validate: {
        validator: (days) =>
          Array.isArray(days) && days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        message: 'weeklyDays must contain integers between 0 and 6',
      },
    },
    customDates: {
      type: [String],
      default: [],
      validate: {
        validator: (dates) =>
          Array.isArray(dates) &&
          dates.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim())),
        message: 'customDates must be in YYYY-MM-DD format',
      },
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

taskTemplateSchema.index(
  {
    cartId: 1,
    assignedRole: 1,
    active: 1,
  },
  {
    name: 'task_template_cart_role_active_idx',
  }
);

module.exports = mongoose.model('TaskTemplate', taskTemplateSchema);
