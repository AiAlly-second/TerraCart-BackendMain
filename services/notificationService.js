/**
 * Notification Service
 * Handles real-time notifications via Socket.IO and push notifications
 */

/**
 * Emit Socket.IO notification
 * @param {Object} io - Socket.IO instance
 * @param {String} event - Event name
 * @param {Object} data - Data to emit
 * @param {String|Array} targetRoles - Target roles or 'all'
 * @param {String} cafeId - Optional cafe ID for filtering
 * @param {String} franchiseId - Optional franchise ID for filtering
 */
function emitNotification(io, event, data, targetRoles = "all", cafeId = null, franchiseId = null) {
  if (!io) {
    console.warn("[NOTIFICATION] Socket.IO instance not available");
    return;
  }

  // If targetRoles is 'all', emit to all connected clients
  if (targetRoles === "all") {
    io.emit(event, data);
    return;
  }

  // Emit to specific rooms based on roles and data isolation
  const rooms = [];
  
  if (Array.isArray(targetRoles)) {
    targetRoles.forEach((role) => {
      rooms.push(`role:${role}`);
    });
  } else {
    rooms.push(`role:${targetRoles}`);
  }

  if (cafeId) {
    rooms.push(`cafe:${cafeId}`);
  }

  if (franchiseId) {
    rooms.push(`franchise:${franchiseId}`);
  }

  // Emit to all relevant rooms
  rooms.forEach((room) => {
    io.to(room).emit(event, data);
  });
}

/**
 * Notify about new order
 */
function notifyNewOrder(io, order, cafeId, franchiseId) {
  emitNotification(
    io,
    "order:created",
    {
      orderId: order._id,
      tableNumber: order.tableNumber,
      status: order.status,
      order: order,
    },
    ["waiter", "cashier", "admin", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about order status update
 */
function notifyOrderStatusUpdate(io, order, cafeId, franchiseId) {
  emitNotification(
    io,
    "order:status:updated",
    {
      orderId: order._id,
      status: order.status,
      order: order,
    },
    "all",
    cafeId,
    franchiseId
  );
}

/**
 * Notify about new KOT
 */
function notifyNewKOT(io, order, kotLine, cafeId, franchiseId) {
  emitNotification(
    io,
    "kot:created",
    {
      orderId: order._id,
      kotLine: kotLine,
      order: order,
    },
    ["chef", "cook", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about KOT status update
 */
function notifyKOTStatusUpdate(io, kotData, cafeId, franchiseId) {
  emitNotification(
    io,
    "kot:status:updated",
    kotData,
    ["chef", "cook", "waiter", "cashier", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about table status update
 */
function notifyTableStatusUpdate(io, table, cafeId, franchiseId) {
  emitNotification(
    io,
    "table:status:updated",
    {
      tableId: table._id,
      number: table.number,
      status: table.status,
      table: table,
    },
    ["waiter", "cashier", "admin", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about new customer request
 */
function notifyNewRequest(io, request, cafeId, franchiseId) {
  emitNotification(
    io,
    "request:created",
    {
      requestId: request._id,
      requestType: request.requestType,
      tableId: request.tableId,
      request: request,
    },
    ["waiter", "cashier", "admin", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about request resolved
 */
function notifyRequestResolved(io, request, cafeId, franchiseId) {
  emitNotification(
    io,
    "request:resolved",
    {
      requestId: request._id,
      request: request,
    },
    ["waiter", "cashier", "admin", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about new task
 */
function notifyNewTask(io, task, cafeId, franchiseId) {
  emitNotification(
    io,
    "task:created",
    {
      taskId: task._id,
      title: task.title,
      assignedTo: task.assignedTo,
      task: task,
    },
    "all",
    cafeId,
    franchiseId
  );
}

/**
 * Notify about task completion
 */
function notifyTaskCompleted(io, task, cafeId, franchiseId) {
  emitNotification(
    io,
    "task:completed",
    {
      taskId: task._id,
      task: task,
    },
    ["admin", "manager"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about low stock
 */
function notifyLowStock(io, inventoryItem, cafeId, franchiseId) {
  emitNotification(
    io,
    "inventory:low_stock",
    {
      itemId: inventoryItem._id,
      name: inventoryItem.name,
      quantity: inventoryItem.quantity,
      minStockLevel: inventoryItem.minStockLevel,
      item: inventoryItem,
    },
    ["admin", "manager", "chef", "cook"],
    cafeId,
    franchiseId
  );
}

/**
 * Notify about expiring compliance
 */
function notifyExpiringCompliance(io, compliance, cafeId, franchiseId) {
  emitNotification(
    io,
    "compliance:expiring",
    {
      complianceId: compliance._id,
      title: compliance.title,
      expiryDate: compliance.expiryDate,
      compliance: compliance,
    },
    ["admin", "manager"],
    cafeId,
    franchiseId
  );
}

module.exports = {
  emitNotification,
  notifyNewOrder,
  notifyOrderStatusUpdate,
  notifyNewKOT,
  notifyKOTStatusUpdate,
  notifyTableStatusUpdate,
  notifyNewRequest,
  notifyRequestResolved,
  notifyNewTask,
  notifyTaskCompleted,
  notifyLowStock,
  notifyExpiringCompliance,
};

