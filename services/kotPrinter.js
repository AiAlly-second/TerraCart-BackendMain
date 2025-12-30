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
  // Validate inputs
  if (!order) {
    console.error("[PRINTER] Cannot print KOT - order is missing");
    return { success: false, error: "Order is required" };
  }
  
  if (!kot) {
    console.error(`[PRINTER] Cannot print KOT - KOT data is missing for order ${order._id}`);
    return { success: false, error: "KOT data is required" };
  }

  if (!PRINTER_ENABLED) {
    console.log("[PRINTER] Printing disabled in configuration");
    return { success: false, message: "Printer disabled" };
  }

  // Validate printer configuration
  if (!PRINTER_IP || !PRINTER_PORT) {
    console.error("[PRINTER] Printer IP or Port not configured", {
      PRINTER_IP: PRINTER_IP || "NOT SET",
      PRINTER_PORT: PRINTER_PORT || "NOT SET",
    });
    return { success: false, error: "Printer configuration missing" };
  }

  console.log(`[PRINTER] Attempting to print KOT for order ${order._id} to ${PRINTER_IP}:${PRINTER_PORT}`, {
    orderId: order._id,
    kotIndex: kotIndex,
    hasKotItems: !!(kot && kot.items && Array.isArray(kot.items)),
    kotItemsCount: kot?.items?.length || 0,
  });

  try {
    // Create network printer connection
    const device = new escposNetwork(PRINTER_IP, PRINTER_PORT);
    const printer = new escpos.Printer(device);

    // Add timeout to prevent hanging
    const timeout = 10000; // 10 seconds timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Printer connection timeout after ${timeout}ms`));
      }, timeout);
    });

    const printPromise = new Promise((resolve, reject) => {
      let isResolved = false;
      
      const handleError = (error, context) => {
        if (isResolved) return;
        isResolved = true;
        console.error(`[PRINTER] ${context}:`, error);
        reject({ success: false, error: error.message || error.toString(), context });
      };

      const handleSuccess = (message) => {
        if (isResolved) return;
        isResolved = true;
        console.log(`[PRINTER] ${message}`);
        resolve({ success: true, message: "KOT printed successfully" });
      };

      device.open((error) => {
        if (error) {
          handleError(error, "Connection error");
          return;
        }

        console.log(`[PRINTER] Connected to ${PRINTER_IP}:${PRINTER_PORT}`);

        // Format KOT content
        const kotContent = formatKOT(order, kot, kotIndex);
        console.log(`[PRINTER] KOT content length: ${kotContent.length} characters`);

        // Print KOT with error handling
        try {
          printer
            .font("a")
            .align("ct")
            .text(kotContent)
            .cut()
            .close((err) => {
              if (err) {
                handleError(err, "Print error");
              } else {
                handleSuccess(`KOT printed successfully for order ${order._id}`);
              }
            });
        } catch (printErr) {
          handleError(printErr, "Print command error");
        }
      });
    });

    // Race between print promise and timeout
    return await Promise.race([printPromise, timeoutPromise]);
  } catch (error) {
    console.error("[PRINTER] Unexpected error:", error);
    return { 
      success: false, 
      error: error.message || error.toString(),
      details: error.stack 
    };
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
