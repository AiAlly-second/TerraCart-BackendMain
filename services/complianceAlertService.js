/**
 * Compliance Alert Service
 * Sends alerts for expiring compliance documents
 */

const Compliance = require("../models/complianceModel");
const { notifyExpiringCompliance } = require("./notificationService");

/**
 * Check for expiring compliance documents
 * @param {Object} io - Socket.IO instance
 */
async function checkExpiringCompliance(io) {
  try {
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    // Find compliance documents expiring within 30 days
    const expiringCompliance = await Compliance.find({
      expiryDate: { $gte: now, $lte: thirtyDaysFromNow },
      status: { $ne: "expired" },
    })
      .populate("cafeId", "name")
      .populate("franchiseId", "name");

    for (const compliance of expiringCompliance) {
      // Update status if needed
      const daysUntilExpiry = Math.ceil((compliance.expiryDate - now) / (1000 * 60 * 60 * 24));
      
      if (daysUntilExpiry <= compliance.renewalReminderDays && compliance.status !== "expiring_soon") {
        compliance.status = "expiring_soon";
        await compliance.save();
      }

      // Emit notification
      if (io) {
        const cafeId = compliance.cafeId?._id?.toString();
        const franchiseId = compliance.franchiseId?._id?.toString();
        notifyExpiringCompliance(io, compliance, cafeId, franchiseId);
      }
    }

    console.log(`[COMPLIANCE ALERT] Checked ${expiringCompliance.length} expiring compliance documents`);
  } catch (error) {
    console.error("[COMPLIANCE ALERT] Error checking expiring compliance:", error);
  }
}

/**
 * Check for expired compliance documents
 */
async function checkExpiredCompliance() {
  try {
    const now = new Date();

    // Find expired compliance documents
    const expiredCompliance = await Compliance.find({
      expiryDate: { $lt: now },
      status: { $ne: "expired" },
    });

    for (const compliance of expiredCompliance) {
      compliance.status = "expired";
      await compliance.save();
    }

    console.log(`[COMPLIANCE ALERT] Updated ${expiredCompliance.length} expired compliance documents`);
  } catch (error) {
    console.error("[COMPLIANCE ALERT] Error checking expired compliance:", error);
  }
}

/**
 * Schedule compliance alerts
 * @param {Object} io - Socket.IO instance
 */
function scheduleComplianceAlerts(io) {
  // Check for expiring compliance daily at 10 AM
  const now = new Date();
  const next10AM = new Date();
  next10AM.setHours(10, 0, 0, 0);
  if (next10AM <= now) {
    next10AM.setDate(next10AM.getDate() + 1);
  }

  const msUntil10AM = next10AM - now;
  setTimeout(() => {
    checkExpiringCompliance(io);
    checkExpiredCompliance();
    // Then schedule daily
    setInterval(() => {
      checkExpiringCompliance(io);
      checkExpiredCompliance();
    }, 24 * 60 * 60 * 1000); // 24 hours
  }, msUntil10AM);

  console.log("[COMPLIANCE ALERT] Compliance alert service scheduled");
}

module.exports = {
  checkExpiringCompliance,
  checkExpiredCompliance,
  scheduleComplianceAlerts,
};

