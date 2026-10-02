const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { startIsolatedMongo, assertIsolatedTestDatabase } = require("../helpers/isolatedMongo");

process.env.NODE_ENV = "test";
let mongo;
let User;
let Ingredient;
let Transaction;
let Recipe;
let MenuItem;
let InventoryItem;
let Purchase;
let Order;
let Payment;
let orderController;
let paymentController;
let dashboardController;
let notificationEvents;
let FIFOService;
let Preparation;
let preparationController;
let WeightedAverageService;
let consumeIngredientsForOrder;
let costingController;
let inventoryController;
let buildCostingQuery;
let fixture;

const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const mockResponse = () => ({
  code: 200,
  body: null,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
const mockApp = { get(name) {
  if (name === "emitToCafe") return () => {};
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

before(async () => {
  mongo = await startIsolatedMongo();
  assertIsolatedTestDatabase(process.env.MONGO_URI);
  User = require("../../models/userModel");
  Ingredient = require("../../models/costing-v2/ingredientModel");
  Transaction = require("../../models/costing-v2/inventoryTransactionModel");
  Recipe = require("../../models/costing-v2/recipeModel");
  MenuItem = require("../../models/costing-v2/menuItemModel");
  require("../../models/addonModel");
  InventoryItem = require("../../models/inventoryModel");
  Purchase = require("../../models/costing-v2/purchaseModel");
  Order = require("../../models/orderModel");
  ({ Payment } = require("../../models/paymentModel"));
  WeightedAverageService = require("../../services/costing-v2/weightedAverageService");
  ({ consumeIngredientsForOrder } = require("../../services/costing-v2/orderConsumptionService"));
  costingController = require("../../controllers/costing-v2/costingController");
  inventoryController = require("../../controllers/inventoryController");
  orderController = require("../../controllers/orderController");
  paymentController = require("../../controllers/paymentController");
  dashboardController = require("../../controllers/dashboardController");
  notificationEvents = require("../../services/notificationEventService");
  FIFOService = require("../../services/costing-v2/fifoService");
  Preparation = require("../../models/costing-v2/preparationModel");
  preparationController = require("../../controllers/costing-v2/preparationController");
  ({ buildCostingQuery } = require("../../utils/costing-v2/accessControl"));

  const franchiseA = oid(), franchiseB = oid(), cartA = oid(), cartB = oid(),
    cartA2 = oid(), managerA = oid();
  await User.collection.insertMany([
    { _id: franchiseA, name: "Franchise A", email: "fixture-fa@test.invalid", password: "test", role: "franchise_admin" },
    { _id: franchiseB, name: "Franchise B", email: "fixture-fb@test.invalid", password: "test", role: "franchise_admin" },
    { _id: cartA, name: "Cart A", email: "fixture-ca@test.invalid", password: "test", role: "admin", franchiseId: franchiseA },
    { _id: cartA2, name: "Cart A2", email: "fixture-ca2@test.invalid", password: "test", role: "admin", franchiseId: franchiseA },
    { _id: cartB, name: "Cart B", email: "fixture-cb@test.invalid", password: "test", role: "admin", franchiseId: franchiseB },
    { _id: managerA, name: "Manager A", email: "fixture-ma@test.invalid", password: "test", role: "manager", cafeId: cartA },
  ]);
  // Phase 03 wires Inventory enforcement on top of Phase 02's fail-closed
  // default (missing feature config = disabled). This fixture predates the
  // feature framework and its order/dashboard assertions assume Inventory is
  // ON, exactly like the Phase 02 seed script guarantees for real existing
  // franchises - so seed it here the same way.
  const featureService = require("../../services/featureService");
  await featureService.seedExistingInventoryFeatures({ apply: true });
  const ownA = await Ingredient.create({ name: "Fixture A own", category: "Other", uom: "pcs", cartId: cartA, franchiseId: franchiseA, qtyOnHand: 10, currentCostPerBaseUnit: 2 });
  const sharedA = await Ingredient.create({ name: "Fixture A shared", category: "Other", uom: "pcs", cartId: null, franchiseId: franchiseA, qtyOnHand: 0 });
  const ownA2 = await Ingredient.create({ name: "Fixture A2 own", category: "Other", uom: "pcs", cartId: cartA2, franchiseId: franchiseA, qtyOnHand: 5 });
  const ownB = await Ingredient.create({ name: "Fixture B own", category: "Other", uom: "pcs", cartId: cartB, franchiseId: franchiseB, qtyOnHand: 8 });
  const sharedB = await Ingredient.create({ name: "Fixture B shared", category: "Other", uom: "pcs", cartId: null, franchiseId: franchiseB, qtyOnHand: 7 });
  const global = await Ingredient.create({ name: "Fixture global template", category: "Other", uom: "pcs", cartId: null, franchiseId: null, qtyOnHand: 0 });
  fixture = { franchiseA, franchiseB, cartA, cartA2, cartB, managerA, ownA, sharedA, ownA2, ownB, sharedB, global };
});

after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("test database guard rejects non-test and Atlas URIs", () => {
  assert.throws(() => assertIsolatedTestDatabase("mongodb+srv://example.invalid/TerraCart"), /ISOLATED_TEST_DATABASE_REQUIRED|Invalid URL/);
  assert.throws(() => assertIsolatedTestDatabase("mongodb://127.0.0.1:27017/TerraCart"), /ISOLATED_TEST_DATABASE_REQUIRED/);
});

test("ingredient query shows own and same-franchise shared only", async () => {
  const { cartA, ownA, sharedA, ownA2, ownB, sharedB, global } = fixture;
  const query = await buildCostingQuery({ _id: cartA, role: "admin" }, {}, { includeShared: true });
  const ids = (await Ingredient.find(query).select("_id").lean()).map(x => x._id);
  assert(ids.some(x => same(x, ownA._id)));
  assert(ids.some(x => same(x, sharedA._id)));
  for (const blocked of [ownA2, ownB, sharedB, global]) assert(!ids.some(x => same(x, blocked._id)));
});

test("Cart B reads only B-owned operational ingredients", async () => {
  const { cartB, ownA, sharedA, ownB, sharedB, global } = fixture;
  const query = await buildCostingQuery({ _id: cartB, role: "admin" }, {}, { includeShared: true });
  const ids = (await Ingredient.find(query).select("_id").lean()).map(x => x._id);
  for (const allowed of [ownB, sharedB]) assert(ids.some(x => same(x, allowed._id)));
  for (const blocked of [ownA, sharedA, global]) assert(!ids.some(x => same(x, blocked._id)));
});

test("getIngredients controller never returns another franchise", async () => {
  const { cartA, ownA, sharedA, ownB, sharedB } = fixture;
  const res = mockResponse();
  await costingController.getIngredients({ user: { _id: cartA, role: "admin" }, query: {} }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const ids = res.body.data.map(item => String(item._id));
  for (const allowed of [ownA, sharedA]) assert(ids.includes(String(allowed._id)));
  for (const blocked of [ownB, sharedB]) assert(!ids.includes(String(blocked._id)));
});

test("stock service blocks foreign shared and global templates before mutation", async () => {
  const { cartA, sharedB, global } = fixture;
  const beforeB = await Ingredient.findById(sharedB._id).lean();
  const beforeGlobal = await Ingredient.findById(global._id).lean();
  for (const id of [sharedB._id, global._id]) {
    await assert.rejects(WeightedAverageService.updateWeightedAverage(id, 2, 3, cartA), /INVENTORY_SCOPE_MISMATCH|GLOBAL_INVENTORY_TEMPLATE_MUTATION_BLOCKED/);
    await assert.rejects(WeightedAverageService.consume(id, 1, "manual", null, cartA, cartA), /INVENTORY_SCOPE_MISMATCH|GLOBAL_INVENTORY_TEMPLATE_MUTATION_BLOCKED/);
    await assert.rejects(WeightedAverageService.returnToInventory(id, 1, "manual", null, cartA, cartA), /INVENTORY_SCOPE_MISMATCH|GLOBAL_INVENTORY_TEMPLATE_MUTATION_BLOCKED/);
  }
  assert.equal((await Ingredient.findById(sharedB._id)).qtyOnHand, beforeB.qtyOnHand);
  assert.equal((await Ingredient.findById(global._id)).qtyOnHand, beforeGlobal.qtyOnHand);
  assert.equal(await Transaction.countDocuments({ ingredientId: { $in: [sharedB._id, global._id] } }), 0);
});

test("ingredient update rejects foreign franchise and shared cart edits", async () => {
  const { cartA, sharedA, sharedB } = fixture;
  for (const ingredient of [sharedA, sharedB]) {
    const res = mockResponse();
    await costingController.updateIngredient({ user: { _id: cartA, role: "admin" }, params: { id: String(ingredient._id) }, body: { qtyOnHand: 99 }, app: mockApp }, res);
    assert.notEqual(res.code, 200);
    assert.notEqual((await Ingredient.findById(ingredient._id)).qtyOnHand, 99);
  }
});

test("Cart B cannot update A shared and cannot create or return stock against it", async () => {
  const { cartB, sharedA } = fixture;
  const initial = await Ingredient.findById(sharedA._id).lean();
  const calls = [
    ["updateIngredient", { params: { id: String(sharedA._id) }, body: { qtyOnHand: 40 } }],
    ["directPurchase", { body: { ingredientId: sharedA._id, cartId: cartB, qty: 3, uom: "pcs", unitPrice: 2 } }],
    ["consumeInventory", { body: { ingredientId: sharedA._id, cartId: cartB, qty: 1, uom: "pcs" } }],
    ["returnToInventory", { body: { ingredientId: sharedA._id, cartId: cartB, qty: 1, uom: "pcs" } }],
    ["recordWaste", { body: { ingredientId: sharedA._id, cartId: cartB, qty: 1, uom: "pcs", reason: "spoilage" } }],
  ];
  for (const [method, args] of calls) {
    const res = mockResponse();
    await costingController[method]({ user: { _id: cartB, role: "admin" }, app: mockApp, ...args }, res);
    assert.notEqual(res.code, 200, method);
  }
  const final = await Ingredient.findById(sharedA._id).lean();
  assert.equal(final.qtyOnHand, initial.qtyOnHand);
  assert.equal(final.currentCostPerBaseUnit, initial.currentCostPerBaseUnit);
  assert.equal(await Transaction.countDocuments({ ingredientId: sharedA._id }), 0);
});

test("purchase creation and receipt preflight reject a foreign ingredient", async () => {
  const { cartB, franchiseB, sharedA } = fixture;
  const user = { _id: cartB, role: "admin", franchiseId: franchiseB };
  const line = { ingredientId: sharedA._id, qty: 2, uom: "pcs", unitPrice: 4, total: 8 };
  const beforeQty = (await Ingredient.findById(sharedA._id)).qtyOnHand;
  const beforeCount = await Transaction.countDocuments({ ingredientId: sharedA._id });
  const resCreate = mockResponse();
  await costingController.createPurchase({ user, body: { cartId: cartB, supplierId: oid(), items: [line], autoReceive: true } }, resCreate);
  assert.notEqual(resCreate.code, 201);
  assert.equal(await Purchase.countDocuments({ cartId: cartB }), 0);

  const purchase = await Purchase.create({ cartId: cartB, franchiseId: franchiseB, supplierId: oid(), items: [line], totalAmount: 8, status: "created" });
  const resReceive = mockResponse();
  await costingController.receivePurchase({ user, params: { id: purchase._id }, body: {} }, resReceive);
  assert.notEqual(resReceive.code, 200);
  assert.equal((await Purchase.findById(purchase._id)).status, "created");
  assert.equal((await Ingredient.findById(sharedA._id)).qtyOnHand, beforeQty);
  assert.equal(await Transaction.countDocuments({ ingredientId: sharedA._id }), beforeCount);
});

test("legacy mobile list stays within one cart even when it has no items", async () => {
  const { cartA, cartA2, managerA, franchiseA } = fixture;
  await InventoryItem.create({ name: "Other cart item", category: "Other", cartId: cartA2, franchiseId: franchiseA });
  const res = mockResponse();
  await inventoryController.getAllInventory({ user: { _id: managerA, role: "manager", cafeId: cartA }, query: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.data, []);
});

test("legacy item with missing franchiseId remains visible to its verified cart only", async () => {
  const { cartA, managerA, cartB } = fixture;
  const item = await InventoryItem.create({ name: "Legacy cart A without franchise field", category: "Other", cartId: cartA });
  const own = mockResponse();
  await inventoryController.getAllInventory({ user: { _id: managerA, role: "manager", cafeId: cartA }, query: {} }, own);
  assert(own.body.data.some(row => same(row._id, item._id)));
  const foreign = mockResponse();
  await inventoryController.getAllInventory({ user: { _id: cartB, role: "admin" }, query: {} }, foreign);
  assert(!foreign.body.data.some(row => same(row._id, item._id)));
});

test("manager cart override and unscoped Super Admin stock writes are denied", async () => {
  const { managerA, cartA, cartB, ownA, ownB } = fixture;
  const beforeA = (await Ingredient.findById(ownA._id)).qtyOnHand;
  const beforeB = (await Ingredient.findById(ownB._id)).qtyOnHand;
  const manager = mockResponse();
  await costingController.consumeInventory({ user: { _id: managerA, role: "manager", cafeId: cartA },
    body: { ingredientId: ownB._id, cartId: cartB, qty: 1, uom: "pcs" } }, manager);
  assert.notEqual(manager.code, 200);
  const unscopedSuper = mockResponse();
  await costingController.directPurchase({ user: { _id: oid(), role: "super_admin" },
    body: { ingredientId: ownA._id, qty: 1, uom: "pcs", unitPrice: 1 } }, unscopedSuper);
  assert.notEqual(unscopedSuper.code, 200);
  assert.equal((await Ingredient.findById(ownA._id)).qtyOnHand, beforeA);
  assert.equal((await Ingredient.findById(ownB._id)).qtyOnHand, beforeB);
});

test("FIFO purchase and consumption reject another franchise before stock write", async () => {
  const { cartB, franchiseB, sharedA } = fixture;
  const purchase = await Purchase.create({ cartId: cartB, franchiseId: franchiseB, supplierId: oid(),
    items: [{ ingredientId: sharedA._id, qty: 1, uom: "pcs", unitPrice: 1, total: 1 }], totalAmount: 1 });
  const beforeQty = (await Ingredient.findById(sharedA._id)).qtyOnHand;
  await assert.rejects(FIFOService.addLayer(sharedA._id, 1, 1, purchase._id), /INVENTORY_SCOPE_MISMATCH/);
  await assert.rejects(FIFOService.consume(sharedA._id, 1, "manual", null, cartB, cartB), /INVENTORY_SCOPE_MISMATCH/);
  assert.equal((await Ingredient.findById(sharedA._id)).qtyOnHand, beforeQty);
  assert.equal(await Transaction.countDocuments({ ingredientId: sharedA._id }), 0);
});

test("historical purchase read redacts a foreign ingredient line", async () => {
  const { cartB, sharedA } = fixture;
  const response = mockResponse();
  await costingController.getPurchases({ user: { _id: cartB, role: "admin" }, query: {} }, response);
  assert.equal(response.code, 200, JSON.stringify(response.body));
  assert(response.body.data.length > 0);
  assert(!JSON.stringify(response.body.data).includes(String(sharedA._id)));
});

test("preparation listing and issue stay within the assigned cart and franchise", async () => {
  const { cartA, cartB, managerA, franchiseA, franchiseB, ownB, sharedA } = fixture;
  const prepA = await Preparation.create({ name: "Fixture prep A", cartId: cartA, franchiseId: franchiseA, createdBy: cartA });
  const prepB = await Preparation.create({ name: "Fixture prep B", cartId: cartB, franchiseId: franchiseB, createdBy: cartB });
  const user = { _id: managerA, role: "manager", cafeId: cartA };
  const listed = mockResponse();
  await preparationController.getPreparations({ user, query: {} }, listed);
  assert.equal(listed.code, 200, JSON.stringify(listed.body));
  assert(listed.body.data.some(row => same(row._id, prepA._id)));
  assert(!listed.body.data.some(row => same(row._id, prepB._id)));
  const beforeB = (await Ingredient.findById(ownB._id)).qtyOnHand;
  const foreignPrep = mockResponse();
  await preparationController.issueIngredient({ user, params: { id: prepB._id },
    body: { ingredientId: ownB._id, qty: 1, uom: "pcs" } }, foreignPrep);
  assert.notEqual(foreignPrep.code, 200);
  const foreignIngredient = mockResponse();
  await preparationController.issueIngredient({ user, params: { id: prepA._id },
    body: { ingredientId: ownB._id, qty: 1, uom: "pcs" } }, foreignIngredient);
  assert.notEqual(foreignIngredient.code, 200);
  assert.equal((await Ingredient.findById(ownB._id)).qtyOnHand, beforeB);
  assert.equal(await Transaction.countDocuments({ ingredientId: ownB._id }), 0);
  assert.equal((await Ingredient.findById(sharedA._id)).qtyOnHand, 0);
});

test("order KOT consumes own BOM once and rejects foreign BOM ingredient", async () => {
  const { cartA, franchiseA, ownA, sharedB } = fixture;
  const recipe = await Recipe.create({ name: "Fixture meal", portions: 1, cartId: cartA, franchiseId: franchiseA,
    ingredients: [{ ingredientId: ownA._id, qty: 2, uom: "pcs" }, { ingredientId: sharedB._id, qty: 1, uom: "pcs" }] });
  const menu = await MenuItem.create({ name: "Fixture meal", category: "Other", sellingPrice: 10, cartId: cartA, franchiseId: franchiseA, recipeId: recipe._id });
  const order = { _id: "fixture-order-a", cartId: cartA, franchiseId: franchiseA, status: "PREPARING", serviceType: "DINE_IN",
    kotLines: [{ items: [{ name: "Fixture meal", quantity: 1, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] };
  const beforeA = (await Ingredient.findById(ownA._id)).qtyOnHand;
  const beforeB = (await Ingredient.findById(sharedB._id)).qtyOnHand;
  const result = await consumeIngredientsForOrder(order, cartA);
  assert.equal((await Ingredient.findById(ownA._id)).qtyOnHand, beforeA - 2, JSON.stringify(result));
  assert.equal((await Ingredient.findById(sharedB._id)).qtyOnHand, beforeB);
  assert.equal(await Transaction.countDocuments({ refType: "order", refId: order._id, ingredientId: ownA._id }), 1);
  assert.equal(await Transaction.countDocuments({ refType: "order", refId: order._id, ingredientId: sharedB._id }), 0);
  await consumeIngredientsForOrder(order, cartA);
  assert.equal(await Transaction.countDocuments({ refType: "order", refId: order._id, ingredientId: ownA._id }), 1);
});

test("Cart B order with A-shared BOM continues without an A stock transaction", async () => {
  const { cartB, franchiseB, sharedA } = fixture;
  const recipe = await Recipe.create({ name: "Fixture cross franchise B meal", portions: 1, cartId: cartB, franchiseId: franchiseB,
    ingredients: [{ ingredientId: sharedA._id, qty: 2, uom: "pcs" }] });
  const menu = await MenuItem.create({ name: "Fixture cross franchise B meal", category: "Other", sellingPrice: 10, cartId: cartB, franchiseId: franchiseB, recipeId: recipe._id });
  const order = { _id: "fixture-order-b-invalid-bom", cartId: cartB, franchiseId: franchiseB, status: "PREPARING",
    serviceType: "TAKEAWAY", kotLines: [{ items: [{ name: menu.name, quantity: 1, menuItemId: menu._id }] }] };
  const qtyBefore = (await Ingredient.findById(sharedA._id)).qtyOnHand;
  const countBefore = await Transaction.countDocuments({ ingredientId: sharedA._id });
  const result = await consumeIngredientsForOrder(order, cartB);
  assert.equal(result.summary.errors.length, 1);
  assert.equal((await Ingredient.findById(sharedA._id)).qtyOnHand, qtyBefore);
  assert.equal(await Transaction.countDocuments({ ingredientId: sharedA._id }), countBefore);
});

test("orphan or mismatched order identity skips Inventory consumption", async () => {
  const { cartA, franchiseA, franchiseB, ownA } = fixture;
  const beforeQty = (await Ingredient.findById(ownA._id)).qtyOnHand;
  const orphan = await consumeIngredientsForOrder({ _id: "fixture-orphan-order", cartId: oid(), franchiseId: franchiseA,
    kotLines: [{ items: [{ name: "Fixture meal", quantity: 1 }] }] }, cartA);
  assert.equal(orphan.success, false);
  const mismatched = await consumeIngredientsForOrder({ _id: "fixture-mismatched-order", cartId: cartA, franchiseId: franchiseB,
    kotLines: [{ items: [{ name: "Fixture meal", quantity: 1 }] }] }, cartA);
  assert.equal(mismatched.success, false);
  assert.equal((await Ingredient.findById(ownA._id)).qtyOnHand, beforeQty);
  assert.equal(await Transaction.countDocuments({ refId: { $in: ["fixture-orphan-order", "fixture-mismatched-order"] } }), 0);
});

test("BOM read redacts foreign ingredient and new cross-franchise BOM is rejected", async () => {
  const { cartB, franchiseB, sharedA } = fixture;
  const user = { _id: cartB, role: "admin", franchiseId: franchiseB };
  const read = mockResponse();
  await costingController.getRecipes({ user, query: {} }, read);
  assert.equal(read.code, 200, JSON.stringify(read.body));
  const invalidRecipe = read.body.data.find(recipe => recipe.name === "Fixture cross franchise B meal");
  assert.ok(invalidRecipe);
  assert.equal(invalidRecipe.ingredients.length, 0);
  assert(!JSON.stringify(read.body).includes(String(sharedA._id)));
  const create = mockResponse();
  await costingController.createRecipe({ user, body: { name: "Fixture blocked new BOM", portions: 1,
    ingredients: [{ ingredientId: sharedA._id, qty: 1, uom: "pcs" }] } }, create);
  assert.notEqual(create.code, 201);
  assert.equal(await Recipe.countDocuments({ name: "Fixture blocked new BOM" }), 0);
});

test("bulk BOM linking skips a recipe with a foreign ingredient", async () => {
  const { cartB, franchiseB } = fixture;
  const menu = await MenuItem.create({ name: "Fixture cross franchise B meal", category: "Other",
    sellingPrice: 10, cartId: cartB, franchiseId: franchiseB });
  const response = mockResponse();
  await costingController.linkMatchingBoms({ user: { _id: cartB, role: "admin" },
    body: {} }, response);
  assert.equal(response.code, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.linked, 0);
  assert.equal((await MenuItem.findById(menu._id)).recipeId, null);
});

test("GET dashboard stats retains core and Inventory metric keys in isolated fixture", async () => {
  const express = require("express");
  const app = express();
  app.use((req, _res, next) => { req.user = { _id: fixture.cartA, role: "admin" }; next(); });
  app.get("/api/dashboard/stats", dashboardController.getDashboardStats);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/stats`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const keys = ["activeOrders", "todayRevenue", "pendingTasks", "pendingKOTs", "preparingKOTs", "readyKOTs",
      "completedUnpaid", "completedPaid", "lowStockItems", "todayAttendance", "occupiedTables", "totalTables", "availableTables", "pendingRequests"];
    for (const key of keys) assert.equal(typeof body.data[key], "number", key);
    for (const key of keys) assert.equal(body.data[key], key === "lowStockItems" ? 1 : 0, `${key}: ${JSON.stringify(body.data)}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("POST order, PREPARING, incremental KOT, READY, COMPLETED and manual paid baseline", async () => {
  const express = require("express");
  const { cartA, franchiseA } = fixture;
  const stock = await Ingredient.create({ name: "Fixture baseline stock", category: "Other", uom: "pcs",
    cartId: cartA, franchiseId: franchiseA, qtyOnHand: 100, currentCostPerBaseUnit: 1 });
  const recipe = await Recipe.create({ name: "Fixture baseline meal", cartId: cartA, franchiseId: franchiseA,
    portions: 1, ingredients: [{ ingredientId: stock._id, qty: 3, uom: "pcs" }] });
  const menu = await MenuItem.create({ name: "Fixture baseline meal", category: "Other", sellingPrice: 10,
    cartId: cartA, franchiseId: franchiseA, recipeId: recipe._id });
  const app = express();
  app.use(express.json());
  app.set("emitToCafe", () => {});
  app.use((req, _res, next) => { req.user = { _id: cartA, role: "admin", franchiseId: franchiseA }; next(); });
  app.post("/api/orders", orderController.createOrder);
  app.patch("/api/orders/:id/status", orderController.updateOrderStatus);
  app.post("/api/orders/:id/kot", orderController.addKot);
  app.post("/api/payments/:id/mark-paid", paymentController.markPaymentPaid);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const item = { name: menu.name, quantity: 1, price: 10, menuItemId: menu._id };
    const created = await api("POST", "/api/orders", { serviceType: "TAKEAWAY", cartId: cartA, items: [item] });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created));
    const orderId = created.body._id || created.body.order?._id;
    assert.ok(orderId, JSON.stringify(created.body));
    const newOrder = await Order.findById(orderId);
    assert.equal(newOrder.status, "NEW");
    assert.equal(newOrder.inventoryDeducted, false);
    assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 100);
    assert.equal(await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }), 0);

    const preparing = await api("PATCH", `/api/orders/${orderId}/status`, { status: "PREPARING" });
    assert.equal(preparing.status, 200, JSON.stringify(preparing));
    await eventually(async () => await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }) === 1);
    assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 97);
    assert.deepEqual((await Transaction.find({ refId: orderId, ingredientId: stock._id }).lean()).map(t => t.notes), ["KOT:0"]);

    const added = await api("POST", `/api/orders/${orderId}/kot`, { items: [item] });
    assert.equal(added.status, 200, JSON.stringify(added));
    await eventually(async () => await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }) === 2);
    assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 94);
    assert.deepEqual((await Transaction.find({ refId: orderId, ingredientId: stock._id }).sort({ date: 1 }).lean()).map(t => t.notes), ["KOT:0", "KOT:1"]);

    for (const status of ["READY", "COMPLETED"]) {
      const changed = await api("PATCH", `/api/orders/${orderId}/status`, { status });
      assert.equal(changed.status, 200, JSON.stringify(changed));
    }
    assert.equal(await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }), 2);
    assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 94);
    const payment = await Payment.create({ orderId, amount: 20, method: "CASH", status: "PENDING" });
    const paid = await api("POST", `/api/payments/${payment._id}/mark-paid`, {});
    assert.equal(paid.status, 200, JSON.stringify(paid));
    assert.equal((await Order.findById(orderId)).paymentStatus, "PAID");
    assert.equal(await Transaction.countDocuments({ refId: orderId, ingredientId: stock._id }), 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("manual paid fallback consumes an undeducted completed order once", async () => {
  const { cartA, franchiseA } = fixture;
  const stock = await Ingredient.create({ name: "Fixture payment fallback stock", category: "Other", uom: "pcs",
    cartId: cartA, franchiseId: franchiseA, qtyOnHand: 20, currentCostPerBaseUnit: 1 });
  const recipe = await Recipe.create({ name: "Fixture payment fallback meal", cartId: cartA, franchiseId: franchiseA,
    portions: 1, ingredients: [{ ingredientId: stock._id, qty: 4, uom: "pcs" }] });
  const menu = await MenuItem.create({ name: "Fixture payment fallback meal", category: "Other", sellingPrice: 10,
    cartId: cartA, franchiseId: franchiseA, recipeId: recipe._id });
  const order = await Order.create({ _id: "fixture-payment-fallback", status: "COMPLETED", paymentStatus: "PENDING",
    inventoryDeducted: false, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA,
    kotLines: [{ items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const payment = await Payment.create({ orderId: order._id, amount: 10, method: "CASH", status: "PENDING" });
  const res = mockResponse();
  await paymentController.markPaymentPaid({ user: { _id: cartA, role: "admin" }, params: { id: payment._id }, app: mockApp }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  await eventually(async () => await Transaction.countDocuments({ refId: order._id, ingredientId: stock._id }) === 1);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 16);
  assert.equal((await Order.findById(order._id)).paymentStatus, "PAID");
  const replay = mockResponse();
  await paymentController.markPaymentPaid({ user: { _id: cartA, role: "admin" }, params: { id: payment._id }, app: mockApp }, replay);
  assert.equal(replay.code, 200);
  assert.equal(await Transaction.countDocuments({ refId: order._id, ingredientId: stock._id }), 1);
});

test("payment-first order is paid and released without immediate Inventory consumption", async () => {
  const { cartA, franchiseA } = fixture;
  const stock = await Ingredient.create({ name: "Fixture payment first stock", category: "Other", uom: "pcs",
    cartId: cartA, franchiseId: franchiseA, qtyOnHand: 12, currentCostPerBaseUnit: 1 });
  const recipe = await Recipe.create({ name: "Fixture payment first meal", cartId: cartA, franchiseId: franchiseA,
    portions: 1, ingredients: [{ ingredientId: stock._id, qty: 2, uom: "pcs" }] });
  const menu = await MenuItem.create({ name: "Fixture payment first meal", category: "Other", sellingPrice: 10,
    cartId: cartA, franchiseId: franchiseA, recipeId: recipe._id });
  const order = await Order.create({ _id: "fixture-payment-first", status: "NEW", paymentStatus: "PENDING",
    inventoryDeducted: false, paymentRequiredBeforeProceeding: true, serviceType: "TAKEAWAY", cartId: cartA, franchiseId: franchiseA,
    kotLines: [{ items: [{ name: menu.name, quantity: 1, price: 10, menuItemId: menu._id }], subtotal: 10, gst: 0, totalAmount: 10 }] });
  const payment = await Payment.create({ orderId: order._id, amount: 10, method: "CASH", status: "PENDING" });
  const res = mockResponse();
  await paymentController.markPaymentPaid({ user: { _id: cartA, role: "admin" }, params: { id: payment._id }, app: mockApp }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const updated = await Order.findById(order._id);
  assert.equal(updated.status, "NEW");
  assert.equal(updated.paymentStatus, "PAID");
  assert.equal(updated.paymentRequiredBeforeProceeding, false);
  assert.equal(updated.inventoryDeducted, false);
  assert.equal((await Ingredient.findById(stock._id)).qtyOnHand, 12);
  assert.equal(await Transaction.countDocuments({ refId: order._id }), 0);
});

test("notification event paths invoke without an Inventory lookup or Firebase token", async () => {
  const { cartA } = fixture;
  const emitted = [];
  const io = {};
  const emitToCafeFn = (_io, _cartId, event, payload) => emitted.push({ event, payload });
  const order = { _id: "fixture-notification-order", cartId: cartA, status: "READY", paymentStatus: "PAID" };
  await notificationEvents.notifyNewOrder({ io, emitToCafeFn, order });
  await notificationEvents.notifyOrderReady({ io, emitToCafeFn, order });
  await notificationEvents.notifyOrderCancelled({ io, emitToCafeFn, order, reason: "fixture" });
  await notificationEvents.notifyPaymentRequest({ io, emitToCafeFn, order, payment: { _id: oid(), method: "CASH", status: "PENDING" } });
  await notificationEvents.notifyPaymentReceived({ io, emitToCafeFn, order });
  await notificationEvents.notifyAssistanceRequestCreated({ io, emitToCafeFn,
    request: { _id: oid(), cartId: cartA, requestType: "assistance", status: "pending" } });
  const customerResult = await notificationEvents.notifyCustomerRequestCreated({
    request: { _id: oid(), cartId: cartA, requestType: "water", status: "pending" },
  });
  assert.ok(customerResult);
  const events = emitted.map(row => row.event);
  for (const event of ["new_order", "order_ready", "order_cancelled", "payment_request", "payment_received", "assistance_request_created"]) {
    assert(events.includes(event), event);
  }
});
