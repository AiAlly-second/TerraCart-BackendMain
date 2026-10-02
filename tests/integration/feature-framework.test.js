const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const { startIsolatedMongo, assertIsolatedTestDatabase } = require("../helpers/isolatedMongo");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "feature-fixture-secret";
const User = require("../../models/userModel");
const Franchise = require("../../models/franchiseModel");
const PlatformFeature = require("../../models/platformFeatureModel");
const FranchiseFeature = require("../../models/franchiseFeatureModel");
const Audit = require("../../models/featureChangeAuditModel");
const service = require("../../services/featureService");

const oid = () => new mongoose.Types.ObjectId();
let mongo;
let server;
let fixture;
const emitted = [];
const token = id => jwt.sign({ id: String(id), tokenVersion: 0 }, process.env.JWT_SECRET);
const api = async (method, route, userId, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token(userId)}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

before(async () => {
  mongo = await startIsolatedMongo();
  assertIsolatedTestDatabase(process.env.MONGO_URI);
  const superId = oid(), a = oid(), b = oid(), cartA = oid(), cartB = oid();
  await User.collection.insertMany([
    { _id: superId, name: "Super", email: "feature-super@test.invalid", password: "x", role: "super_admin" },
    { _id: a, name: "A", email: "feature-a@test.invalid", password: "x", role: "franchise_admin" },
    { _id: b, name: "B", email: "feature-b@test.invalid", password: "x", role: "franchise_admin" },
    { _id: cartA, name: "Cart A", email: "feature-cart-a@test.invalid", password: "x", role: "admin", franchiseId: a, isApproved: true },
    { _id: cartB, name: "Cart B", email: "feature-cart-b@test.invalid", password: "x", role: "admin", franchiseId: b, isApproved: true },
  ]);
  fixture = { superId, a, b, cartA, cartB, staffA: {} };
  for (const role of ["manager", "cook", "waiter", "captain", "employee"]) {
    const id = oid();
    await User.collection.insertOne({ _id: id, name: role, email: `feature-${role}@test.invalid`, password: "x", role, cafeId: cartA });
    fixture.staffA[role] = id;
  }
  const app = express();
  app.use(express.json());
  app.set("io", { to: rooms => ({ emit: (event, payload) => emitted.push({ rooms, event, payload }) }) });
  app.set("emitToFranchise", (_io, franchiseAdminId, event, payload) =>
    emitted.push({ rooms: `franchise:${franchiseAdminId}`, event, payload }));
  app.use("/api/features", require("../../routes/featureRoutes"));
  app.use("/api/admin", require("../../routes/adminFeatureRoutes"));
  server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("missing rows fail closed and dry-run seed writes nothing", async () => {
  const state = await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: fixture.a });
  assert.deepEqual(state.effective, { enabled: false, surfaces: { adminWeb: false, staffMobile: false } });
  assert.equal(await service.isFeatureEnabled({ featureKey: "inventory", franchiseAdminId: oid() }), false);
  const plan = await service.seedExistingInventoryFeatures();
  assert.equal(plan.dryRun, true);
  assert.equal(plan.platformCreate, true);
  assert.equal(plan.franchiseAdminIdsToCreate.length, 2);
  assert.equal(await PlatformFeature.countDocuments(), 0);
  assert.equal(await FranchiseFeature.countDocuments(), 0);
});

test("seed apply enables only existing franchise admins, is idempotent, and audits", async () => {
  const first = await service.seedExistingInventoryFeatures({ apply: true });
  assert.equal(first.dryRun, false);
  assert.equal((await PlatformFeature.findOne({ featureKey: "inventory" })).enabled, true);
  for (const franchiseAdminId of [fixture.a, fixture.b]) {
    const state = await service.getFeatureState({ featureKey: "inventory", franchiseAdminId });
    assert.deepEqual(state.effective, { enabled: true, surfaces: { adminWeb: true, staffMobile: true } });
  }
  assert.equal(await FranchiseFeature.countDocuments(), 2);
  assert.equal(await Audit.countDocuments(), 3);
  await service.seedExistingInventoryFeatures({ apply: true });
  assert.equal(await FranchiseFeature.countDocuments(), 2);
  assert.equal(await Audit.countDocuments(), 3);
});

