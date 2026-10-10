const Task = require('../models/taskModel');
const Occurrence = require('../models/taskOccurrenceModel');
const Employee = require('../models/employeeModel');
const User = require('../models/userModel');
const Schedule = require('../models/employeeScheduleModel');
const Attendance = require('../models/employeeAttendanceModel');
const { sendPushToUser } = require('./pushNotificationService');
const { getBusinessDateKey, businessDateTime, businessParts, validateDateKey, dateKeyOffset } = require('../utils/businessTime');
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const taskLog = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const idOf = (value) => value?._id || value;
const isRecurring = (task) => Boolean(task.frequency?.length || task.weekdaysISO?.length);
function normalizeRecurrence(data) {
  const frequency = data.frequency || [];
  if (!Array.isArray(frequency)) throw new RangeError('Invalid recurrence weekdays');
  const iso = data.weekdaysISO || frequency.map(day => DAYS.indexOf(day) + 1);
  if (!Array.isArray(frequency) || !Array.isArray(iso) || iso.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RangeError('Use weekdays 1 (Monday) through 7 (Sunday)');
  }
  const weekdaysISO = [...new Set(iso)].sort((a, b) => a - b);
  const timezone = data.timezone || 'Asia/Kolkata';
  if (timezone !== 'Asia/Kolkata') throw new RangeError('Unsupported business timezone');
  const lead = Number(data.reminderLeadMinutes ?? 5);
  if (!Number.isInteger(lead) || lead < 0 || lead > 1440) throw new RangeError('Invalid reminder lead time');
  let localDueTime = data.localDueTime;
  if (!localDueTime && data.dueDate) {
    const p = businessParts(data.dueDate);
    localDueTime = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }
  if (localDueTime) businessDateTime('2026-01-01', localDueTime, timezone);
  const recurrenceStartDate = data.recurrenceStartDate || (data.originalDueDate || data.dueDate
    ? getBusinessDateKey(data.originalDueDate || data.dueDate) : getBusinessDateKey());
  const recurrenceEndDate = data.recurrenceEndDate || null;
  if (!validateDateKey(recurrenceStartDate) || (recurrenceEndDate &&
    (!validateDateKey(recurrenceEndDate) || recurrenceEndDate < recurrenceStartDate))) throw new RangeError('Invalid recurrence dates');
  return { weekdaysISO, frequency: weekdaysISO.map(day => DAYS[day - 1]), timezone,
    reminderLeadMinutes: lead, localDueTime, recurrenceStartDate, recurrenceEndDate };
}
function occurrenceTimes(task, dateKey) {
  if (!validateDateKey(dateKey)) throw new RangeError('Invalid occurrence date');
  const recurrence = normalizeRecurrence(task);
  if (task.active === false || task.status === 'cancelled' ||
    (!isRecurring(task) && task.status === 'completed') || dateKey < recurrence.recurrenceStartDate ||
    (recurrence.recurrenceEndDate && dateKey > recurrence.recurrenceEndDate)) return null;
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay() || 7;
  if (isRecurring(task) && !recurrence.weekdaysISO.includes(weekday)) return null;
  if (!isRecurring(task) && (!task.dueDate || getBusinessDateKey(task.dueDate) !== dateKey)) return null;
  const dueAt = businessDateTime(dateKey, recurrence.localDueTime || '11:00', recurrence.timezone);
  return { dueAt, reminderAt: new Date(dueAt.getTime() - recurrence.reminderLeadMinutes * 60000) };
}
async function ensureOccurrence(task, dateKey) {
  // Wait for the unique identity index even on the first production request.
  // Model.init coalesces concurrent callers and does not rebuild existing indexes.
  await Occurrence.init();
  const times = occurrenceTimes(task, dateKey);
  if (!times || !task.cartId) return null;
  const query = { taskId: task._id, dateKey };
  const legacyCompleted = task.status === 'completed' && task.completedAt && getBusinessDateKey(task.completedAt) === dateKey;
  try {
    return await Occurrence.findOneAndUpdate(query, { $setOnInsert: {
      ...query, ...times, cartId: idOf(task.cartId), assignedTo: idOf(task.assignedTo),
      assignedToUser: idOf(task.assignedToUser), status: legacyCompleted ? 'completed' : 'pending',
      ...(legacyCompleted ? { completedAt: task.completedAt, completedBy: idOf(task.completedBy) } : {}),
    } }, { upsert: true, new: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Occurrence.findOne(query).lean();
  }
}
async function refreshTaskWindow(task, now = new Date()) {
  for (const dateKey of [getBusinessDateKey(now), dateKeyOffset(1, now)]) {
    const occurrence = await ensureOccurrence(task, dateKey);
    const times = occurrenceTimes(task, dateKey);
    if (occurrence && times && !['completed', 'cancelled'].includes(occurrence.status)) {
      await Occurrence.updateOne({ _id: occurrence._id, status: { $in: ['pending', 'in_progress'] } },
        { $set: { ...times, assignedTo: idOf(task.assignedTo), assignedToUser: idOf(task.assignedToUser) } });
    }
  }
}
function viewOccurrence(task, occurrence, now = new Date()) {
  const pending = !['completed', 'cancelled'].includes(occurrence.status);
  return { ...task, occurrenceId: occurrence._id, occurrenceDate: occurrence.dateKey,
    dueDate: occurrence.dueAt, reminderAt: occurrence.reminderAt,
    status: pending && occurrence.dueAt < now ? 'late' : occurrence.status,
    completedAt: occurrence.completedAt || null, completedBy: occurrence.completedBy || null };
}
async function withOccurrences(tasks, { dateKey = getBusinessDateKey(), now = new Date(), includeNonApplicable = false } = {}) {
  const result = [];
  for (const task of tasks) {
    if (!isRecurring(task)) { result.push(task); continue; }
    const occurrence = await ensureOccurrence(task, dateKey);
    if (occurrence) result.push(viewOccurrence(task, occurrence, now));
    else if (includeNonApplicable) result.push(task);
  }
  return result;
}
async function actionOccurrence(task, dateKey, now) {
  if (!validateDateKey(dateKey) || dateKey > getBusinessDateKey(now)) {
    throw new RangeError('Cannot complete a future task occurrence');
  }
  const occurrence = dateKey === getBusinessDateKey(now)
    ? await ensureOccurrence(task, dateKey)
    : await Occurrence.findOne({ taskId: task._id, dateKey, cartId: idOf(task.cartId) }).lean();
  if (!occurrence) throw new RangeError('No task occurrence on this date');
  if (occurrence.status === 'cancelled') throw new RangeError('Task occurrence is cancelled');
  return occurrence;
}
async function reopenOccurrence(task, dateKey, status = 'pending', now = new Date()) {
  if (!['pending', 'in_progress'].includes(status)) throw new RangeError('Invalid task occurrence status');
  const occurrence = await actionOccurrence(task, dateKey, now);
  const updated = await Occurrence.findOneAndUpdate({ _id: occurrence._id, status: { $ne: 'cancelled' } },
    { $set: { status, completedAt: null, completedBy: null } }, { new: true }).lean();
  return viewOccurrence(task.toObject ? task.toObject() : task, updated || occurrence, now);
}
async function completeOccurrence(task, dateKey, completedBy, now = new Date()) {
  const occurrence = await actionOccurrence(task, dateKey, now);
  const completed = await Occurrence.findOneAndUpdate({ _id: occurrence._id, status: { $nin: ['completed', 'cancelled'] } },
    { $set: { status: 'completed', completedAt: now, completedBy } }, { new: true }).lean();
  return viewOccurrence(task.toObject ? task.toObject() : task, completed || occurrence, now);
}
async function generateWindow(now = new Date(), shouldContinue = () => true) {
  const keys = [getBusinessDateKey(now), dateKeyOffset(1, now)];
  // Cursor avoids retaining every template/employee in a long-lived process.
  const cursor = Task.find({ active: { $ne: false }, status: { $ne: 'cancelled' }, dueDate: { $ne: null } }).lean().cursor();
  let generated = 0;
  for await (const task of cursor) {
    if (!shouldContinue()) break;
    for (const key of keys) if (await ensureOccurrence(task, key)) generated++;
  }
  return generated;
}
async function runTaskReminders({ now = new Date(), send = sendPushToUser } = {}) {
  const candidates = await Occurrence.find({ status: { $in: ['pending', 'in_progress'] },
    reminderSentAt: null, reminderAt: { $lte: now }, dueAt: { $gte: new Date(now.getTime() - 30 * 60000) },
    reminderAttempts: { $lt: 5 }, $and: [
      { $or: [{ reminderLeaseUntil: null }, { reminderLeaseUntil: { $lte: now } }] },
      { $or: [{ nextReminderAttemptAt: null }, { nextReminderAttemptAt: { $lte: now } }] },
    ] }).sort({ reminderAt: 1 }).limit(100).lean();
  let sent = 0, dispatchErrors = 0;
  for (const row of candidates) {
    const task = await Task.findById(row.taskId).lean();
    if (!task || !occurrenceTimes(task, row.dateKey)) continue;
    const claimed = await Occurrence.findOneAndUpdate({ _id: row._id, reminderSentAt: null,
      status: { $in: ['pending', 'in_progress'] },
      $or: [{ reminderLeaseUntil: null }, { reminderLeaseUntil: { $lte: now } }] },
      { $set: { reminderLeaseUntil: new Date(now.getTime() + 120000) }, $inc: { reminderAttempts: 1 } }, { new: true }).lean();
    if (!claimed) continue;
    let success = false;
    try {
      const employee = task.assignedTo ? await Employee.findById(task.assignedTo).select('userId cartId cafeId isActive').lean() : null;
      const employeeCart = employee?.cartId || employee?.cafeId;
      if (employeeCart && String(employeeCart) !== String(task.cartId)) throw new Error('ASSIGNEE_SCOPE_MISMATCH');
      if (employee?.isActive === false) throw new Error('INACTIVE_ASSIGNEE');
      if (employee) {
        const schedule = await Schedule.findOne({ employeeId: employee._id }).lean();
        const weekday = new Date(`${row.dateKey}T00:00:00Z`).getUTCDay() || 7;
        const day = schedule?.weeklySchedule?.find(value => value.day === DAYS[weekday - 1]);
        const todayState = row.dateKey === getBusinessDateKey(now) ? schedule?.todayState : null;
        const absent = await Attendance.exists({ employeeId: employee._id,
          attendanceDateIST: row.dateKey, status: { $in: ['absent', 'on_leave'] } });
        if (day?.isWorking === false || ['inactive', 'on_leave', 'sick'].includes(todayState) || absent) {
          throw new Error('ASSIGNEE_UNAVAILABLE');
        }
      }
      const userId = employee?.userId || task.assignedToUser;
      const user = userId ? await User.findById(userId).select('_id fcmToken cartId cafeId isActive').lean() : null;
      if (user && user.isActive !== false && String(user.cartId || user.cafeId) === String(task.cartId)) {
        const eventId = `task:${task._id}:${row.dateKey}`;
        const result = await send(user, { title: 'Task Reminder', body: task.title, dataOnly: true,
          data: { event: 'task:reminder', notificationType: 'task_reminder', eventId,
            title: 'Task Reminder', body: task.title, taskId: String(task._id),
            cartId: String(task.cartId), recipientUserId: String(user._id),
            occurrenceDate: row.dateKey, dueAt: row.dueAt.toISOString() } });
        success = Boolean(result?.success || result?.successCount > 0);
      }
    } catch (_) { dispatchErrors++; }
    await Occurrence.updateOne({ _id: claimed._id, reminderLeaseUntil: claimed.reminderLeaseUntil },
      { $set: { reminderLeaseUntil: null, ...(success ? { reminderSentAt: now } :
        { nextReminderAttemptAt: new Date(now.getTime() + Math.min(16, 2 ** (claimed.reminderAttempts - 1)) * 60000) }) } });
    if (success) sent++;
  }
  if (candidates.length) taskLog('task_reminders', { candidates: candidates.length, sent, dispatchErrors });
  return { candidates: candidates.length, sent };
}
let timer = null, started = false, running = null, generatedDate = null, reminderOptions = {}, lastTickErrorAt = 0;
function tick() {
  if (!started) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    const today = getBusinessDateKey();
    if (generatedDate !== today) {
      const generated = await generateWindow(new Date(), () => started);
      generatedDate = today;
      taskLog('task_window', { dateKey: today, generated });
    }
    if (started) await runTaskReminders(reminderOptions);
  })().catch(() => {
    if (Date.now() - lastTickErrorAt >= 60000) {
      lastTickErrorAt = Date.now();
      taskLog('task_scheduler_error');
    }
  }).finally(() => { running = null; });
  return running;
}
function startTaskReminderScheduler(options = {}) {
  if (started) return;
  reminderOptions = options;
  started = true; void tick();
  timer = setInterval(() => void tick(), 30000); timer.unref?.();
}
function stopTaskReminderScheduler() { started = false; clearInterval(timer); timer = null; return running; }
function invalidateTaskWindow() { generatedDate = null; }
module.exports = { DAYS, isRecurring, normalizeRecurrence, occurrenceTimes, ensureOccurrence,
  refreshTaskWindow, viewOccurrence, withOccurrences, completeOccurrence, reopenOccurrence, generateWindow, runTaskReminders,
  startTaskReminderScheduler, stopTaskReminderScheduler, invalidateTaskWindow };
