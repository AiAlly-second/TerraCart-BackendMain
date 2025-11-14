const Order = require("../models/orderModel");
const { releaseTableForOrder } = require("../controllers/orderController");

function scheduleOrderAutoRelease(io, options = {}) {
  const minutes =
    Number(process.env.ORDER_AUTO_RELEASE_MINUTES) ||
    options.minutes ||
    5;
  const intervalMs =
    Number(process.env.ORDER_AUTO_RELEASE_POLL_MS) ||
    options.intervalMs ||
    60_000;

  if (minutes <= 0) {
    console.log("⏱️  Order auto-release disabled (ORDER_AUTO_RELEASE_MINUTES <= 0)");
    return;
  }

  const runCleanup = async () => {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    try {
      const staleOrders = await Order.find({
        status: "Confirmed",
        updatedAt: { $lt: cutoff },
        autoReleasedAt: { $exists: false },
      });

      if (!staleOrders.length) {
        return;
      }

      console.log(
        `⏱️  Auto-releasing ${staleOrders.length} stale orders (>${minutes} min).`
      );

      for (const order of staleOrders) {
        try {
          order.status = "Cancelled";
          order.autoReleasedAt = new Date();
          await order.save();
          await releaseTableForOrder(order, io);
          if (io) {
            io.emit("orderUpdated", order);
          }
          console.log(`⏱️  Auto-released order ${order._id}`);
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



