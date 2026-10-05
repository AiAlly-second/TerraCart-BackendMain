// Compatibility names for existing callers; all rules live in businessTime.
const time = require('./businessTime');
module.exports = {
  ...time,
  formatISTDateKey: time.getBusinessDateKey,
  getISTDayName: time.getBusinessDayName,
  getISTDayIndex: (value = new Date()) => time.businessDayQueryRange(value).dayIndex,
  getISTDateRange: time.businessDayQueryRange,
  getISTDateRangeFromDateKey: (key) => time.validateDateKey(key) ? time.businessDayQueryRange(key) : null,
  getISTDateKeyOffset: time.dateKeyOffset,
  getDelayToNextISTMidnightMs: (from = new Date()) => Math.max(1000, time.businessDayQueryRange(from).endUTC.getTime() - from.getTime()),
};