test("new franchise defaults OFF without changing seeded franchises", async () => {
  const id = oid();
  await User.collection.insertOne({ _id: id, name: "New franchise", email: "feature-new@test.invalid", password: "x", role: "franchise_admin" });
  await service.createNewFranchiseDefaults(id);
  const state = await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: id });
  assert.deepEqual(state.stored, { enabled: false, surfaces: { adminWeb: false, staffMobile: false } });
  await service.seedExistingInventoryFeatures({ apply: true });
  assert.equal((await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: id })).effective.enabled, false);
  assert.equal(await Audit.countDocuments({ franchiseAdminId: id }), 1);
  fixture.newFranchise = id;
});

test("franchise, cart alias, and staff roles resolve only their authenticated franchise", async () => {
  const { a, b, cartA, cartB, staffA } = fixture;
  assert.equal(String(await service.resolveFranchiseAdminId({ _id: a, role: "franchise_admin" })), String(a));
  assert.equal(String(await service.resolveFranchiseAdminId({ _id: cartA, role: "admin", franchiseId: b })), String(a));
  assert.equal(String(await service.resolveFranchiseAdminId({ _id: cartA, role: "cart_admin", franchiseId: b })), String(a));
  assert.equal(String(await service.resolveFranchiseAdminId({ _id: cartB, role: "admin", franchiseId: a })), String(b));
  for (const [role, id] of Object.entries(staffA)) {
    assert.equal(String(await service.resolveFranchiseAdminId({ _id: id, role, cafeId: cartA, franchiseId: b })), String(a), role);
  }
  assert.equal(await service.resolveFranchiseAdminId({ _id: fixture.superId, role: "super_admin" }), null);
});

test("platform/franchise precedence and all four surface combinations preserve stored preferences", async () => {
  const { a, superId } = fixture;
  for (const platformEnabled of [true, false]) {
    await service.setPlatformFeature({ featureKey: "inventory", enabled: platformEnabled, changedBy: superId });
    for (const franchiseEnabled of [true, false]) {
      for (const web of [true, false]) for (const mobile of [true, false]) {
        await service.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: a,
          patch: { enabled: franchiseEnabled, surfaces: { adminWeb: web, staffMobile: mobile } }, changedBy: superId });
        const state = await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: a });
        assert.equal(state.effective.enabled, platformEnabled && franchiseEnabled);
        assert.deepEqual(state.stored.surfaces, { adminWeb: web, staffMobile: mobile });
        assert.deepEqual(state.effective.surfaces, {
          adminWeb: platformEnabled && franchiseEnabled && web,
          staffMobile: platformEnabled && franchiseEnabled && mobile,
        });
      }
    }
  }
  await service.setPlatformFeature({ featureKey: "inventory", enabled: true, changedBy: superId });
  await service.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: a,
    patch: { enabled: true, surfaces: { adminWeb: true, staffMobile: true } }, changedBy: superId });
});

test("authenticated feature read and Super Admin route authorization", async () => {
  const { a, cartA, superId } = fixture;
  const own = await api("GET", "/api/features", cartA);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.features.inventory, { enabled: true, surfaces: { adminWeb: true, staffMobile: true } });
  const superRead = await api("GET", "/api/features", superId);
  assert.deepEqual(superRead.body.features.inventory, { enabled: true });
  const platform = await api("GET", "/api/admin/features", superId);
  assert.equal(platform.status, 200);
  const franchise = await api("GET", `/api/admin/franchises/${a}/features`, superId);
  assert.equal(franchise.status, 200);
  for (const route of ["/api/admin/features", `/api/admin/franchises/${a}/features`]) {
    assert.equal((await api("GET", route, cartA)).status, 403);
  }
  assert.equal((await api("PATCH", "/api/admin/features/inventory", cartA, { enabled: false })).status, 403);
});

