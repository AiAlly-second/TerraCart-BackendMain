const escpos = require("escpos");
const escposNetwork = require("escpos-network");

/**
 * KOT Printer Service for EPSON TM-T82X
 *
 * Setup Instructions:
 * 1. Connect printer to network via Ethernet cable
 * 2. Configure printer IP address (usually via printer's control panel or EpsonNet Config)
 * 3. Set PRINTER_IP and PRINTER_PORT in .env file
 * 4. Default port for EPSON printers is usually 9100
 */

// Get printer configuration from environment variables
const PRINTER_IP = process.env.PRINTER_IP || "192.168.1.151";
const PRINTER_PORT = process.env.PRINTER_PORT || 9100;
const PRINTER_ENABLED = process.env.PRINTER_ENABLED !== "false"; // Default to true

/**
 * Format KOT for printing
 */
function formatKOT(order, kot, kotIndex = 0) {
  const lines = [];

  // Header
  lines.push("================================");
  lines.push("        TERRA CART");
  lines.push("     KITCHEN ORDER TICKET");
  lines.push("================================");
  lines.push("");

  // Order Information
  lines.push(`Order ID: ${order._id}`);
  lines.push(`KOT #: ${kotIndex + 1}`);
  lines.push(`Table: ${order.tableNumber || "N/A"}`);
  lines.push(`Service: ${order.serviceType || "DINE_IN"}`);
  // Show takeaway token for takeaway orders (REQUIRED - main identifier)
  if (order.serviceType === "TAKEAWAY" && order.takeawayToken) {
    lines.push(`Token: ${order.takeawayToken}`);
  }
  // Customer info is optional - only show if provided
  if (order.serviceType === "TAKEAWAY" && order.customerName) {
    lines.push(`Customer: ${order.customerName}`);
    if (order.customerMobile) {
      lines.push(`Mobile: ${order.customerMobile}`);
    }
  }
  lines.push(
    `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  lines.push("--------------------------------");
  lines.push("");

  // Items
  lines.push("ITEMS:");
  if (kot.items && Array.isArray(kot.items)) {
    kot.items.forEach((item, idx) => {
      if (item.returned) {
        lines.push(`[RETURNED] ${item.name}`);
      } else {
        lines.push(`${item.quantity}x ${item.name}`);
      }
    });
  }

  lines.push("--------------------------------");
  lines.push("");
  lines.push("================================");
  lines.push("     Thank You!");
  lines.push("================================");
  lines.push("");
  lines.push(""); // Extra blank lines for cutting

  return lines.join("\n");
}

/**
 * Print KOT to EPSON TM-T82X printer
 */
async function printKOT(order, kot, kotIndex = 0) {
  if (!PRINTER_ENABLED) {
    console.log("[PRINTER] Printing disabled in configuration");
    return { success: false, message: "Printer disabled" };
  }

  try {
    // Create network printer connection
    const device = new escposNetwork(PRINTER_IP, PRINTER_PORT);
    const printer = new escpos.Printer(device);

    return new Promise((resolve, reject) => {
      device.open((error) => {
        if (error) {
          console.error("[PRINTER] Connection error:", error);
          reject({ success: false, error: error.message });
          return;
        }

        console.log(`[PRINTER] Connected to ${PRINTER_IP}:${PRINTER_PORT}`);

        // Format KOT content
        const kotContent = formatKOT(order, kot, kotIndex);

        // Print KOT
        printer
          .font("a")
          .align("ct")
          .text(kotContent)
          .cut()
          .close((err) => {
            if (err) {
              console.error("[PRINTER] Print error:", err);
              reject({ success: false, error: err.message });
            } else {
              console.log(
                `[PRINTER] KOT printed successfully for order ${order._id}`
              );
              resolve({ success: true, message: "KOT printed successfully" });
            }
          });
      });
    });
  } catch (error) {
    console.error("[PRINTER] Error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Print all KOTs for an order
 */
async function printAllKOTs(order) {
  if (!order || !order.kotLines || !Array.isArray(order.kotLines)) {
    return { success: false, message: "Invalid order or no KOTs found" };
  }

  const results = [];
  for (let i = 0; i < order.kotLines.length; i++) {
    const kot = order.kotLines[i];
    try {
      const result = await printKOT(order, kot, i);
      results.push({ kotIndex: i, ...result });
      // Small delay between prints to avoid overwhelming the printer
      if (i < order.kotLines.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      results.push({ kotIndex: i, success: false, error: error.message });
    }
  }

  return {
    success: results.some((r) => r.success),
    results: results,
  };
}

module.exports = {
  printKOT,
  printAllKOTs,
  formatKOT,
};
