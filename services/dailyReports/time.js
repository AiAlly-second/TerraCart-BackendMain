const { businessDateTime, getBusinessDateKey, dateKeyOffset } = require('../../utils/businessTime');
const TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';
if (TIMEZONE !== 'Asia/Kolkata') throw new Error('REPORT_TIMEZONE must be Asia/Kolkata');
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function nextRun(time, now = new Date()) {
  if (!validTime(time)) throw new RangeError('Time must be HH:mm');
  const day = getBusinessDateKey(now, TIMEZONE);
  const today = businessDateTime(day, time, TIMEZONE);
  return today > now ? today : businessDateTime(dateKeyOffset(1, day), time, TIMEZONE);
}
function period(cutoff) {
  return { start: businessDateTime(getBusinessDateKey(cutoff, TIMEZONE), '00:00', TIMEZONE), end: new Date(cutoff) };
}
const readableTime = instant => new Intl.DateTimeFormat('en-IN', {
  timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(instant));
module.exports = { TIMEZONE, validTime, nextRun, period, readableTime };
