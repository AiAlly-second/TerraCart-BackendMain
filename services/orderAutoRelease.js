const Order = require("../models/orderModel");
const { releaseTableForOrder } = require("../controllers/orderController");

function scheduleOrderAutoRelease(io, options = {}) {
  const minutes =
    Number(process.env.ORDER_AUTO_RELEASE_MINUTES) ||
    options.minutes ||
    30; // Increased default from 5 to 30 minutes
  const intervalMs =
    Number(process.env.ORDER_AUTO_RELEASE_POLL_MS) ||
    options.intervalMs ||
    300_000; // Increased from 60s to 5 minutes (300s)

  if (minutes <= 0) {
    console.log("⏱️  Order auto-release disabled (ORDER_AUTO_RELEASE_MINUTES <= 0)");
    return;
  }

  const runCleanup = async () => {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    try {
      // Only auto-release orders that are truly stale and abandoned:
      // - "Pending" orders with NO KOTs that haven't been confirmed after X minutes
      // - Only for DINE_IN orders (not TAKEAWAY)
      // - Must have no items/KOTs (truly empty orders)
      const staleOrders = await Order.find({
        status: "Pending", // Only auto-release Pending orders, not Confirmed ones
        serviceType: "DINE_IN", // Only auto-release dine-in orders
        createdAt: { $lt: cutoff }, // Use createdAt to check when order was actually created
        autoReleasedAt: { $exists: false },
        // Only orders with no KOTs (empty orders)
        $or: [
          { kotLines: { $exists: false } },
          { kotLines: { $size: 0 } }
        ]
      });

      if (!staleOrders.length) {
        return;
      }

      console.log(
        `⏱️  Auto-releasing ${staleOrders.length} stale orders (>${minutes} min).`
      );

      for (const order of staleOrders) {
        try {
          // Only cancel truly empty Pending orders (no KOTs)
          // These are likely abandoned/forgotten orders
          const hasKOTs = order.kotLines && order.kotLines.length > 0;
          
          if (!hasKOTs && order.status === "Pending") {
            // Empty pending order that's been sitting for >30 minutes - safe to cancel
            order.status = "Cancelled";
            order.autoReleasedAt = new Date();
            await order.save();
            await releaseTableForOrder(order, io);
            if (io) {
              io.emit("orderUpdated", order);
            }
            console.log(`⏱️  Auto-released empty pending order ${order._id} (abandoned for >${minutes} min)`);
          }
        } catch (err) {
          console.error("Auto-release failed for order", order._id, err);
        }
      }
    } catch (err) {
      console.error("Auto-release sweep error:", err);
    }
  };

  setInterval(runCleanup, intervalMs);
  console.log(
    `⏱️  Order auto-release scheduled: ${minutes} minute timeout, running every ${Math.round(
      intervalMs / 1000
    )}s`
  );
}

module.exports = { scheduleOrderAutoRelease };



