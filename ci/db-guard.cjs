'use strict';
// Test-process-only preload; application source is untouched.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const database = 'terracart_inventory_isolation_test';
function assertTarget(uri, options = {}) {
  assert.equal(process.env.NODE_ENV, 'test', 'CI_DATABASE_ENVIRONMENT_REQUIRED');
  let target;
  try { target = new URL(uri); } catch (_) { throw new Error('CI_DATABASE_TARGET_INVALID'); }
  assert.equal(target.protocol, 'mongodb:', 'CI_LOCAL_DATABASE_ONLY');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'CI_LOCAL_DATABASE_ONLY');
  assert.ok(!target.username && !target.password, 'CI_DATABASE_CREDENTIALS_FORBIDDEN');
  assert.ok(!target.hash && [...target.searchParams].every(([key, value]) =>
    key === 'replicaSet' && /^[a-zA-Z0-9_-]+$/.test(value)), 'CI_DATABASE_URI_OVERRIDES_FORBIDDEN');
  assert.ok(!options.auth && !options.authSource, 'CI_DATABASE_CREDENTIALS_FORBIDDEN');
  assert.equal(target.pathname, '/' + database, 'CI_TEST_DATABASE_NAME_REQUIRED');
  assert.ok(!options.dbName || options.dbName === database, 'CI_TEST_DATABASE_NAME_REQUIRED');
}
assertTarget(process.env.MONGO_URI || '');
for (const name of ['connect', 'createConnection']) {
  const original = mongoose[name];
  mongoose[name] = function(uri, options, ...rest) {
    assertTarget(uri, options);
    return original.call(this, uri, options, ...rest);
  };
}
module.exports = { assertTarget };
