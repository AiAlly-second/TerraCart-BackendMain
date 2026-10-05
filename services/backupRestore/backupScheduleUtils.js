const {businessDateTime, getBusinessDateKey, dateKeyOffset} = require('../../utils/businessTime');
function parseIstScheduleTime(scheduleTimeIST) {
  const safe = String(scheduleTimeIST || "00:00").trim();
  const [h, m] = safe.split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return { hour: 0, minute: 0 };
  return { hour: Math.max(0, Math.min(23, h)), minute: Math.max(0, Math.min(59, m)) };
}

function computeNextRunAt(job, now = new Date()) {
  const { hour, minute } = parseIstScheduleTime(job.scheduleTimeIST);
  const time = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  let key = getBusinessDateKey(now);
  let next = businessDateTime(key, time);
  if (next <= now) {
    key = dateKeyOffset(job.frequency === 'weekly' ? 7 : 1, key);
    next = businessDateTime(key, time);
  }
  return next;
}

module.exports = {
  parseIstScheduleTime,
  computeNextRunAt,
};
