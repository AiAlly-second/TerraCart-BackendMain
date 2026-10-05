// Dates are calendar keys; Mongo Date values are absolute UTC instants.
const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';
const ONE_DAY_MS = 86400000;
const formatters = new Map();
const formatter = (timezone) => {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return formatters.get(timezone);
};
const getBusinessTimezone = (context = {}) => context.businessTimezone || DEFAULT_BUSINESS_TIMEZONE;
const parseServerTimestamp = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Calendar date is not a timestamp');
  const raw = typeof value === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? `${value}Z` : value;
  const result = new Date(raw);
  if (Number.isNaN(result.getTime())) throw new RangeError('Invalid timestamp');
  return result;
};
const parts = (value, timezone = DEFAULT_BUSINESS_TIMEZONE) => Object.fromEntries(
  formatter(timezone).formatToParts(parseServerTimestamp(value)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])
);
const validateDateKey = (key) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return false;
  const date = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
};
const getBusinessDateKey = (value = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) => {
  if (typeof value === 'string' && validateDateKey(value)) return value;
  const p = parts(value, timezone);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
};
const dateKeyOffset = (days, value = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) => {
  const key = getBusinessDateKey(value, timezone);
  return new Date(new Date(`${key}T00:00:00Z`).getTime() + Number(days) * ONE_DAY_MS).toISOString().slice(0, 10);
};
// Convert wall-clock fields using the IANA zone's actual offset, independent of TZ.
const businessDateTime = (key, time = '00:00', timezone = DEFAULT_BUSINESS_TIMEZONE) => {
  if (!validateDateKey(key) || !/^\d{2}:\d{2}$/.test(time)) throw new RangeError('Invalid business date/time');
  const [year, month, day] = key.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new RangeError('Invalid business time');
  const wall = Date.UTC(year, month-1, day, hour, minute);
  let instant = wall;
  for (let i=0; i<4; i++) {
    const p = parts(new Date(instant), timezone);
    const correction = wall - Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    if (!correction) break;
    instant += correction;
  }
  return new Date(instant);
};
const businessDayQueryRange = (value = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) => {
  const dateKey = getBusinessDateKey(value, timezone);
  const dayIndex = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return {startUTC: businessDateTime(dateKey,'00:00',timezone), endUTC: businessDateTime(dateKeyOffset(1,dateKey),'00:00',timezone), dateKey, dayIndex,
    dayName: ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dayIndex]};
};
const getBusinessDayName = (value = new Date()) => businessDayQueryRange(value).dayName;
const scheduledTime = (value, time) => businessDateTime(getBusinessDateKey(value), time);
const attendanceDateKey = (record) => {
  if (validateDateKey(record.attendanceDateIST)) return record.attendanceDateIST;
  const value = record.checkIn?.time || record.checkInTime || record.date;
  return value ? getBusinessDateKey(value) : '';
};
const attendanceDayFilter = (value = new Date()) => {
  const range = businessDayQueryRange(value);
  return {$and: [{$or: [
    {attendanceDateIST: range.dateKey},
    {$and: [{$or: [{attendanceDateIST: ''}, {attendanceDateIST: null}]}, {date: {$gte: range.startUTC, $lt: range.endUTC}}]},
  ]}]};
};
// Compatibility for installations that explicitly configured a legacy fixed
// token-day offset. New/default installations use the IANA business timezone.
const legacyOffsetDayRange = (value, minutes) => {
  const offset = minutes * 60000;
  const shifted = new Date(value.getTime() + offset);
  const startUTC = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset);
  return {startUTC, endUTC: new Date(startUTC.getTime() + ONE_DAY_MS)};
};
const businessDayBoundary = (value, endOfDay = false) => {
  if (value == null || value === '') return null;
  try {
    const range = businessDayQueryRange(value);
    return endOfDay ? new Date(range.endUTC.getTime() - 1) : range.startUTC;
  } catch (_) { return null; }
};
const businessMonthRange = (year, month) => {
  const first = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  const next = new Date(Date.UTC(Number(year), Number(month), 1));
  const startUTC = businessDayQueryRange(first.toISOString().slice(0,10)).startUTC;
  const endUTC = businessDayQueryRange(next.toISOString().slice(0,10)).startUTC;
  return {startUTC, endUTC};
};
module.exports = {DEFAULT_BUSINESS_TIMEZONE, ONE_DAY_MS, getBusinessTimezone, parseServerTimestamp, validateDateKey, getBusinessDateKey, dateKeyOffset, businessDateTime, businessDayQueryRange, getBusinessDayName, scheduledTime, attendanceDateKey, attendanceDayFilter, legacyOffsetDayRange, businessDayBoundary, businessMonthRange, businessParts: parts};
