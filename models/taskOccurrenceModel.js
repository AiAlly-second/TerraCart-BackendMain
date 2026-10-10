const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  cartId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  assignedToUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dueAt: { type: Date, required: true }, reminderAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'in_progress', 'completed', 'cancelled'], default: 'pending' },
  completedAt: { type: Date }, completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  reminderSentAt: { type: Date, default: null },
  reminderLeaseUntil: { type: Date, default: null },
  nextReminderAttemptAt: { type: Date, default: null },
  reminderAttempts: { type: Number, default: 0 },
}, { timestamps: true, autoIndex: true });
// Durable occurrence identity and the actual reminder worker query.
schema.index({ taskId: 1, dateKey: 1 }, { unique: true });
schema.index({ reminderSentAt: 1, status: 1, reminderAt: 1 });
module.exports = mongoose.model('TaskOccurrence', schema);
