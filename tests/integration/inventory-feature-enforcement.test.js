const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const { startIsolatedMongo, assertIsolatedTestDatabase } = require("../helpers/isolatedMongo");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "inventory-enforcement-fixture-secret";

const oid = () => new mongoose.Types.ObjectId();
const mockResponse = () => ({
  code: 200,
  body: null,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
const mockApp = { get(name) {
  if (name === "emitToCafe") return () => {};
  if (name === "emitToFranchise") return () => {};
  return null;
} };
const eventually = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Expected asynchronous side effect did not complete");
};

let mongo, server;
let User, Ingredient, Transaction, Recipe, MenuItem, Order, Payment, InventoryItem;
let featureService, orderController, paymentController, dashboardController, coordinator, orderConsumptionService;
let reconciliationService;
let fixture;

const token = id => jwt.sign({ id: String(id), tokenVersion: 0 }, process.env.JWT_SECRET);
const api = async (method, route, userId, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token(userId)}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

const makeMenu = async ({ cartId, franchiseId, name, qty, recipeQty = 3 }) => {
  const stock = await Ingredient.create({ name: `${name} stock`, category: "Other", uom: "pcs",
    cartId, franchiseId, qtyOnHand: qty, currentCostPerBaseUnit: 1 });
  const recipe = await Recipe.create({ name, cartId, franchiseId,
    portions: 1, ingredients: [{ ingredientId: stock._id, qty: recipeQty, uom: "pcs" }] });
  const menu = await MenuItem.create({ name, category: "Other", sellingPrice: 10, cartId, franchiseId, recipeId: recipe._id });
  return { stock, recipe, menu };
};

const reconcileFixture = async (franchiseAdminId, override = {}) => {
  const user = { _id: fixture.superId, role: "super_admin" };
  const state = await reconciliationService.getReconciliation({ user, franchiseAdminId });
  for (const cartId of [...new Set(state.items.map(item => String(item.cartId)))]) {
    const items = state.items.filter(item => String(item.cartId) === cartId && !item.confirmed)
      .map(item => ({ ...(item.kind === "legacy" ? { legacyItemId: item.legacyItemId } :
        { ingredientId: item.ingredientId }),
        physicalQty: override[String(item.legacyItemId || item.ingredientId)] ?? item.recordedQty }));
    if (items.length) await reconciliationService.submitReconciliation({ user, franchiseAdminId,
      cartId, items, note: "Isolated fixture physical count" });
  }
  return reconciliationService.submitReconciliation({ user, franchiseAdminId, finalize: true });
};

before(async () => {
  mongo = await startIsolatedMongo();
  assertIsolatedTestDatabase(process.env.MONGO_URI);

  User = require("../../models/userModel");
  Ingredient = require("../../models/costing-v2/ingredientModel");
  Transaction = require("../../models/costing-v2/inventoryTransactionModel");
  Recipe = require("../../models/costing-v2/recipeModel");
  MenuItem = require("../../models/costing-v2/menuItemModel");
  require("../../models/addonModel");
  Order = require("../../models/orderModel");
  ({ Payment } = require("../../models/paymentModel"));
  InventoryItem = require("../../models/inventoryModel");
  featureService = require("../../services/featureService");
  reconciliationService = require("../../services/inventoryReconciliationService");
  orderController = require("../../controllers/orderController");
  paymentController = require("../../controllers/paymentController");
  dashboardController = require("../../controllers/dashboardController");
  coordinator = require("../../services/costing-v2/orderInventoryCoordinator");
  orderConsumptionService = require("../../services/costing-v2/orderConsumptionService");

  const superId = oid(), franchiseA = oid(), franchiseB = oid(), franchiseM = oid();
  const cartA = oid(), cartB = oid(), cartM = oid();
  await User.collection.insertMany([
    { _id: superId, name: "Super", email: "enforce-super@test.invalid", password: "x", role: "super_admin" },
    { _id: franchiseA, name: "Franchise A", email: "enforce-fa@test.invalid", password: "x", role: "franchise_admin" },
    { _id: franchiseB, name: "Franchise B", email: "enforce-fb@test.invalid", password: "x", role: "franchise_admin" },
    { _id: franchiseM, name: "Franchise M", email: "enforce-fm@test.invalid", password: "x", role: "franchise_admin" },
    { _id: cartA, name: "Cart A", email: "enforce-ca@test.invalid", password: "x", role: "admin", franchiseId: franchiseA, isApproved: true },
    { _id: cartB, name: "Cart B", email: "enforce-cb@test.invalid", password: "x", role: "admin", franchiseId: franchiseB, isApproved: true },
    { _id: cartM, name: "Cart M", email: "enforce-cm@test.invalid", password: "x", role: "admin", franchiseId: franchiseM, isApproved: true },
  ]);

  await featureService.setPlatformFeature({ featureKey: "inventory", enabled: true, changedBy: superId });
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseA,
    patch: { enabled: true, surfaces: { adminWeb: true, staffMobile: true } }, changedBy: superId });
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseB,
    patch: { enabled: false, surfaces: { adminWeb: false, staffMobile: false } }, changedBy: superId });
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: true, surfaces: { adminWeb: true, staffMobile: true } }, changedBy: superId });

  fixture = { superId, franchiseA, franchiseB, franchiseM, cartA, cartB, cartM };

  const app = express();
  app.use(express.json());
  app.set("io", null);
  app.set("emitToCafe", () => {});
  app.set("emitToFranchise", () => {});
  app.use("/api/inventory/reconciliation", require("../../routes/inventoryReconciliationRoutes"));
  app.use("/api/inventory", require("../../routes/inventoryRoutes"));
  app.use("/api/costing-v2", require("../../routes/costing-v2Routes"));
  app.use("/api/voice-inventory", require("../../routes/voiceInventoryRoutes"));
  server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("direct Inventory APIs return FEATURE_DISABLED for a disabled franchise", async () => {
  const { cartB } = fixture;
  const fakeId = String(oid());
  const guardedCalls = [
    ["GET", "/api/inventory"],
    ["GET", "/api/inventory/stats"],
    ["GET", "/api/inventory/available-ingredients"],
    ["PATCH", `/api/inventory/${fakeId}/stock`, { quantity: 1 }],
    ["POST", "/api/inventory", { name: "x" }],
    ["GET", "/api/costing-v2/inventory"],
    ["GET", "/api/costing-v2/inventory/transactions"],
    ["GET", "/api/costing-v2/low-stock"],
    ["GET", "/api/costing-v2/waste"],
    ["POST", "/api/costing-v2/waste", { ingredientId: fakeId, qty: 1, uom: "pcs", reason: "spoilage" }],
    ["POST", "/api/costing-v2/inventory/consume", { ingredientId: fakeId, qty: 1, uom: "pcs" }],
    ["POST", "/api/costing-v2/inventory/return", { ingredientId: fakeId, qty: 1, uom: "pcs" }],
    ["POST", "/api/costing-v2/inventory/direct-purchase", { ingredientId: fakeId, qty: 1, uom: "pcs", unitPrice: 1 }],
    ["GET", "/api/costing-v2/diagnose-consumption"],
    ["GET", `/api/costing-v2/ingredients/${fakeId}/fifo-layers`],
    ["POST", `/api/costing-v2/purchases/${fakeId}/receive`, {}],
    ["POST", "/api/voice-inventory/create", { text: "add 5 kg tomato" }],
  ];
  for (const [method, route, body] of guardedCalls) {
    const result = await api(method, route, cartB, body);
    assert.equal(result.status, 403, `${method} ${route}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, "FEATURE_DISABLED", `${method} ${route}`);
  }
});

test("BOM/recipe/menu definition endpoints stay open for a disabled franchise", async () => {
  const { cartB } = fixture;
  for (const route of ["/api/costing-v2/ingredients", "/api/costing-v2/recipes", "/api/costing-v2/menu-items"]) {
    const result = await api("GET", route, cartB);
    assert.notEqual(result.status, 403, `${route}: ${JSON.stringify(result.body)}`);
  }
  // Voice parsing never writes stock and is not guarded.
  const parsed = await api("POST", "/api/voice-inventory/parse", cartB, { text: "add 5 kg tomato" });
  assert.notEqual(parsed.status, 403, JSON.stringify(parsed.body));
});

test("direct Inventory APIs are not blocked for an enabled franchise", async () => {
  const { cartA } = fixture;
  const fakeId = String(oid());
  const calls = [
    ["GET", "/api/inventory"],
    ["GET", "/api/costing-v2/inventory"],
    ["GET", "/api/costing-v2/low-stock"],
    ["POST", "/api/costing-v2/inventory/consume", { ingredientId: fakeId, qty: 1, uom: "pcs" }],
    ["POST", "/api/voice-inventory/create", { text: "add 5 kg tomato" }],
  ];
  for (const [method, route, body] of calls) {
    const result = await api(method, route, cartA, body);
    assert.notEqual(result.status, 403, `${method} ${route}: ${JSON.stringify(result.body)}`);
  }
});

test("order PREPARING/READY/COMPLETED succeed with Inventory OFF; no stock movement; re-enable does not catch up", async () => {
  const { cartB, franchiseB } = fixture;
  const { stock } = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Disabled meal", qty: 50 });
  const menu = (await MenuItem.findOne({ name: "Disabled meal", cartId: cartB }));

  const createRes = mockResponse();
  await orderController.createOrder({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartB, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
  assert.ok([200, 201].includes(createRes.code), JSON.stringify(createRes.body));
  const orderId = createRes.body._id || createRes.body.order?._id;
  assert.ok(orderId, JSON.stringify(createRes.body));

  for (const status of ["PREPARING", "READY", "COMPLETED"]) {
    const res = mockResponse();
    await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
      params: { id: orderId }, body: { status } }, res);
    assert.equal(res.code, 200, `${status}: ${JSON.stringify(res.body)}`);
  }
  await eventually(async () => {
    const order = await Order.findById(orderId).lean();
    return order?.inventoryProcessingState === "skipped_feature_disabled";
  });
  const skipped = await Order.findById(orderId).lean();
  assert.equal(skipped.inventoryDeducted, false);
  assert.ok(skipped.inventorySkippedAt);
  assert.equal(await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 50);

  // Re-enable Inventory for this franchise, then re-request the same terminal
  // status. This order must NOT silently start consuming stock now.
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseB,
    patch: { enabled: true, surfaces: { adminWeb: true, staffMobile: true } }, changedBy: fixture.superId });
  assert.equal((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseB })).effective.enabled, false);
  const replay = mockResponse();
  await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "COMPLETED" } }, replay);
  assert.equal(replay.code, 200);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 50);
  assert.equal((await Order.findById(orderId)).inventoryProcessingState, "skipped_feature_disabled");

  // Restore B to disabled for later tests in this file.
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseB,
    patch: { enabled: false, surfaces: { adminWeb: false, staffMobile: false } }, changedBy: fixture.superId });
});

test("add-ons with Inventory OFF succeed with no stock movement", async () => {
  const { cartB, franchiseB } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Disabled addon meal", qty: 30 });
  const createRes = mockResponse();
  await orderController.createOrder({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartB, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
  const orderId = createRes.body._id || createRes.body.order?._id;
  const addonRes = mockResponse();
  await orderController.updateOrderAddons({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { selectedAddons: [{ name: "Extra Cheese", price: 5, quantity: 1 }] } }, addonRes);
  assert.equal(addonRes.code, 200, JSON.stringify(addonRes.body));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await Transaction.countDocuments({ refId: orderId }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 30);
});

test("finalizeOrder with Inventory OFF completes the order and its own response reflects the skip", async () => {
  const { cartB, franchiseB } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Disabled finalize meal", qty: 45 });
  const createRes = mockResponse();
  await orderController.createOrder({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartB, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
  const orderId = createRes.body._id || createRes.body.order?._id;
  await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "PREPARING" } }, mockResponse());
  await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "READY" } }, mockResponse());
  await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "skipped_feature_disabled");

  const finalizeRes = mockResponse();
  await orderController.finalizeOrder({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId } }, finalizeRes);
  assert.equal(finalizeRes.code, 200, JSON.stringify(finalizeRes.body));
  assert.equal((await Order.findById(orderId)).status, "COMPLETED");
  // finalizeOrder awaits the coordinator and refreshes its own in-memory
  // fields before responding - the response payload itself must be accurate.
  assert.equal(finalizeRes.body.inventoryDeducted, false);
  assert.equal(finalizeRes.body.inventoryProcessingState, "skipped_feature_disabled");
  assert.equal(await Transaction.countDocuments({ refId: orderId }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 45);
});

test("manual payment fallback with Inventory OFF pays the order without touching stock", async () => {
  const { cartB, franchiseB } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Disabled fallback meal", qty: 20, recipeQty: 4 });
  const order = await Order.create({ _id: "enforce-payment-fallback-off", status: "COMPLETED", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartB, franchiseId: franchiseB,
    kotLines: [{ items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const payment = await Payment.create({ orderId: order._id, amount: 10, method: "CASH", status: "PENDING" });
  const res = mockResponse();
  await paymentController.markPaymentPaid({ user: { _id: cartB, role: "admin" }, params: { id: payment._id }, app: mockApp }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal((await Order.findById(order._id)).paymentStatus, "PAID");
  await eventually(async () => (await Order.findById(order._id)).inventoryProcessingState === "skipped_feature_disabled");
  assert.equal(await Transaction.countDocuments({ refId: order._id }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 20);
});

test("payment-first order with Inventory OFF: paid and released, later kitchen transition also skips", async () => {
  const { cartB, franchiseB } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Disabled payment-first meal", qty: 15, recipeQty: 2 });
  const order = await Order.create({ _id: "enforce-payment-first-off", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, paymentRequiredBeforeProceeding: true, serviceType: "TAKEAWAY", cartId: cartB, franchiseId: franchiseB,
    kotLines: [{ items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const payment = await Payment.create({ orderId: order._id, amount: 10, method: "CASH", status: "PENDING" });
  const res = mockResponse();
  await paymentController.markPaymentPaid({ user: { _id: cartB, role: "admin" }, params: { id: payment._id }, app: mockApp }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const paidOrder = await Order.findById(order._id);
  assert.equal(paidOrder.status, "NEW");
  assert.equal(paidOrder.paymentStatus, "PAID");
  assert.equal(paidOrder.paymentRequiredBeforeProceeding, false);
  assert.equal(paidOrder.inventoryDeducted, false);
  assert.equal(await Transaction.countDocuments({ refId: order._id }), 0);

  const prepRes = mockResponse();
  await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: order._id }, body: { status: "PREPARING" } }, prepRes);
  assert.equal(prepRes.code, 200, JSON.stringify(prepRes.body));
  await eventually(async () => (await Order.findById(order._id)).inventoryProcessingState === "skipped_feature_disabled");
  assert.equal(await Transaction.countDocuments({ refId: order._id }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 15);
});

test("dashboard stays up and skips the Inventory query entirely when disabled", async () => {
  const { cartB, cartA } = fixture;
  const originalCount = InventoryItem.countDocuments;
  InventoryItem.countDocuments = () => { throw new Error("InventoryItem query must not run when Inventory is disabled"); };
  try {
    const res = mockResponse();
    await dashboardController.getDashboardStats({ user: { _id: cartB, role: "admin" }, query: {} }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.lowStockItems, 0);
    for (const key of ["activeOrders", "todayRevenue", "pendingTasks", "pendingKOTs", "preparingKOTs",
      "readyKOTs", "completedUnpaid", "completedPaid", "todayAttendance", "occupiedTables", "totalTables",
      "availableTables", "pendingRequests"]) {
      assert.ok(Object.hasOwn(res.body.data, key), key);
    }
  } finally {
    InventoryItem.countDocuments = originalCount;
  }

  // Enabled franchise: the same query path must still run normally.
  const enabledRes = mockResponse();
  await dashboardController.getDashboardStats({ user: { _id: cartA, role: "admin" }, query: {} }, enabledRes);
  assert.equal(enabledRes.code, 200, JSON.stringify(enabledRes.body));
  assert.equal(typeof enabledRes.body.data.lowStockItems, "number");
});

test("mixed franchise mode: A deducts its own stock, B does not, isolation holds", async () => {
  const { cartA, franchiseA, cartB, franchiseB } = fixture;
  const a = await makeMenu({ cartId: cartA, franchiseId: franchiseA, name: "Mixed A meal", qty: 40 });
  const b = await makeMenu({ cartId: cartB, franchiseId: franchiseB, name: "Mixed B meal", qty: 40 });

  const createA = mockResponse();
  await orderController.createOrder({ user: { _id: cartA, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartA, items: [{ name: a.menu.name, quantity: 1, price: 10, menuItemId: a.menu._id }] } }, createA);
  const orderAId = createA.body._id || createA.body.order?._id;
  const createB = mockResponse();
  await orderController.createOrder({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartB, items: [{ name: b.menu.name, quantity: 1, price: 10, menuItemId: b.menu._id }] } }, createB);
  const orderBId = createB.body._id || createB.body.order?._id;

  await orderController.updateOrderStatus({ user: { _id: cartA, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderAId }, body: { status: "PREPARING" } }, mockResponse());
  await orderController.updateOrderStatus({ user: { _id: cartB, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderBId }, body: { status: "PREPARING" } }, mockResponse());

  await eventually(async () => (await Order.findById(orderAId)).inventoryProcessingState === "deducted");
  await eventually(async () => (await Order.findById(orderBId)).inventoryProcessingState === "skipped_feature_disabled");

  assert.equal((await Ingredient.findById(a.stock._id)).qtyOnHand, 37);
  assert.equal((await Ingredient.findById(b.stock._id)).qtyOnHand, 40);
  assert.equal(await Transaction.countDocuments({ refId: orderAId }), 1);
  assert.equal(await Transaction.countDocuments({ refId: orderBId }), 0);
});

test("global platform OFF overrides both franchises: orders still work, direct APIs blocked", async () => {
  const { superId, cartA, franchiseA } = fixture;
  await featureService.setPlatformFeature({ featureKey: "inventory", enabled: false, changedBy: superId });
  try {
    for (const cartId of [fixture.cartA, fixture.cartB]) {
      const result = await api("GET", "/api/costing-v2/inventory", cartId);
      assert.equal(result.status, 403, JSON.stringify(result.body));
    }
    const { stock, menu } = await makeMenu({ cartId: cartA, franchiseId: franchiseA, name: "Global off meal", qty: 25 });
    const createRes = mockResponse();
    await orderController.createOrder({ user: { _id: cartA, role: "admin" }, app: mockApp, headers: {},
      body: { serviceType: "TAKEAWAY", cartId: cartA, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
    const orderId = createRes.body._id || createRes.body.order?._id;
    const statusRes = mockResponse();
    await orderController.updateOrderStatus({ user: { _id: cartA, role: "admin" }, app: mockApp, headers: {},
      params: { id: orderId }, body: { status: "PREPARING" } }, statusRes);
    assert.equal(statusRes.code, 200, JSON.stringify(statusRes.body));
    await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "skipped_feature_disabled");
    assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 25);
  } finally {
    await featureService.setPlatformFeature({ featureKey: "inventory", enabled: true, changedBy: superId });
    if ((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseA })).reconciliation.required) {
      await reconcileFixture(franchiseA);
    }
  }
});

test("new franchise defaults to Inventory OFF: orders work, stock APIs blocked, without extra configuration", async () => {
  const newFranchiseId = oid();
  const newCartId = oid();
  await User.collection.insertMany([
    { _id: newFranchiseId, name: "Brand New Franchise", email: "enforce-new-fa@test.invalid", password: "x", role: "franchise_admin" },
    { _id: newCartId, name: "Brand New Cart", email: "enforce-new-ca@test.invalid", password: "x", role: "admin", franchiseId: newFranchiseId, isApproved: true },
  ]);
  await featureService.createNewFranchiseDefaults(newFranchiseId);

  const apiResult = await api("GET", "/api/costing-v2/inventory", newCartId);
  assert.equal(apiResult.status, 403, JSON.stringify(apiResult.body));

  const { stock, menu } = await makeMenu({ cartId: newCartId, franchiseId: newFranchiseId, name: "New franchise meal", qty: 60 });
  const createRes = mockResponse();
  await orderController.createOrder({ user: { _id: newCartId, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: newCartId, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
  assert.ok([200, 201].includes(createRes.code), JSON.stringify(createRes.body));
  const orderId = createRes.body._id || createRes.body.order?._id;
  const statusRes = mockResponse();
  await orderController.updateOrderStatus({ user: { _id: newCartId, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "PREPARING" } }, statusRes);
  assert.equal(statusRes.code, 200, JSON.stringify(statusRes.body));
  await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "skipped_feature_disabled");
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 60);
});

test("mid-order OFF KOT stays skipped; third KOT consumes only after physical reconciliation", async () => {
  const { cartM, cartB, franchiseM, superId } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartM, franchiseId: franchiseM, name: "Mid order meal", qty: 100 });
  const createRes = mockResponse();
  await orderController.createOrder({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartM, items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createRes);
  const orderId = createRes.body._id || createRes.body.order?._id;

  await orderController.updateOrderStatus({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "PREPARING" } }, mockResponse());
  await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "deducted");
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 97);
  assert.equal(await Transaction.countDocuments({ refId: orderId }), 1);

  // Disable Inventory mid-order and add a second KOT line.
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: false }, changedBy: superId });
  const kotRes = mockResponse();
  await orderController.addKot({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, kotRes);
  assert.equal(kotRes.code, 200, JSON.stringify(kotRes.body));
  await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "skipped_feature_disabled");
  // The first KOT's transaction remains; the second was never written.
  assert.equal(await Transaction.countDocuments({ refId: orderId }), 1);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 97);

  // Re-enable is pending until every active stock position is physically counted.
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: true }, changedBy: superId });
  assert.equal((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseM })).effective.enabled, false);
  const scopedRead = await api("GET", `/api/inventory/reconciliation?franchiseAdminId=${franchiseM}`, cartB);
  assert.equal(scopedRead.status, 403);
  const pending = await api("GET", `/api/inventory/reconciliation?franchiseAdminId=${franchiseM}`, superId);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.ok(pending.body.items.some(item => String(item.ingredientId) === String(stock._id)));
  const invalid = await api("POST", "/api/inventory/reconciliation", cartM,
    { cartId: cartM, items: [{ ingredientId: stock._id, physicalQty: -1 }], note: "Invalid" });
  assert.equal(invalid.status, 400);
  assert.equal(await Transaction.countDocuments({ ingredientId: stock._id, type: "ADJUSTMENT" }), 0);
  await reconcileFixture(franchiseM, { [String(stock._id)]: 82 });
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 82);
  assert.equal((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseM })).effective.enabled, true);
  const kot2Res = mockResponse();
  await orderController.addKot({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, kot2Res);
  assert.equal(kot2Res.code, 200, JSON.stringify(kot2Res.body));
  await eventually(async () => await Transaction.countDocuments({ refId: orderId }) === 2);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 79);
  assert.deepEqual((await Transaction.find({ refId: orderId }).select("notes").lean())
    .map(row => row.notes).sort(), ["KOT:0", "KOT:2"]);
});

test("three disabled orders never catch up; physical 82 becomes truth and only Order D deducts", async () => {
  const { cartM, franchiseM, superId } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartM, franchiseId: franchiseM,
    name: "Reconcile four orders meal", qty: 100, recipeQty: 3 });
  const shared = await Ingredient.create({ name: "Shared reconciled stock", category: "Other",
    uom: "pcs", cartId: null, franchiseId: franchiseM, qtyOnHand: 100,
    currentCostPerBaseUnit: 1 });
  const sharedRecipe = await Recipe.create({ name: "Shared reconciled meal", cartId: cartM,
    franchiseId: franchiseM, portions: 1,
    ingredients: [{ ingredientId: shared._id, qty: 3, uom: "pcs" }] });
  const sharedMenu = await MenuItem.create({ name: "Shared reconciled meal", category: "Other",
    sellingPrice: 10, cartId: cartM, franchiseId: franchiseM, recipeId: sharedRecipe._id });
  const legacy = await InventoryItem.create({ name: "Legacy counted item", category: "Other",
    unit: "piece", quantity: 15, cartId: cartM, franchiseId: franchiseM });
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: false }, changedBy: superId });
  const disabledIds = [];
  for (const name of ["A", "B", "C"]) {
    const created = mockResponse();
    await orderController.createOrder({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
      body: { serviceType: "TAKEAWAY", cartId: cartM,
        items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, created);
    assert.ok([200, 201].includes(created.code), `${name}: ${JSON.stringify(created.body)}`);
    const orderId = created.body._id || created.body.order?._id;
    disabledIds.push(orderId);
    const preparing = mockResponse();
    await orderController.updateOrderStatus({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
      params: { id: orderId }, body: { status: "PREPARING" } }, preparing);
    assert.equal(preparing.code, 200);
    await eventually(async () => (await Order.findById(orderId)).inventoryProcessingState === "skipped_feature_disabled");
  }
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 100);
  assert.equal(await Transaction.countDocuments({ refId: { $in: disabledIds } }), 0);
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: true }, changedBy: superId });
  assert.equal((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseM })).effective.enabled, false);
  await reconcileFixture(franchiseM, { [String(stock._id)]: 82,
    [String(shared._id)]: 12, [String(legacy._id)]: 9 });
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 82);
  assert.equal((await InventoryItem.findById(legacy._id)).quantity, 9);
  assert.equal(await require("../../models/inventoryTransactionModel").countDocuments({ inventoryItemId: legacy._id,
    changeType: "adjustment" }), 1);
  assert.equal(await Transaction.countDocuments({ refId: { $in: disabledIds } }), 0);
  const createdD = mockResponse();
  await orderController.createOrder({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartM,
      items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, createdD);
  const orderD = createdD.body._id || createdD.body.order?._id;
  await orderController.updateOrderStatus({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderD }, body: { status: "PREPARING" } }, mockResponse());
  await eventually(async () => (await Order.findById(orderD)).inventoryProcessingState === "deducted");
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 79);
  assert.equal(await Transaction.countDocuments({ refId: { $in: disabledIds } }), 0);
  assert.equal(await Transaction.countDocuments({ refId: orderD, type: "OUT" }), 1);
  assert.equal(await reconciliationService.recordedQuantity(shared, cartM), 12);
  const createdE = mockResponse();
  await orderController.createOrder({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartM,
      items: [{ name: sharedMenu.name, quantity: 1, price: 10, menuItemId: sharedMenu._id }] } }, createdE);
  const orderE = createdE.body._id || createdE.body.order?._id;
  await orderController.updateOrderStatus({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderE }, body: { status: "PREPARING" } }, mockResponse());
  await eventually(async () => (await Order.findById(orderE)).inventoryProcessingState === "deducted");
  assert.equal(await reconciliationService.recordedQuantity(shared, cartM), 9);
  assert.equal((await Ingredient.findById(shared._id)).qtyOnHand, 100);
});

test("order created OFF but prepared after reconciliation never consumes its old KOT", async () => {
  const { cartM, franchiseM, superId } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartM, franchiseId: franchiseM,
    name: "Created off prepared later meal", qty: 100, recipeQty: 3 });
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: false }, changedBy: superId });
  const created = mockResponse();
  await orderController.createOrder({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    body: { serviceType: "TAKEAWAY", cartId: cartM,
      items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }] } }, created);
  const orderId = created.body._id || created.body.order?._id;
  assert.equal((await Order.findById(orderId)).inventoryProcessingState, "skipped_feature_disabled");
  await featureService.setFranchiseFeature({ featureKey: "inventory", franchiseAdminId: franchiseM,
    patch: { enabled: true }, changedBy: superId });
  assert.equal((await featureService.getFeatureState({ featureKey: "inventory", franchiseAdminId: franchiseM })).effective.enabled, false);
  await reconcileFixture(franchiseM, { [String(stock._id)]: 82 });
  await orderController.updateOrderStatus({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { status: "PREPARING" } }, mockResponse());
  assert.equal(await Transaction.countDocuments({ refId: orderId, type: "OUT" }), 0);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 82);
  const newKot = mockResponse();
  await orderController.addKot({ user: { _id: cartM, role: "admin" }, app: mockApp, headers: {},
    params: { id: orderId }, body: { items: [{ name: menu.name, quantity: 1, price: 10,
      menuItemId: menu._id }] } }, newKot);
  assert.equal(newKot.code, 200);
  await eventually(async () => await Transaction.countDocuments({ refId: orderId, type: "OUT" }) === 1);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 79);
  assert.equal((await Transaction.findOne({ refId: orderId, type: "OUT" })).notes, "KOT:1");
});

test("feature lookup failure fails closed: direct API blocked, order flow skips without failing the sale", async () => {
  // A real, authenticated cart-admin whose franchiseId points at another
  // cart admin (not a franchise_admin) - resolveCartScope cannot resolve a
  // franchise for it, but the caller is genuinely authenticated.
  const brokenCartId = oid();
  await User.collection.insertOne({ _id: brokenCartId, name: "Broken Cart", email: "enforce-broken-cart@test.invalid",
    password: "x", role: "admin", franchiseId: fixture.cartA, isApproved: true });
  const apiResult = await api("GET", "/api/costing-v2/inventory", brokenCartId);
  assert.equal(apiResult.status, 403, JSON.stringify(apiResult.body));

  // An order somehow carrying an unresolvable cart must still complete its
  // status transition; Inventory is simply skipped and logged.
  const order = await Order.create({ _id: "enforce-broken-scope", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: brokenCartId, franchiseId: oid(),
    kotLines: [{ items: [{ name: "Ghost item", quantity: 1, price: 10 }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const result = await coordinator.maybeProcessInitialInventory({ order, userId: brokenCartId, trigger: "test_broken_scope" });
  assert.equal(result.processed, false);
  assert.equal(result.reason, "feature_disabled");
  assert.equal((await Order.findById(order._id)).inventoryDeducted, false);
});

test("resolved consumption failure and a thrown consumption error are both recorded as failed, never as success", async () => {
  const { cartA, franchiseA } = fixture;
  // Menu item with no linked recipe -> consumeIngredientsForOrder resolves { success:false, summary:{errors:[...]} }.
  const brokenMenu = await MenuItem.create({ name: "No recipe meal", category: "Other", sellingPrice: 10, cartId: cartA, franchiseId: franchiseA });
  const pendingOrder = await Order.create({ _id: "enforce-resolved-failure", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA,
    kotLines: [{ items: [{ name: brokenMenu.name, quantity: 1, price: 10, menuItemId: brokenMenu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const resolvedResult = await coordinator.maybeProcessInitialInventory({ order: pendingOrder, userId: cartA, trigger: "test_resolved_failure" });
  assert.equal(resolvedResult.processed, false);
  assert.equal(resolvedResult.outcome, "failed");
  const afterResolved = await Order.findById(pendingOrder._id);
  assert.equal(afterResolved.inventoryDeducted, false);
  assert.equal(afterResolved.inventoryProcessingState, "failed");

  // Thrown error path.
  const throwingOrder = await Order.create({ _id: "enforce-thrown-failure", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA,
    kotLines: [{ items: [{ name: "Anything", quantity: 1, price: 10 }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const original = orderConsumptionService.consumeIngredientsForOrder;
  orderConsumptionService.consumeIngredientsForOrder = async () => { throw new Error("simulated consumption crash"); };
  try {
    const thrownResult = await coordinator.maybeProcessInitialInventory({ order: throwingOrder, userId: cartA, trigger: "test_thrown_failure" });
    assert.equal(thrownResult.processed, false);
    assert.equal(thrownResult.outcome, "failed");
  } finally {
    orderConsumptionService.consumeIngredientsForOrder = original;
  }
  const afterThrown = await Order.findById(throwingOrder._id);
  assert.equal(afterThrown.inventoryDeducted, false);
  assert.equal(afterThrown.inventoryProcessingState, "failed");
});

test("two near-simultaneous initial attempts on the same pending order produce exactly one logical consumption", async () => {
  const { cartA, franchiseA } = fixture;
  const { stock, menu } = await makeMenu({ cartId: cartA, franchiseId: franchiseA, name: "Concurrent claim meal", qty: 50 });
  const order = await Order.create({ _id: "enforce-concurrent-claim", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA,
    kotLines: [{ items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });

  const [first, second] = await Promise.all([
    coordinator.maybeProcessInitialInventory({ order, userId: cartA, trigger: "concurrent_1" }),
    coordinator.maybeProcessInitialInventory({ order, userId: cartA, trigger: "concurrent_2" }),
  ]);
  const outcomes = [first, second];
  const claimedCount = outcomes.filter(result => result.reason !== "claim_unavailable").length;
  assert.equal(claimedCount, 1, JSON.stringify(outcomes));
  assert.equal(await Transaction.countDocuments({ refId: order._id }), 1);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 47);
  assert.equal((await Order.findById(order._id)).inventoryProcessingState, "deducted");
});

test("historical order missing inventoryProcessingState is interpreted, not backfilled", async () => {
  const { cartA, franchiseA } = fixture;
  await Order.collection.insertOne({ _id: "enforce-legacy-deducted", status: "COMPLETED", paymentStatus: "PAID",
    inventoryDeducted: true, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA, kotLines: [],
    createdAt: new Date(), updatedAt: new Date() });
  await Order.collection.insertOne({ _id: "enforce-legacy-pending", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA, kotLines: [],
    createdAt: new Date(), updatedAt: new Date() });
  const deductedRaw = await Order.collection.findOne({ _id: "enforce-legacy-deducted" });
  const pendingRaw = await Order.collection.findOne({ _id: "enforce-legacy-pending" });
  assert.equal(Object.hasOwn(deductedRaw, "inventoryProcessingState"), false);
  assert.equal(Object.hasOwn(pendingRaw, "inventoryProcessingState"), false);

  const deductedResult = await coordinator.maybeProcessInitialInventory(
    { order: await Order.findById("enforce-legacy-deducted"), userId: cartA, trigger: "legacy" });
  assert.equal(deductedResult.reason, "already_deducted");

  const pendingResult = await coordinator.maybeProcessInitialInventory(
    { order: await Order.findById("enforce-legacy-pending"), userId: cartA, trigger: "legacy" });
  assert.notEqual(pendingResult.reason, "skipped_feature_disabled");
});
