const STAFF = new Set(['admin', 'manager', 'captain', 'waiter', 'cook', 'employee', 'franchise_admin', 'super_admin']);
function orderOriginFromRequest(req) {
  const authenticatedStaff = req.user?._id && STAFF.has(req.user.role);
  const mobile = String(req.headers?.['x-request-source'] || '').toLowerCase() === 'terra-admin-app';
  return { source: authenticatedStaff ? (mobile ? 'staff_mobile' : 'staff_web') : 'customer',
    createdByUserId: authenticatedStaff ? req.user._id : null };
}
function orderCreationAlertMetadata(order) {
  return { eventId: `order-created:${order._id || order.orderId}`,
    originSource: order.origin?.source || 'unknown',
    createdByUserId: String(order.origin?.createdByUserId || '') };
}
function isSelfOriginatedOrder(order, userId) {
  return order.origin?.source === 'staff_mobile' &&
    Boolean(userId) && String(order.origin.createdByUserId || '') === String(userId);
}
module.exports = { orderOriginFromRequest, orderCreationAlertMetadata, isSelfOriginatedOrder };
