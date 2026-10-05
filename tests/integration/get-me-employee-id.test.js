const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "get-me-fixture-secret";

const Employee = require("../../models/employeeModel");
const User = require("../../models/userModel");
const { getMe } = require("../../controllers/userController");

/**
 * Regression: GET /api/users/me omitted `employeeId` for staff accounts whose
 * User.role is already the staff role ("manager", "waiter", ...), which is how
 * employeeController creates them. The mobile app needs that id to find its own
 * row in the cart-wide /api/attendance/today list, so a manager who was
 * already checked in saw "Not checked in" and Check In failed with
 * ALREADY_CHECKED_IN.
 */

const original = {
  employeeFindOne: Employee.findOne,
  userFindById: User.findById,
};

const chain = (value) => ({
  select() {
    return this;
  },
  lean: async () => value,
});

let employeeLookups;

const stubEmployees = (resolver) => {
  employeeLookups = [];
  Employee.findOne = (query) => {
    employeeLookups.push(query);
    return chain(resolver(query));
  };
};

beforeEach(() => {
  // franchise / cart name lookups are irrelevant to this contract
  User.findById = () => chain(null);
});

afterEach(() => {
  Employee.findOne = original.employeeFindOne;
  User.findById = original.userFindById;
});

const call = async (user) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  await getMe({ user }, res);
  return { statusCode, payload };
};

const staffUser = (overrides = {}) => ({
  _id: "user-1",
  name: "Tushar",
  email: "Manager@Example.test",
  role: "manager",
  cafeId: "cart-1",
  cartId: "cart-1",
  isActive: true,
  ...overrides,
});

test("a manager account (User.role = manager) gets its employeeId", async () => {
  stubEmployees((query) => (query.userId ? { _id: "employee-77" } : null));
  const { payload } = await call(staffUser());
  assert.equal(payload.success, true);
  assert.equal(payload.user.role, "manager");
  assert.equal(payload.user.employeeId, "employee-77");
});

for (const role of ["waiter", "cook", "captain"]) {
  test(`${role} accounts get their employeeId too`, async () => {
    stubEmployees(() => ({ _id: "employee-9" }));
    const { payload } = await call(staffUser({ role }));
    assert.equal(payload.user.employeeId, "employee-9");
  });
}

test("resolves by userId first, so it matches what checkIn() writes", async () => {
  stubEmployees((query) => (query.userId ? { _id: "by-user-id" } : { _id: "by-email" }));
  const { payload } = await call(staffUser({ employeeId: "stale-link" }));
  assert.equal(payload.user.employeeId, "by-user-id");
  assert.deepEqual(employeeLookups[0], { userId: "user-1" });
});

test("falls back to the lower-cased email, then to the stored link", async () => {
  stubEmployees((query) => (query.email ? { _id: "by-email" } : null));
  let { payload } = await call(staffUser());
  assert.equal(payload.user.employeeId, "by-email");
  assert.equal(employeeLookups[1].email, "manager@example.test");

  stubEmployees(() => null);
  ({ payload } = await call(staffUser({ employeeId: "stored-link" })));
  assert.equal(payload.user.employeeId, "stored-link");
});

test("no Employee record and no stored link: field stays absent", async () => {
  stubEmployees(() => null);
  const { payload } = await call(staffUser());
  assert.equal("employeeId" in payload.user, false);
});

test("admins are untouched: no employee lookup, no employeeId", async () => {
  stubEmployees(() => {
    throw new Error("admins must not trigger an Employee lookup");
  });
  const { payload } = await call(staffUser({ role: "admin" }));
  assert.equal("employeeId" in payload.user, false);
  assert.equal(employeeLookups.length, 0);
});

test("legacy role=employee accounts still resolve role and employeeId", async () => {
  stubEmployees(() => ({
    _id: "employee-1",
    employeeRole: "manager",
    cartId: "cart-2",
    franchiseId: "fr-1",
  }));
  const { payload } = await call(staffUser({ role: "employee" }));
  assert.equal(payload.user.role, "manager");
  assert.equal(payload.user.employeeId, "employee-1");
  assert.equal(payload.user.cartId, "cart-2");
});
