const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const toDate = (value) => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const toIST = (value = new Date()) => {
  const date = toDate(value);
  return new Date(date.getTime() + IST_OFFSET_MS);
};

const istToUTC = (value = new Date()) => {
  const date = toDate(value);
  return new Date(date.getTime() - IST_OFFSET_MS);
};

const formatISTDateKey = (value = new Date()) => {
  const istDate = toIST(value);
  const year = istDate.getFullYear();
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const day = String(istDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getISTDayIndex = (value = new Date()) => toIST(value).getDay();

const getISTDayName = (value = new Date()) => {
  const dayNames = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  return dayNames[getISTDayIndex(value)] || 'sunday';
};

const getISTDateRange = (value = new Date()) => {
  const ist = toIST(value);
  ist.setHours(0, 0, 0, 0);

  const startUTC = istToUTC(ist);
  const endUTC = new Date(startUTC.getTime() + ONE_DAY_MS);

  return {
    startUTC,
    endUTC,
    dateKey: formatISTDateKey(value),
    dayIndex: getISTDayIndex(value),
    dayName: getISTDayName(value),
  };
};

const getISTDateRangeFromDateKey = (dateKey) => {
  const normalized = String(dateKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const [year, month, day] = normalized.split('-').map((part) => Number(part));
  const startIST = new Date(year, month - 1, day, 0, 0, 0, 0);
  const startUTC = istToUTC(startIST);
  const endUTC = new Date(startUTC.getTime() + ONE_DAY_MS);

  return {
    startUTC,
    endUTC,
    dateKey: normalized,
    dayIndex: startIST.getDay(),
    dayName: getISTDayName(startUTC),
  };
};

const getISTDateKeyOffset = (daysOffset, from = new Date()) => {
  const ist = toIST(from);
  ist.setDate(ist.getDate() + Number(daysOffset || 0));
  return formatISTDateKey(istToUTC(ist));
};

const getDelayToNextISTMidnightMs = (from = new Date()) => {
  const now = toDate(from);
  const nowIST = toIST(now);
  const nextMidnightIST = new Date(nowIST);
  nextMidnightIST.setHours(24, 0, 0, 0);
  const nextMidnightUTC = istToUTC(nextMidnightIST);
  return Math.max(1000, nextMidnightUTC.getTime() - now.getTime());
};

module.exports = {
  IST_OFFSET_MS,
  ONE_DAY_MS,
  toIST,
  istToUTC,
  formatISTDateKey,
  getISTDayIndex,
  getISTDayName,
  getISTDateRange,
  getISTDateRangeFromDateKey,
  getISTDateKeyOffset,
  getDelayToNextISTMidnightMs,
};
