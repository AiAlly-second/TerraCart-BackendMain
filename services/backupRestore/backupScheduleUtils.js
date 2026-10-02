function parseIstScheduleTime(scheduleTimeIST) {
  const safe = String(scheduleTimeIST || "00:00").trim();
  const [h, m] = safe.split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return { hour: 0, minute: 0 };
  return { hour: Math.max(0, Math.min(23, h)), minute: Math.max(0, Math.min(59, m)) };
}

function getNowInIST() {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs);
}

function computeNextRunAt(job) {
  const { hour, minute } = parseIstScheduleTime(job.scheduleTimeIST);
  const nowIst = getNowInIST();
  const nextIst = new Date(nowIst);
  nextIst.setUTCHours(hour, minute, 0, 0);
  if (nextIst.getTime() <= nowIst.getTime()) {
    const addDays = job.frequency === "weekly" ? 7 : 1;
    nextIst.setUTCDate(nextIst.getUTCDate() + addDays);
  }
  return new Date(nextIst.getTime() - 5.5 * 60 * 60 * 1000);
}

module.exports = {
  parseIstScheduleTime,
  getNowInIST,
  computeNextRunAt,
};
