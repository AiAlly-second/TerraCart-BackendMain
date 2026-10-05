const msBetween = (start, end) => Math.max(0, new Date(end).getTime() - new Date(start).getTime()) || 0;
const completedBreakMs = (record) => {
  let exact = 0, coveredMinutes = 0;
  for (const entry of record.breaks || []) {
    if (!entry.breakStart || !entry.breakEnd) continue;
    const ms = msBetween(entry.breakStart, entry.breakEnd);
    exact += ms;
    coveredMinutes += Number(entry.durationMinutes ?? Math.floor(ms / 60000));
  }
  const legacyMinutes = Math.max(0, Number(record.breakDuration ?? record.breakMinutes ?? 0) - coveredMinutes);
  return exact + legacyMinutes * 60000;
};
const attendanceDurations = (record, now = new Date()) => {
  const start = record.checkIn?.time || record.checkInTime;
  const end = record.checkOut?.time || record.checkOutTime || now;
  const activeBreakMs = record.breakStart ? msBetween(record.breakStart, end) : 0;
  const breakMs = completedBreakMs(record) + activeBreakMs;
  return {breakMs, activeBreakMs, workingMs: start ? Math.max(0, msBetween(start, end) - breakMs) : 0};
};
const closeBreakUpdate = (record, end) => {
  if (!record.breakStart) return {breakDuration: Number(record.breakDuration || 0), breaks: record.breaks || []};
  const durationMinutes = Math.floor(msBetween(record.breakStart, end) / 60000);
  return {breakDuration: Number(record.breakDuration || 0) + durationMinutes,
    breaks: [...(record.breaks || []), {breakStart: record.breakStart, breakEnd: end, durationMinutes}]};
};
module.exports = {msBetween, completedBreakMs, attendanceDurations, closeBreakUpdate};
