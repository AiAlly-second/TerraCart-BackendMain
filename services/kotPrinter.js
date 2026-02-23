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
function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMultilineNote(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function wrapText(text, maxChars = 32) {
  const normalized = sanitizeText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const words = normalized.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((`${current} ${word}`).length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapMultilineNote(text, maxChars = 32) {
  const normalized = normalizeMultilineNote(text);
  if (!normalized.trim()) return [];
  return normalized.split("\n");
}

function resolveServiceLabel(order = {}) {
  const serviceType = String(order.serviceType || "")
    .trim()
    .toUpperCase();
  const orderType = String(order.orderType || "")
    .trim()
    .toUpperCase();

  if (
    serviceType === "DELIVERY" ||
    (serviceType === "TAKEAWAY" && orderType === "DELIVERY")
  ) {
    return "DELIVERY";
  }
  if (
    serviceType === "PICKUP" ||
    (serviceType === "TAKEAWAY" && orderType === "PICKUP")
  ) {
    return "TAKEAWAY";
  }
  if (serviceType === "TAKEAWAY") return "TAKEAWAY";
  return "DINE-IN";
}

function isTakeawayLike(order = {}) {
  return resolveServiceLabel(order) !== "DINE-IN";
}

function collectItemModifiers(item = {}) {
  const buckets = [
    item.extras,
    item.addOns,
    item.addons,
    item.modifiers,
    item.variants,
  ];
  const names = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry) continue;
      if (typeof entry === "string") {
        const text = sanitizeText(entry);
        if (text) names.push(text);
        continue;
      }
      const name = sanitizeText(entry.name || entry.label || entry.value);
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

function resolveOrderNote(order = {}, kot = {}) {
  const candidates = [
    order.specialInstructions,
    order.specialInstruction,
    order.orderNote,
    order.note,
    order.notes,
    kot.specialInstructions,
    kot.note,
  ];
  for (const candidate of candidates) {
    const text = normalizeMultilineNote(candidate);
    if (text.trim()) return text;
  }
  return "";
}

function formatKOT(order, kot, kotIndex = 0) {
  const maxChars = 32;
  const separator = "-".repeat(maxChars);
  const lines = [];

  const outletName = sanitizeText(order?.cartName || order?.cafeName || "TERRA CART");
  const explicitKotNumber = Number(kot?.kotNumber);
  const kotNumber =
    Number.isFinite(explicitKotNumber) && explicitKotNumber > 0
      ? explicitKotNumber
      : kotIndex + 1;

  const orderRef = String(order?._id || "")
    .trim()
    .slice(-8)
    .toUpperCase();
  const serviceLabel = resolveServiceLabel(order);
  const takeawayLike = isTakeawayLike(order);
  const tableLabel = sanitizeText(order?.tableNumber || "");
  const tokenLabel = takeawayLike ? sanitizeText(order?.takeawayToken || "") : "";
  const orderNote = resolveOrderNote(order, kot);

  const timestampCandidate = kot?.createdAt || order?.createdAt || order?.updatedAt;
  const parsedTimestamp = timestampCandidate
    ? new Date(timestampCandidate)
    : null;
  const printDate =
    parsedTimestamp instanceof Date && !Number.isNaN(parsedTimestamp.getTime())
      ? parsedTimestamp
      : new Date();
  const dateLabel = printDate.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

  lines.push(outletName || "TERRA CART");
  lines.push(`KOT #${String(kotNumber).padStart(2, "0")} ${serviceLabel}`);
  lines.push(dateLabel);
  lines.push(separator);

  if (!takeawayLike && tableLabel) {
    lines.push(`Table: ${tableLabel}`);
  }
  if (takeawayLike && serviceLabel !== "DELIVERY" && tokenLabel) {
    lines.push(`Token: ${tokenLabel}`);
  }
  if (orderRef) {
    lines.push(`Ref: ${orderRef}`);
  }
  if (orderNote) {
    lines.push("Note:");
    for (const wrapped of wrapMultilineNote(orderNote, maxChars)) {
      lines.push(wrapped || " ");
    }
  }
  lines.push(separator);

  const items = Array.isArray(kot?.items) ? kot.items : [];
  const activeItems = items.filter((item) => item && item.returned !== true);

  if (!activeItems.length) {
    lines.push("No items");
  } else {
    for (const item of activeItems) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      const name = sanitizeText(item.name || "Item");
      const itemLines = wrapText(`${qty} x ${name}`, maxChars);
      itemLines.forEach((line) => lines.push(line));

      const modifiers = collectItemModifiers(item);
      for (const modifier of modifiers) {
        const wrapped = wrapText(`+ ${modifier}`, maxChars - 2);
        wrapped.forEach((line) => lines.push(`  ${line}`));
      }

      const itemNote = sanitizeText(item.specialInstructions || item.note || "");
      if (itemNote) {
        const wrapped = wrapText(`Note: ${itemNote}`, maxChars - 2);
        wrapped.forEach((line) => lines.push(`  ${line}`));
      }
    }
  }

  const selectedAddons = Array.isArray(order?.selectedAddons)
    ? order.selectedAddons.filter((addon) => addon && Number(addon.quantity || 1) > 0)
    : [];
  for (const addon of selectedAddons) {
    const qty = Math.max(1, Number(addon.quantity) || 1);
    const name = sanitizeText(addon.name || "Add-on");
    const wrapped = wrapText(`+ ${qty} x ${name}`, maxChars - 2);
    wrapped.forEach((line) => lines.push(`  ${line}`));
  }

  const totalQty = activeItems.reduce(
    (sum, item) => sum + (Number(item?.quantity) || 0),
    0,
  );
  lines.push(separator);
  lines.push(`Items: ${activeItems.length}  Qty: ${totalQty}`);
  lines.push("");
  lines.push("");
  lines.push("");

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
          .align("lt")
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
