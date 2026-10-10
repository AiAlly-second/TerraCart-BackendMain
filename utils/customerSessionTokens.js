const { randomBytes } = require('node:crypto');

// Existing staff prefix/context remain; table ID and timestamp are not entropy.
const createStaffSessionToken = tableId => `STAFF_${tableId}_${Date.now()}_${randomBytes(24).toString('hex')}`;
module.exports = { createStaffSessionToken };
