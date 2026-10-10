const mongoose = require('mongoose');
const Order = require('../models/orderModel');
const { Payment } = require('../models/paymentModel');
const { hasPrivilegedOrderAccess, verifyPublicOrderSessionAccess, extractSessionTokenFromRequest, extractAnonymousSessionIdFromRequest } = require('../controllers/orderController');

// Public payment actions must be authorized before reads, provider requests,
// superseding existing intents, cancellation or signature verification.
async function requirePaymentOrderAccess(req, res, next) {
  try {
    let orderId = req.params.orderId ?? req.body?.orderId;
    if (req.params.id) {
      if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ message: 'Invalid payment ID.' });
      const payment = await Payment.findById(req.params.id).select('orderId').lean();
      if (!payment) return res.status(404).json({ message: 'Payment not found.' });
      orderId = payment.orderId;
    }
    if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 128) return res.status(400).json({ message: 'A valid order ID is required.' });
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (!await hasPrivilegedOrderAccess(req.user, order)) {
      const access = await verifyPublicOrderSessionAccess(order, extractSessionTokenFromRequest(req), { anonymousSessionId: extractAnonymousSessionIdFromRequest(req) });
      if (!access.ok) return res.status(access.status).json({ message: access.message });
      // Historical unowned orders must not become authorized by knowledge of ID.
      if (order.serviceType !== 'DINE_IN' && !order.sessionToken && !order.anonymousSessionId) return res.status(403).json({ message: 'Order ownership cannot be verified. Please contact store staff.' });
    }
    next();
  } catch (error) { next(error); }
}
module.exports = { requirePaymentOrderAccess };
