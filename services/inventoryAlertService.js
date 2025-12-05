/**
 * Inventory Alert Service
 * Sends alerts for low stock and expiring items
 */

const InventoryItem = require("../models/inventoryModel");
const { notifyLowStock } = require("./notificationService");

/**
 * Check for low stock items
 * @param {Object} io - Socket.IO instance
 */
async function checkLowStock(io) {
  try {
    // Find items where quantity is less than or equal to minStockLevel
    const lowStockItems = await InventoryItem.find({
      $expr: { $lte: ["$quantity", "$minStockLevel"] },
      isActive: true,
    })
      .populate("cafeId", "name")
      .populate("franchiseId", "name");

    for (const item of lowStockItems) {
      // Emit notification
      if (io) {
        const cafeId = item.cafeId?._id?.toString();
        const franchiseId = item.franchiseId?._id?.toString();
        notifyLowStock(io, item, cafeId, franchiseId);
      }
    }

    console.log(`[INVENTORY ALERT] Checked ${lowStockItems.length} low stock items`);
  } catch (error) {
    console.error("[INVENTORY ALERT] Error checking low stock:", error);
  }
}

/**
 * Check for expiring inventory items
 * @param {Object} io - Socket.IO instance
 */
async function checkExpiringItems(io) {
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // Find items expiring within 7 days
    const expiringItems = await InventoryItem.find({
      expiryDate: { $gte: now, $lte: sevenDaysFromNow },
      isActive: true,
    })
      .populate("cafeId", "name")
      .populate("franchiseId", "name");

    for (const item of expiringItems) {
      if (io) {
        const cafeId = item.cafeId?._id?.toString();
        const franchiseId = item.franchiseId?._id?.toString();
        io.emit("inventory:expiring", {
          itemId: item._id,
          name: item.name,
          expiryDate: item.expiryDate,
          item: item,
        });
      }
    }

    console.log(`[INVENTORY ALERT] Checked ${expiringItems.length} expiring items`);
  } catch (error) {
    console.error("[INVENTORY ALERT] Error checking expiring items:", error);
  }
}

/**
 * Schedule inventory alerts
 * @param {Object} io - Socket.IO instance
 */
function scheduleInventoryAlerts(io) {
  // Check for low stock every 4 hours
  setInterval(() => {
    checkLowStock(io);
  }, 4 * 60 * 60 * 1000); // 4 hours

  // Check for expiring items daily at 8 AM
  const now = new Date();
  const next8AM = new Date();
  next8AM.setHours(8, 0, 0, 0);
  if (next8AM <= now) {
    next8AM.setDate(next8AM.getDate() + 1);
  }

  const msUntil8AM = next8AM - now;
  setTimeout(() => {
    checkExpiringItems(io);
    // Then schedule daily
    setInterval(() => {
      checkExpiringItems(io);
    }, 24 * 60 * 60 * 1000); // 24 hours
  }, msUntil8AM);

  console.log("[INVENTORY ALERT] Inventory alert service scheduled");
}

module.exports = {
  checkLowStock,
  checkExpiringItems,
  scheduleInventoryAlerts,
};

