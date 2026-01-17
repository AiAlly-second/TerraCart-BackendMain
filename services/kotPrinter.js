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
  const time = new Date();
  const timeStr = time.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const dateStr = time.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  // Restaurant Header
  lines.push("=".repeat(32));
  lines.push("       ** TERRA CART **");
  lines.push("=".repeat(32));
  lines.push("");

  // KOT Title - Large and Bold
  lines.push("   -----------------------");
  lines.push("   | KITCHEN ORDER TICKET |");
  lines.push("   -----------------------");
  lines.push("");

  // Critical ID Info
  lines.push(`   KOT NUMBER: #${String(kotIndex + 1).padStart(3, "0")}`);
  lines.push("");

  // Service Type Badge
  const serviceTypeLine = order.serviceType === "TAKEAWAY" 
    ? "   *** TAKEAWAY ORDER ***" 
    : "   ~~~ DINE-IN ORDER ~~~";
  lines.push(serviceTypeLine);
  lines.push("");

  // Date & Time
  lines.push(`  Date: ${dateStr}`);
  lines.push(`  Time: ${timeStr}`);
  lines.push("-".repeat(32));
  lines.push("");

  // Table/Token - HIGHLIGHTED
  if (order.serviceType === "TAKEAWAY" && order.takeawayToken) {
    lines.push("********************************");
    lines.push(`**  TOKEN: ${order.takeawayToken.toUpperCase().padEnd(20, " ")}**`);
    lines.push("********************************");
  } else if (order.tableNumber) {
    lines.push("********************************");
    lines.push(`**  TABLE: ${String(order.tableNumber).padEnd(20, " ")}**`);
    lines.push("********************************");
  }
  lines.push("");

  // Customer Info (Takeaway only)
  if (order.serviceType === "TAKEAWAY") {
    if (order.customerName) {
      lines.push(`  Customer: ${order.customerName}`);
    }
    if (order.customerMobile) {
      lines.push(`  Mobile: ${order.customerMobile}`);
    }
    if (order.customerName || order.customerMobile) {
      lines.push("");
    }
  }

  // Order Reference
  const orderId = (order._id || "").toString().slice(-8).toUpperCase();
  lines.push(`  Order Ref: ${orderId}`);
  lines.push("");
  lines.push("=".repeat(32));
  lines.push("");

  // Items Header
  lines.push("   ITEMS TO PREPARE:");
  lines.push("");
  lines.push("-".repeat(32));

  // Items List
  if (kot.items && Array.isArray(kot.items)) {
    kot.items.forEach((item, idx) => {
      if (item.returned) {
        lines.push("");
        lines.push(`  X [CANCELLED] ${item.name}`);
        lines.push("");
      } else {
        lines.push("");
        // Quantity in bold-like format
        const qtyDisplay = `[${item.quantity}x]`;
        lines.push(`  ${qtyDisplay} ${item.name}`);
        
        // Special instructions if any
        if (item.specialInstructions) {
          lines.push(`      Note: ${item.specialInstructions}`);
        }
      }
    });
  }

  lines.push("");
  lines.push("-".repeat(32));
  lines.push("");

  // Total items count
  const activeItems = (kot.items || []).filter(i => !i.returned);
  const totalQty = activeItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
  lines.push(`  Total Items: ${activeItems.length}`);
  lines.push(`  Total Quantity: ${totalQty}`);
  lines.push("");

  // Footer
  lines.push("=".repeat(32));
  lines.push("   Prepare with care!");
  lines.push("   Terra Cart Kitchen");
  lines.push("=".repeat(32));
  lines.push("");
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