test("Super Admin API partial update preserves fields, audits, and emits after commit", async () => {
  const { a, superId } = fixture;
  const before = await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: a });
  const count = await Audit.countDocuments();
  const response = await api("PATCH", `/api/admin/franchises/${a}/features/inventory`, superId,
    { surfaces: { staffMobile: false } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.features.inventory.stored, { enabled: true,
    surfaces: { adminWeb: true, staffMobile: false } });
  const audit = await Audit.findOne({ franchiseAdminId: a }).sort({ createdAt: -1 }).lean();
  assert.deepEqual(audit.previousState, before.stored);
  assert.deepEqual(audit.newState, response.body.features.inventory.stored);
  assert.equal(String(audit.changedBy), String(superId));
  assert.equal(await Audit.countDocuments(), count + 1);
  assert(emitted.some(row => row.rooms === `franchise:${a}` && row.event === "feature:updated" && row.payload.surfaces.staffMobile === false));
  const platform = await api("PATCH", "/api/admin/features/inventory", superId, { enabled: false });
  assert.equal(platform.status, 200);
  assert.equal((await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: a })).effective.enabled, false);
  assert(emitted.some(row => Array.isArray(row.rooms) && row.event === "feature:updated" && row.payload.platformEnabled === false));
  const latest = await Audit.findOne({ scope: "platform" }).sort({ createdAt: -1 }).lean();
  assert.deepEqual(latest.newState, { enabled: false });
  await api("PATCH", "/api/admin/features/inventory", superId, { enabled: true });
});

test("bulk selected, all, and empty-target safeguards are auditable", async () => {
  const { a, b, superId, newFranchise } = fixture;
  const before = await Audit.countDocuments();
  const empty = await api("POST", "/api/admin/features/inventory/bulk", superId,
    { franchiseAdminIds: [], enabled: false });
  assert.equal(empty.status, 400);
  assert.equal(await Audit.countDocuments(), before);
  const selected = await api("POST", "/api/admin/features/inventory/bulk", superId,
    { franchiseAdminIds: [String(a), String(b)], surfaces: { adminWeb: false } });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.updated, 2);
  assert.equal((await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: newFranchise })).stored.enabled, false);
  assert.equal(await Audit.countDocuments(), before + 2);
  const bulkAudit = await Audit.find({ operationId: { $ne: null } }).sort({ createdAt: -1 }).limit(2).lean();
  assert.equal(bulkAudit.length, 2);
  assert.equal(String(bulkAudit[0].operationId), String(bulkAudit[1].operationId));
  const all = await api("POST", "/api/admin/features/inventory/bulk", superId,
    { all: true, enabled: false });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.updated, 3);
  for (const id of [a, b, newFranchise]) {
    assert.equal((await service.getFeatureState({ featureKey: "inventory", franchiseAdminId: id })).stored.enabled, false);
  }
  assert.equal(await Audit.countDocuments(), before + 5);
});

test("invalid targets and boolean payloads create no configuration or audit", async () => {
  const { a, cartA, superId } = fixture;
  const franchise = await Franchise.create({ name: "Fixture Franchise document", franchiseAdminId: a });
  const invalid = [String(franchise._id), String(oid()), String(cartA), "bad-id"];
  const count = await Audit.countDocuments();
  for (const id of invalid) {
    const result = await api("PATCH", `/api/admin/franchises/${id}/features/inventory`, superId, { enabled: true });
    assert([400, 404].includes(result.status), JSON.stringify(result));
    if (mongoose.Types.ObjectId.isValid(id)) {
      assert.equal(await FranchiseFeature.countDocuments({ franchiseAdminId: id }), 0);
    }
  }
  const badBulk = await api("POST", "/api/admin/features/inventory/bulk", superId,
    { franchiseAdminIds: [String(a), String(cartA)], enabled: true });
  assert.equal(badBulk.status, 404);
  const badBoolean = await api("PATCH", `/api/admin/franchises/${a}/features/inventory`, superId,
    { surfaces: { staffMobile: "true" } });
  assert.equal(badBoolean.status, 400);
  assert.equal(await Audit.countDocuments(), count);
});
