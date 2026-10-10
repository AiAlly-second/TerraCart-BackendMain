const Order = require('../models/orderModel');
const { verifyOrderReplay } = require('../utils/orderIdempotency');

const verifyKotReplay = (order, key, binding) => verifyOrderReplay({ idempotencyBinding: order.kotReplayBindings?.find(entry => entry.key === key) }, binding);

async function appendKotIdempotently(order, key, binding, kot) {
  const update = {
    $push: { kotLines: kot, kotRequestKeys: key, kotReplayBindings: { key, ...binding } },
    $set: { selectedAddons: order.selectedAddons, specialInstructions: order.specialInstructions || '' },
    $inc: { __v: 1 },
  };
  const filter = {
    _id: order._id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    kotRequestKeys: { $ne: key },
    ...(order.__v === undefined ? { __v: { $exists: false } } : { __v: order.__v }),
  };
  const saved = await Order.findOneAndUpdate(filter, update, { new: true, runValidators: true });
  if (saved) return { order: saved, replayed: false };
  const current = await Order.findById(order._id);
  if (current?.kotRequestKeys?.includes(key)) {
    const access = verifyKotReplay(current, key, binding);
    if (access.ok) return { order: current, replayed: true };
    return { error: access };
  }
  return { error: { status: 409, message: 'Order changed during this request. Refresh and retry with the same key.' } };
}
module.exports = { appendKotIdempotently, verifyKotReplay };
