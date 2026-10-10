const Order = require('../../models/orderModel');
const User = require('../../models/userModel');
const { Payment } = require('../../models/paymentModel');
const InventoryTransaction = require('../../models/costing-v2/inventoryTransactionModel');
const { calculateOrderRevenue } = require('../../utils/orderRevenue');
const { normalizeOrderStatus } = require('../../utils/orderContract');
const round = value => Number(value.toFixed(2));
const inPeriod = (value, start, end) => value && new Date(value) >= start && new Date(value) < end;
function calculate(orders, payments, start, end) {
  const placed = orders.filter(order => inPeriod(order.createdAt, start, end));
  const counts = { total: placed.length, completed: 0, pending: 0, cancelled: 0, returned: 0 };
  for (const order of placed) {
    if (order.returnedAt) counts.returned++;
    else if (normalizeOrderStatus(order.status) === 'CANCELLED') counts.cancelled++;
    else if (normalizeOrderStatus(order.status) === 'COMPLETED') counts.completed++;
    else counts.pending++;
  }
  const recognized = orders.filter(order => order.paymentStatus === 'PAID' && !order.returnedAt &&
    normalizeOrderStatus(order.status) !== 'CANCELLED' && inPeriod(order.paidAt, start, end));
  const sales = round(recognized.reduce((sum, order) => sum + calculateOrderRevenue(order), 0));
  const taxes = round(recognized.reduce((sum, order) => sum + (order.kotLines || []).reduce((total, kot) => total + Number(kot.gst || 0), 0), 0));
  const breakdown = { Cash: 0, Online: 0, Other: 0 };
  const ids = new Set(orders.filter(o => !o.returnedAt && normalizeOrderStatus(o.status) !== 'CANCELLED').map(o => String(o._id)));
  const settled = payments.filter(p => p.status === 'PAID' && ids.has(String(p.orderId)) && inPeriod(p.paidAt, start, end));
  for (const payment of settled) {
    const key = payment.method === 'CASH' ? 'Cash' : payment.method === 'ONLINE' ? 'Online' : 'Other';
    breakdown[key] += Number(payment.amount || 0);
  }
  // Legacy direct paid orders have no Payment row. Reuse dashboard totals explicitly.
  const paymentOrderIds = new Set(payments.map(p => String(p.orderId)));
  for (const order of recognized.filter(o => !paymentOrderIds.has(String(o._id)))) {
    const key = order.paymentMode === 'CASH' ? 'Cash' : order.paymentMode === 'ONLINE' ? 'Online' : 'Other';
    breakdown[key] += calculateOrderRevenue(order);
  }
  Object.keys(breakdown).forEach(key => { breakdown[key] = round(breakdown[key]); });
  const notes = [
    'Sales reuse the Manager dashboard KOT, add-on and office-charge calculation, recognized by paidAt; cancelled and returned orders are excluded.',
    'UPI is included in Online: the payment ledger does not record a separate UPI method.',
    'Discounts and confirmed refund amounts are not persisted. Returns are not proof of a cash refund. Net retained revenue is unavailable.',
    'Statuses reflect persisted state at generation. Historical transitions and pre-return totals are unavailable; late generation cannot reconstruct an exact historical snapshot.',
  ];
  return { orders: counts, sales, grossSales: null, discounts: null, taxes,
    collected: round(Object.values(breakdown).reduce((a, b) => a + b, 0)), payments: breakdown,
    refunds: null, netRevenue: null, averageOrderValue: recognized.length ? round(sales / recognized.length) : 0,
    profitRevenue: round(sales - taxes), cogs: null, grossProfit: null, profitMargin: null,
    profitNote: 'Profit unavailable — cost data not configured (no historical order-item cost snapshots)', notes };
}
async function generate(scope, start, end, now = new Date()) {
  // Include today's partial/split collections on orders placed on earlier days.
  const paidToday = await Payment.aggregate([
    { $match: { status: 'PAID', paidAt: { $gte: start, $lt: end } } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'order' } },
    { $match: { 'order.cartId': scope.cartId, 'order.franchiseId': scope.franchiseId } },
    { $project: { orderId: 1 } },
  ]);
  const orders = await Order.find({ cartId: scope.cartId, franchiseId: scope.franchiseId,
    $or: [{ createdAt: { $gte: start, $lt: end } }, { paidAt: { $gte: start, $lt: end } },
      { _id: { $in: paidToday.map(p => p.orderId) } }] }).lean();
  const payments = await Payment.find({ orderId: { $in: orders.map(o => o._id) } }).lean();
  const cart = await User.findById(scope.cartId).select('name').lean();
  const franchise = await User.findById(scope.franchiseId).select('name').lean();
  const result = calculate(orders, payments, start, end);
  const costs = await InventoryTransaction.find({ cartId: scope.cartId, refType: 'order',
    refId: { $in: orders.filter(o => o.paymentStatus === 'PAID' && !o.returnedAt &&
      normalizeOrderStatus(o.status) !== 'CANCELLED' && inPeriod(o.paidAt, start, end)).map(o => o._id) },
    type: 'OUT', date: { $lt: end } }).select('costAllocated').lean();
  result.recordedIngredientCost = costs.length ? round(costs.reduce((sum, row) => sum + Number(row.costAllocated), 0)) : null;
  result.notes.push('Recorded ingredient consumption cost uses historical costAllocated transactions, independent of the current Inventory toggle. These transactions do not prove complete item/add-on cost coverage; they are not presented as total COGS or profit.');
  return { ...result, cartName: cart?.name || 'Cart', franchiseName: franchise?.name || null,
    periodStart: start.toISOString(), periodEnd: end.toISOString(), generatedAt: now.toISOString() };
}
module.exports = { calculate, generate };
