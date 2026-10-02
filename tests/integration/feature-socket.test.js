const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { io: connect } = require("socket.io-client");
const { startIsolatedMongo, assertIsolatedTestDatabase } = require("../helpers/isolatedMongo");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "socket-feature-test-secret";
process.env.BACKEND_ENABLE_CONSOLE_LOGS = "true";
const User = require("../../models/userModel");
const featureService = require("../../services/featureService");
const oid = () => new mongoose.Types.ObjectId();
let mongo, server, io, fixture;
const clients = [];
const token = id => jwt.sign({ id: String(id), tokenVersion: 0 }, process.env.JWT_SECRET);
const eventually = async predicate => {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Socket room/event did not arrive");
};
const connection = async userId => {
  const client = connect(`http://127.0.0.1:${server.address().port}`, {
    auth: { token: token(userId) }, transports: ["websocket"], reconnection: false,
  });
  clients.push(client);
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
};
const rooms = client => io.sockets.sockets.get(client.id)?.rooms || new Set();

before(async () => {
  mongo = await startIsolatedMongo();
  assertIsolatedTestDatabase(process.env.MONGO_URI);
  const a = oid(), b = oid(), cartA = oid(), cartB = oid(), superId = oid();
  const rows = [
    { _id: a, name: "A", email: "socket-a@test.invalid", role: "franchise_admin" },
    { _id: b, name: "B", email: "socket-b@test.invalid", role: "franchise_admin" },
    { _id: cartA, name: "Cart A", email: "socket-carta@test.invalid", role: "admin", franchiseId: a },
    { _id: cartB, name: "Cart B", email: "socket-cartb@test.invalid", role: "admin", franchiseId: b },
    { _id: superId, name: "Super", email: "socket-super@test.invalid", role: "super_admin" },
  ];
  fixture = { a, b, cartA, cartB, superId, staff: {} };
  for (const role of ["manager", "cook", "waiter", "captain", "employee"]) {
    const id = oid();
    rows.push({ _id: id, name: role, email: `socket-${role}@test.invalid`, role, cafeId: cartA,
      franchiseId: b }); // Deliberately forged/stale user field; DB cart assignment wins.
    fixture.staff[role] = id;
  }
  await User.collection.insertMany(rows.map(row => ({ ...row, password: "x" })));
  await featureService.seedExistingInventoryFeatures({ apply: true });
  ({ server, io } = require("../../server"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  clients.forEach(client => client.disconnect());
  if (io) await new Promise(resolve => io.close(resolve));
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

for (const [label, fixtureId] of [
  ["franchise admin", () => fixture.a], ["cart admin", () => fixture.cartA],
  ...["manager", "cook", "waiter", "captain"].map(role => [role, () => fixture.staff[role]]),
]) {
  test(`${label} auto-joins its franchise and cannot join another`, async () => {
    const client = await connection(fixtureId());
    await eventually(() => rooms(client).has(`franchise:${fixture.a}`));
    client.emit("join:franchise", String(fixture.b));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(rooms(client).has(`franchise:${fixture.b}`), false);
    assert.equal(rooms(client).has(`franchise:${fixture.a}`), true);
  });
}

test("feature update reaches the affected franchise room and global update reaches staff roles", async () => {
  const client = await connection(fixture.staff.employee);
  await eventually(() => rooms(client).has(`franchise:${fixture.a}`));
  const received = [];
  client.on("feature:updated", payload => received.push(payload));
  const patch = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/franchises/${fixture.a}/features/inventory`, {
    method: "PATCH", headers: { authorization: `Bearer ${token(fixture.superId)}`,
      "content-type": "application/json" }, body: JSON.stringify({ surfaces: { staffMobile: false } }),
  });
  assert.equal(patch.status, 200);
  await eventually(() => received.some(payload => payload.featureKey === "inventory" &&
    payload.surfaces?.staffMobile === false));
  const global = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/features/inventory`, {
    method: "PATCH", headers: { authorization: `Bearer ${token(fixture.superId)}`,
      "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(global.status, 200);
  await eventually(() => received.some(payload => payload.refetch === true && payload.platformEnabled === false));
});
