const Order = require("../models/orderModel");
const { releaseTableForOrder } = require("../controllers/orderController");
const {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  normalizeOrderStatus,
  buildOrderStatusUpdatedPayload,
} = require("../utils/orderContract");
const { applyLifecycleFields } = require("../utils/orderLifecycle");

function scheduleOrderAutoRelease(io, options = {}) {
  const minutes =
    Number(process.env.ORDER_AUTO_RELEASE_MINUTES) ||
    options.minutes ||
    30;
  const intervalMs =
    Number(process.env.ORDER_AUTO_RELEASE_POLL_MS) ||
    options.intervalMs ||
    300_000;

  if (minutes <= 0) {
    console.log("[ORDER_AUTO_RELEASE] disabled (ORDER_AUTO_RELEASE_MINUTES <= 0)");
    return;
  }

  const runCleanup = async () => {
    const cutoff = new Date(Date.now() - minutes * 60_000);
    try {
      const staleOrders = await Order.find({
        status: ORDER_STATUSES.NEW,
        paymentStatus: PAYMENT_STATUSES.PENDING,
        serviceType: "DINE_IN",
        createdAt: { $lt: cutoff },
        autoReleasedAt: { $exists: false },
        $or: [{ kotLines: { $exists: false } }, { kotLines: { $size: 0 } }],
      });

      if (!staleOrders.length) return;

      console.log(
        `[ORDER_AUTO_RELEASE] processing stale empty orders count=${staleOrders.length} thresholdMinutes=${minutes}`,
      );

      for (const order of staleOrders) {
        try {
          const hasKOTs = Array.isArray(order.kotLines) && order.kotLines.length > 0;
          const normalizedStatus = normalizeOrderStatus(
            order.status,
            ORDER_STATUSES.NEW,
          );
          if (hasKOTs || normalizedStatus !== ORDER_STATUSES.NEW) {
            continue;
          }

          order.status = ORDER_STATUSES.COMPLETED;
          order.paymentStatus = PAYMENT_STATUSES.PENDING;
          order.cancellationReason = "AUTO_RELEASED_EMPTY_ORDER";
          order.autoReleasedAt = new Date();
          applyLifecycleFields(order, {
            status: order.status,
            paymentStatus: order.paymentStatus,
            isPaid: false,
          });

          await order.save();
          await releaseTableForOrder(order, io);

          if (io) {
            io.emit("order_status_updated", buildOrderStatusUpdatedPayload(order));
          }

          console.log(
            `[ORDER_AUTO_RELEASE] auto-released orderId=${order._id} reason=EMPTY_NEW_ORDER`,
          );
        } catch (err) {
          console.error("[ORDER_AUTO_RELEASE] order sweep failure", {
            orderId: order?._id || null,
            error: err?.message || err,
          });
        }
      }
    } catch (err) {
      console.error("[ORDER_AUTO_RELEASE] sweep error", err);
    }
  };

  setInterval(runCleanup, intervalMs);
  console.log(
    `[ORDER_AUTO_RELEASE] scheduled timeoutMinutes=${minutes} pollSeconds=${Math.round(
      intervalMs / 1000,
    )}`,
  );
}

module.exports = { scheduleOrderAutoRelease };

