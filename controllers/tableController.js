const crypto = require("crypto");
const mongoose = require("mongoose");
const { Table, TABLE_STATUSES } = require("../models/tableModel");
const Order = require("../models/orderModel");
const Waitlist = require("../models/waitlistModel");
const Employee = require("../models/employeeModel");
const { notifyNextWaitlist } = require("./waitlistController");
const {
  shouldDisplayInActiveQueues,
} = require("../utils/orderContract");

const activeWaitlistStatuses = ["WAITING", "NOTIFIED"];

const countActiveWaitlist = (tableId) =>
  Waitlist.countDocuments({
    table: tableId,
    status: { $in: activeWaitlistStatuses },
  });

// Helper function to build query based on user role
const buildHierarchyQuery = async (user) => {
  const query = {};
  if (user && user.role === "admin" && user._id) {
    query.cartId = user._id;
  } else if (user && user.role === "franchise_admin" && user._id) {
    query.franchiseId = user._id;
  } else if (
    user &&
    ["waiter", "cook", "captain", "manager"].includes(user.role)
  ) {
    // Mobile users: always prefer latest Employee mapping (source of truth),
    // then fallback to cartId/cafeId on the user document.
    let employee = null;
    if (user.employeeId) {
      employee = await Employee.findById(user.employeeId).lean();
    }
    if (!employee) {
      employee = await Employee.findOne({
        $or: [{ userId: user._id }, { email: user.email?.toLowerCase() }],
      }).lean();
    }

    const employeeCartId = employee?.cartId || employee?.cafeId;
    if (employeeCartId) {
      query.cartId = employeeCartId;
      console.log("[TABLE] buildHierarchyQuery - Mobile employee mapping:", {
        userId: user._id,
        role: user.role,
        email: user.email,
        employeeId: employee?._id,
        employeeCartId,
      });
    } else if (user.cartId || user.cafeId) {
      query.cartId = user.cartId || user.cafeId;
      console.log("[TABLE] buildHierarchyQuery - Mobile user fallback:", {
        userId: user._id,
        role: user.role,
        email: user.email,
        userCartId: user.cartId || null,
        userCafeId: user.cafeId || null,
        queryCartId: query.cartId,
      });
    } else {
      console.log("[TABLE] buildHierarchyQuery - No cart mapping for mobile user:", {
        userId: user._id,
        role: user.role,
        email: user.email,
      });
    }
  } else if (user && user.role === "employee") {
    // Legacy employee role - look up Employee by userId or email
    const employee = await Employee.findOne({
      $or: [{ userId: user._id }, { email: user.email?.toLowerCase() }],
    }).lean();
    if (employee && (employee.cartId || employee.cafeId)) {
      query.cartId = employee.cartId || employee.cafeId;
    } else if (user.cartId || user.cafeId) {
      query.cartId = user.cartId || user.cafeId;
    }
  }
  return query;
};

const getWaitlistPosition = async (entry) => {
  if (!entry) return 0;

  // For WAITING entries, count all WAITING and NOTIFIED entries created before them
  // For deterministic ordering when timestamps are identical, also consider entries with same createdAt but smaller _id
  if (entry.status === "WAITING") {
    const ahead = await Waitlist.countDocuments({
      table: entry.table,
      status: { $in: ["WAITING", "NOTIFIED"] },
      $or: [
        { createdAt: { $lt: entry.createdAt } },
        {
          createdAt: entry.createdAt,
          _id: { $lt: entry._id },
        },
      ],
    });
    return ahead + 1;
  }

  // For NOTIFIED entries, count all WAITING and NOTIFIED entries created before them
  if (entry.status === "NOTIFIED") {
    const ahead = await Waitlist.countDocuments({
      table: entry.table,
      status: { $in: ["WAITING", "NOTIFIED"] },
      $or: [
        { createdAt: { $lt: entry.createdAt } },
        {
          createdAt: entry.createdAt,
          _id: { $lt: entry._id },
        },
      ],
    });
    return ahead + 1;
  }

  // For SEATED or CANCELLED, return 0
  return 0;
};

const sanitizeTextField = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};

const sanitizePhoneField = (value) => {
  const normalized = sanitizeTextField(value);
  if (!normalized) return null;
  const compact = normalized.replace(/\s+/g, "");
  return compact.length ? compact : null;
};

const parseNonNegativeNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Number(parsed.toFixed(2));
};

const sanitizeOfficePaymentMode = (value, fallback = "ONLINE") => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "COD") return "COD";
  if (normalized === "BOTH") return "BOTH";
  if (normalized === "ONLINE") return "ONLINE";
  return fallback;
};

const normalizeQrContextPayload = (input = {}) => {
  const qrContextTypeRaw =
    input.qrContextType === "OFFICE" ? "OFFICE" : "TABLE";

  const officeName = sanitizeTextField(input.officeName);
  const officeAddress = sanitizeTextField(input.officeAddress);
  const officePhone = sanitizePhoneField(input.officePhone);
  const officeDeliveryCharge = parseNonNegativeNumber(
    input.officeDeliveryCharge,
    0
  );
  const officePaymentMode = sanitizeOfficePaymentMode(
    input.officePaymentMode,
    "ONLINE"
  );

  return {
    qrContextType: qrContextTypeRaw,
    officeName: qrContextTypeRaw === "OFFICE" ? officeName : null,
    officeAddress: qrContextTypeRaw === "OFFICE" ? officeAddress : null,
    officePhone: qrContextTypeRaw === "OFFICE" ? officePhone : null,
    officeDeliveryCharge:
      qrContextTypeRaw === "OFFICE" ? officeDeliveryCharge : 0,
    officePaymentMode:
      qrContextTypeRaw === "OFFICE" ? officePaymentMode : "ONLINE",
  };
};

const isOfficeQrContext = (tableLike = {}) => {
  if (!tableLike || typeof tableLike !== "object") return false;
  if (tableLike.qrContextType === "OFFICE") return true;

  return !!(
    String(tableLike.officeName || "").trim() ||
    String(tableLike.officeAddress || "").trim() ||
    String(tableLike.officePhone || "").trim() ||
    Number(tableLike.officeDeliveryCharge || 0) > 0
  );
};

const buildPublicTableResponse = (table, waitlistLength = 0, options = {}) => {
  // CRITICAL: Validate table parameter to prevent "Cannot access 'table' before initialization" errors
  if (!table) {
    console.error("[buildPublicTableResponse] Table parameter is null or undefined");
    throw new Error("Table parameter is required");
  }

  const isOfficeQr = isOfficeQrContext(table);
  const payload = {
    id: table._id,
    number: table.number,
    name: table.name,
    capacity: table.capacity,
    originalCapacity: table.originalCapacity || null, // Include originalCapacity for merged tables
    status: isOfficeQr ? "AVAILABLE" : table.status,
    qrSlug: table.qrSlug,
    currentOrder: isOfficeQr ? null : table.currentOrder || null,
    waitlistLength: isOfficeQr ? 0 : waitlistLength,
    // CRITICAL: Include cartId so frontend can filter menu by cart
    cartId: table.cartId || null,
    cafeId: table.cartId || null, // Alias for compatibility
    qrContextType: table.qrContextType || "TABLE",
    officeName: table.officeName || null,
    officeAddress: table.officeAddress || null,
    officePhone: table.officePhone || null,
    officeDeliveryCharge: Number(table.officeDeliveryCharge || 0),
    officePaymentMode:
      isOfficeQr
        ? sanitizeOfficePaymentMode(table.officePaymentMode, "ONLINE")
        : null,
  };

  if (options.includeSessionToken) {
    payload.sessionToken = isOfficeQr ? null : table.sessionToken || null;
  }
  return payload;
};

const generateSlug = () => crypto.randomBytes(8).toString("hex");
const generateToken = () => crypto.randomBytes(10).toString("hex");

// Helper function to clean up old orders when a new session starts
// This removes ALL non-paid orders for the table to ensure a clean slate for new session
async function cleanupOldSessionOrders(tableId, oldSessionToken = null) {
  try {
    const { Payment } = require("../models/paymentModel");

    // Build query to find orders that are still active in operational queues.
    const oldOrders = await Order.find({ table: tableId });
    const activeOrders = oldOrders.filter((order) =>
      shouldDisplayInActiveQueues(order),
    );

    if (activeOrders.length > 0) {
      console.log(
        `[TABLE] Cleaning up ${
          activeOrders.length
        } old orders for table ${tableId} (old sessionToken: ${
          oldSessionToken || "none"
        })`
      );

      // Delete associated non-paid payments
      for (const order of activeOrders) {
        try {
          const payments = await Payment.find({ orderId: order._id });
          for (const payment of payments) {
            // Only delete non-paid payments
            if (payment.status !== "PAID") {
              await Payment.findByIdAndDelete(payment._id);
              console.log(
                `[TABLE] Deleted non-paid payment ${payment._id} for order ${order._id}`
              );
            }
          }
        } catch (err) {
          console.error(
            `[TABLE] Error deleting payments for order ${order._id}:`,
            err
          );
        }
      }

      // Delete all non-paid orders for this table
      const deleteResult = await Order.deleteMany({
        _id: { $in: activeOrders.map((order) => order._id) },
      });
      console.log(
        `[TABLE] Deleted ${deleteResult.deletedCount} old orders for table ${tableId}`
      );
    } else {
      console.log(`[TABLE] No old orders to clean up for table ${tableId}`);
    }
  } catch (err) {
    console.error(
      `[TABLE] Error cleaning up old session orders for table ${tableId}:`,
      err
    );
  }
}

let sessionTokenIndexEnsured = false;
async function ensureSessionTokenIndex() {
  if (sessionTokenIndexEnsured) {
    return;
  }

  try {
    const collection = Table.collection;
    if (!collection) {
      return;
    }

    await Table.updateMany(
      { sessionToken: null },
      { $unset: { sessionToken: "" } }
    );

    const indexes = await collection.indexes();
    const sessionIndex = indexes.find((idx) => idx.name === "sessionToken_1");

    let needsCreate = false;
    if (sessionIndex) {
      const isSparse = Boolean(sessionIndex.sparse);
      const isUnique = Boolean(sessionIndex.unique);
      if (isUnique || !isSparse) {
        try {
          await collection.dropIndex("sessionToken_1");
        } catch (err) {
          if (err.codeName !== "IndexNotFound") {
            throw err;
          }
        }
        needsCreate = true;
      }
    } else {
      needsCreate = true;
    }

    if (needsCreate) {
      try {
        await collection.createIndex(
          { sessionToken: 1 },
          { sparse: true, name: "sessionToken_1" }
        );
      } catch (err) {
        if (err.codeName !== "IndexOptionsConflict") {
          throw err;
        }
      }
    }

    sessionTokenIndexEnsured = true;
  } catch (err) {
    console.warn("Failed to ensure sessionToken index", err);
  }
}

async function syncTableFields() {
  await ensureSessionTokenIndex();
  const docs = await Table.find({
    $or: [
      { tableNumber: { $exists: false } },
      { tableNumber: null },
      { tableNumber: "" },
      { qrSlug: { $exists: false } },
      { qrSlug: null },
      { qrToken: { $exists: false } },
      { qrToken: null },
    ],
  }).select("number tableNumber qrSlug qrToken");

  if (!docs.length) return;

  for (const doc of docs) {
    if (doc.number && !doc.tableNumber) {
      doc.tableNumber = String(doc.number);
    }
    if (!doc.number && doc.tableNumber) {
      const parsed = Number(doc.tableNumber);
      if (Number.isFinite(parsed) && parsed > 0) {
        doc.number = parsed;
      }
    }
    if (!doc.qrSlug) {
      doc.qrSlug = generateSlug();
    }
    if (!doc.qrToken) {
      doc.qrToken = doc.qrSlug || generateToken();
    }
    await doc.save();
  }
}

exports.listTables = async (req, res) => {
  try {
    await syncTableFields();

    // Build query based on user role (handles mobile roles too)
    const query = await buildHierarchyQuery(req.user);

    // Removed verbose logging

    // If query is empty (no cartId/franchiseId), return empty array
    // This prevents returning all tables when user has no associated cart
    if (Object.keys(query).length === 0) {
      // Empty query - returning empty array
      return res.json({
        success: true,
        data: [],
      });
    }

    // CRITICAL: Ensure we only return tables that have a cartId matching the query
    // Convert cartId to string for comparison if needed
    if (query.cartId) {
      // Ensure cartId is properly formatted (ObjectId or string)
      // mongoose is already imported at the top of the file (line 2), no need to require again
      if (mongoose.Types.ObjectId.isValid(query.cartId)) {
        query.cartId = new mongoose.Types.ObjectId(query.cartId);
      }
    }

    // Find tables and ensure no duplicates by table number within the same cafe
    // Only return tables that match the query exactly
    // Populate mergedWith to ensure it's included in the response
    const tables = await Table.find(query)
      .populate("mergedWith", "number")
      .sort({ number: 1, updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    // Additional safety: Filter out any tables that don't match the cartId exactly
    // This prevents returning tables from other carts due to query issues
    const filteredTables = tables.filter((table) => {
      if (query.cartId) {
        const tableCartId = table.cartId?.toString();
        const queryCartId = query.cartId.toString();
        if (tableCartId !== queryCartId) {
          // Filtering out table - cartId mismatch
          return false;
        }
      }
      return true;
    });

    // Found tables

    const hasValidQrSlug = (table = {}) =>
      String(table?.qrSlug || "").trim().length > 0;
    const hasValidQrContext = (table = {}) =>
      ["TABLE", "OFFICE"].includes(
        String(table?.qrContextType || "").trim().toUpperCase(),
      );
    const tableFreshnessScore = (table = {}) => {
      const ts = new Date(table?.updatedAt || table?.createdAt || 0).getTime();
      return Number.isFinite(ts) ? ts : 0;
    };
    const tableQualityScore = (table = {}) => {
      let score = 0;
      if (hasValidQrSlug(table)) score += 3;
      if (hasValidQrContext(table)) score += 2;
      if (table?.cartId || table?.cafeId) score += 1;
      // Recency acts as tie-breaker between duplicate logical tables.
      score += tableFreshnessScore(table) / 1e15;
      return score;
    };

    // Deduplicate by cart + table number and prefer new QR-system records.
    const tableByLogicalKey = new Map();
    for (const table of filteredTables) {
      // Old/invalid records without slug should never surface in modern QR flows.
      if (!hasValidQrSlug(table)) continue;
      if (!hasValidQrContext(table)) continue;
      const key = `${table.cartId || table.cafeId || "unknown"}-${
        table.number
      }`;
      if (!tableByLogicalKey.has(key)) {
        tableByLogicalKey.set(key, table);
        continue;
      }

      const existing = tableByLogicalKey.get(key);
      if (tableQualityScore(table) > tableQualityScore(existing)) {
        tableByLogicalKey.set(key, table);
      }
    }

    const uniqueTables = Array.from(tableByLogicalKey.values());

    // After deduplication

    // Populate mergedTables and mergedWith for capacity calculation
    const tablesWithMerged = await Table.find({
      _id: { $in: uniqueTables.map((t) => t._id) },
    })
      .populate("mergedTables", "number capacity originalCapacity")
      .populate("mergedWith", "number capacity")
      .lean();

    const tableMap = new Map();
    tablesWithMerged.forEach((t) => {
      tableMap.set(t._id.toString(), t);
    });

    const enriched = await Promise.all(
      uniqueTables.map(async (tableItem) => {
        // CRITICAL: Use tableItem instead of table to avoid variable shadowing issues
        // This prevents "Cannot access 'table' before initialization" errors
        if (!tableItem) {
          console.warn("[Table] listTables: tableItem is null or undefined");
          return null;
        }
        
        // Ensure table status is correct - if no current order, it should be AVAILABLE
        if (!tableItem.currentOrder && tableItem.status === "OCCUPIED") {
          // Auto-fix: Update table status if it's incorrectly marked as OCCUPIED
          try {
            // CRITICAL: Use Table model (imported at top) instead of any local variable
            await Table.findByIdAndUpdate(tableItem._id, {
              status: "AVAILABLE",
              currentOrder: null,
              sessionToken: undefined,
              lastAssignedAt: null,
            });
            tableItem.status = "AVAILABLE";
            tableItem.currentOrder = null;
          } catch (err) {
            console.error(
              `[TABLE] Failed to auto-fix table ${tableItem._id}:`,
              err
            );
          }
        }

        // Get table with merged data
        const tableWithMerged = tableMap.get(tableItem._id.toString()) || tableItem;

        // Calculate capacity display (same logic as dashboard)
        let originalCapacity = tableItem.capacity || 0;
        let totalCapacity = tableItem.capacity || 0;

        if (
          tableWithMerged.mergedTables &&
          tableWithMerged.mergedTables.length > 0
        ) {
          // Primary table with merged tables
          // tableItem.capacity already includes merged tables' capacities
          originalCapacity =
            tableWithMerged.originalCapacity || tableItem.capacity || 0; // Original before merge
          totalCapacity = tableItem.capacity || 0; // Current capacity (includes merged)
        } else if (tableWithMerged.mergedWith) {
          // Secondary table merged into another
          originalCapacity =
            tableWithMerged.originalCapacity || tableItem.capacity || 0; // Original before merge
          totalCapacity = originalCapacity; // Secondary tables don't have merged capacity themselves
        } else {
          // Regular table (not merged)
          originalCapacity = tableItem.capacity || 0;
          totalCapacity = tableItem.capacity || 0;
        }

        return {
          ...tableItem,
          capacity: originalCapacity, // Original/base capacity for display
          totalCapacity, // Total capacity including merged tables (for primary tables)
          mergedWith: tableWithMerged.mergedWith
            ? typeof tableWithMerged.mergedWith === "object"
              ? tableWithMerged.mergedWith._id
              : tableWithMerged.mergedWith
            : null, // Include mergedWith field
          mergedTables: tableWithMerged.mergedTables || [], // Include mergedTables field
          waitlistLength: await countActiveWaitlist(tableItem._id),
        };
      })
    ).then(results => results.filter(item => item !== null)); // Filter out any null results

    return res.json({
      success: true,
      data: enriched,
    });
  } catch (err) {
    console.error("Error in listTables:", err);
    // CRITICAL: Check if error is related to table variable initialization
    if (err.message && err.message.includes("Cannot access 'table' before initialization")) {
      console.error("[Table] CRITICAL: Table variable initialization error detected in listTables");
      console.error("[Table] Error details:", {
        message: err.message,
        stack: err.stack,
        userId: req.user?._id,
        userRole: req.user?.role,
      });
      // Return a more helpful error message
      return res.status(500).json({
        message: "Internal server error: Table initialization issue. Please try again.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
    return res.status(500).json({ 
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

exports.getAvailableTables = async (req, res) => {
  try {
    await syncTableFields();
    const { cartId } = req.query;
    const query = { status: "AVAILABLE" };
    if (cartId) query.cartId = cartId;

    const tables = await Table.find(query)
      .sort({ number: 1 })
      .lean();
    const enriched = await Promise.all(
      tables.map(async (table) =>
        buildPublicTableResponse(table, await countActiveWaitlist(table._id))
      )
    );
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Public endpoint to get all tables for a specific cart (for manual selection fallback)
exports.getPublicTables = async (req, res) => {
  try {
    await syncTableFields();
    const { cartId } = req.query;
    
    // CRITICAL: Must have cartId to prevent global table leakage
    if (!cartId) {
      return res.status(400).json({ message: "cartId is required for public table listing" });
    }

    const tables = await Table.find({ cartId })
      .sort({ number: 1 })
      .lean();

    const enriched = await Promise.all(
      tables.map(async (table) =>
        buildPublicTableResponse(table, await countActiveWaitlist(table._id))
      )
    );
    
    return res.json(enriched);
  } catch (err) {
    console.error("Error in getPublicTables:", err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Public: get cartId for a table by table ID (for customer cart page when only table ID is in URL)
 */
exports.getCartIdByTableId = async (req, res) => {
  try {
    const { tableId } = req.params;
    if (!tableId || !mongoose.Types.ObjectId.isValid(tableId)) {
      return res.status(400).json({ success: false, message: "Invalid table ID" });
    }
    const table = await Table.findById(tableId).select("cartId").lean();
    if (!table || !table.cartId) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }
    return res.json({ success: true, cartId: table.cartId.toString() });
  } catch (err) {
    console.error("Error in getCartIdByTableId:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.lookupTableBySlug = async (req, res) => {
  try {
    await syncTableFields();
    let { slug } = req.params;
    let { waitToken, sessionToken: clientSessionToken } = req.query;

    // Decode URL-encoded slug (in case it was encoded)
    if (slug) {
      try {
        slug = decodeURIComponent(slug);
      } catch (e) {
        // If decoding fails, use original slug
        console.warn("[Table Lookup] Failed to decode slug:", slug, e);
      }
    }

    // Sanitize waitToken - remove any trailing :number pattern (e.g., "token:1" -> "token")
    // This can happen if the token gets corrupted in localStorage or URL
    if (waitToken) {
      waitToken = waitToken.replace(/:\d+$/, "");
    }

    // Log the lookup attempt for debugging (only in production if needed)
    if (
      process.env.NODE_ENV === "production" &&
      process.env.ENABLE_REQUEST_LOGGING === "true"
    ) {
      console.log(`[Table Lookup] Looking for table with slug: ${slug}`);
    }

    // Try exact match first (case-sensitive)
    let table = await Table.findOne({ qrSlug: slug });

    // If not found, try case-insensitive match (in case of encoding issues)
    if (!table && slug) {
      table = await Table.findOne({
        qrSlug: { $regex: new RegExp(`^${slug}$`, "i") },
      });

      if (table) {
        console.warn(
          `[Table Lookup] Found table with case-insensitive match. Expected: ${slug}, Found: ${table.qrSlug}`
        );
      }
    }

    if (!table) {
      // Log available slugs for debugging (only in development or if explicitly enabled)
      if (
        process.env.NODE_ENV !== "production" ||
        process.env.ENABLE_DEBUG_LOGGING === "true"
      ) {
        const sampleTables = await Table.find({})
          .select("qrSlug number")
          .limit(5)
          .lean();
        console.log(`[Table Lookup] Table not found. Slug searched: ${slug}`);
        console.log(
          `[Table Lookup] Sample table slugs in DB:`,
          sampleTables.map((t) => ({ number: t.number, qrSlug: t.qrSlug }))
        );
      }
      return res.status(404).json({ message: "Table not found" });
    }

    // OFFICE QR is takeaway-only. Do not apply table waitlist/session ownership logic.
    if (isOfficeQrContext(table)) {
      const officePayload = {
        ...buildPublicTableResponse(table, 0),
        status: "AVAILABLE",
        waitlistLength: 0,
      };

      return res.json({
        table: officePayload,
        sessionToken: null,
        waitlist: null,
      });
    }

    // Check if table is merged - handle merged tables first
    if (table.status === "MERGED" || table.mergedWith) {
      // This is a secondary table that has been merged
      let primaryTable = null;
      let primaryTableNumber = null;

      if (table.mergedWith) {
        primaryTable = await Table.findById(table.mergedWith);
        if (primaryTable) {
          primaryTableNumber = primaryTable.number;
        }
      }

      return res.status(400).json({
        message: `This table (Table ${
          table.number
        }) has been merged with Table ${
          primaryTableNumber || "another table"
        }. Please scan the primary table's QR code to place your order.`,
        isMerged: true,
        mergedTable: {
          number: table.number,
          mergedWith: primaryTableNumber,
        },
        primaryTable: primaryTable
          ? {
              number: primaryTable.number,
              qrSlug: primaryTable.qrSlug,
            }
          : null,
      });
    }

    const waitlistLength = await countActiveWaitlist(table._id);
    // notifyNextWaitlist is already imported at the top of the file (line 7)
    // No need to require it again here - this was causing potential circular dependency issues

    // CRITICAL: Get user's waitlist entry if provided
    // This is the PRIMARY way to identify the same customer
    let waitlistEntry = null;
    if (waitToken) {
      waitlistEntry = await Waitlist.findOne({ token: waitToken });
      if (
        waitlistEntry &&
        !["WAITING", "NOTIFIED", "SEATED"].includes(waitlistEntry.status)
      ) {
        // Entry exists but is CANCELLED - don't use it
        waitlistEntry = null;
      }
      if (waitlistEntry) {
        console.log(
          `[Table ${table.number}] Found existing waitlist entry via waitToken: ${waitToken}, status: ${waitlistEntry.status}`
        );
      } else if (waitToken) {
        console.log(
          `[Table ${table.number}] WaitToken provided but entry not found or invalid: ${waitToken}`
        );
        // Don't create new entry if waitToken was provided but not found
        // This prevents duplicate entries
      }
    }

    // CRITICAL: Also check if user already has an active waitlist entry for this table
    // This prevents duplicate entries when user scans QR multiple times without waitToken
    if (!waitlistEntry && clientSessionToken) {
      // Check if there's a waitlist entry with this sessionToken
      const existingBySession = await Waitlist.findOne({
        table: table._id,
        sessionToken: clientSessionToken,
        status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
      });
      if (existingBySession) {
        waitlistEntry = existingBySession;
        console.log(
          `[Table ${table.number}] Found existing waitlist entry via sessionToken: ${clientSessionToken}, token: ${existingBySession.token}`
        );
      }
    }

    // CRITICAL: Check if user has an active unpaid order.
    // This allows customers with active orders to access their table without being forced back into waitlist.
    let hasActiveUnpaidOrder = false;
    let activeOrder = null;
    if (table.currentOrder) {
      // Order is already imported at the top of the file (line 4), no need to require again
      try {
        activeOrder = await Order.findById(table.currentOrder).lean();
        if (activeOrder) {
          const isUnpaid = shouldDisplayInActiveQueues(activeOrder);

          // For unpaid orders on this table, allow access if:
          // 1. Order's sessionToken matches client's sessionToken, OR
          // 2. Order's sessionToken matches table's sessionToken, OR
          // 3. No sessionToken on order (legacy order), OR
          // 4. Client has no sessionToken but order exists (user refreshing/navigating)
          const orderBelongsToCustomer =
            !activeOrder.sessionToken || // Legacy order - allow access
            !clientSessionToken || // Client has no session token but order exists - allow access
            activeOrder.sessionToken === clientSessionToken ||
            activeOrder.sessionToken === table.sessionToken;

          if (isUnpaid && orderBelongsToCustomer) {
            hasActiveUnpaidOrder = true;
            console.log(
              `[Table ${table.number}] Found active unpaid order (${activeOrder._id}) - granting access`
            );
          }
        }
      } catch (err) {
        console.warn(
          `[Table ${table.number}] Error checking active order:`,
          err
        );
      }
    }

    // Build candidate session tokens
    const candidateSessionTokens = new Set();
    if (clientSessionToken) {
      candidateSessionTokens.add(clientSessionToken);
    }
    if (waitlistEntry?.status === "SEATED" && waitlistEntry.sessionToken) {
      candidateSessionTokens.add(waitlistEntry.sessionToken);
    }
    // If user has active unpaid order, also add table's sessionToken to candidates
    // This ensures they are recognized as session owner
    if (hasActiveUnpaidOrder && table.sessionToken) {
      candidateSessionTokens.add(table.sessionToken);
    }

    // Check if user is session owner
    // User is session owner if:
    // 1. Table has sessionToken AND it matches one of the candidate tokens, OR
    // 2. User has active unpaid order (even if table.sessionToken doesn't match)
    const isSessionOwner =
      (table.sessionToken && candidateSessionTokens.has(table.sessionToken)) ||
      hasActiveUnpaidOrder;

    let mutated = false;
    let sessionTokenJustIssued = false;

    // REDESIGNED WAITLIST FLOW:
    // Priority order:
    // 1. Session owner always gets access (if they have valid session token)
    // 2. NOTIFIED waitlist entry gets priority when table is AVAILABLE
    // 3. SEATED waitlist entry gets access (they were already seated)
    // 4. Otherwise, follow normal flow

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");

    // CRITICAL: Capture table reference to avoid closure issues
    // This prevents "Cannot access 'table' before initialization" errors
    const currentTable = table;
    
    const emitTableStatus = async () => {
      // Use captured table reference to ensure it's always available
      if (!currentTable) {
        console.warn("[Table] emitTableStatus called but table is not available");
        return;
      }
      
      const tableStatusPayload = {
        id: currentTable._id,
        number: currentTable.number,
        status: currentTable.status,
        currentOrder: currentTable.currentOrder || null,
        sessionToken: currentTable.sessionToken || null,
      };

      // Emit to cafe room (for admin panel)
      if (io && emitToCafe && currentTable.cartId) {
        emitToCafe(
          io,
          currentTable.cartId.toString(),
          "table:status:updated",
          tableStatusPayload
        );
      }

      // Also emit globally so customers can receive real-time updates
      if (io) {
        io.emit("table:status:updated", tableStatusPayload);
      }
    };

    // Check if user has a SEATED waitlist entry
    if (waitlistEntry?.status === "SEATED" && waitlistEntry.sessionToken) {
      // User was already seated - give them access
      // Mark as RESERVED so admin sees the table is taken (OCCUPIED happens when menu/order)
      if (
        !table.sessionToken ||
        table.sessionToken !== waitlistEntry.sessionToken
      ) {
        // Restore their session token
        table.sessionToken = waitlistEntry.sessionToken;
        table.status = "RESERVED";
        mutated = true;
      }

      table.lastAssignedAt = new Date();
      if (mutated) {
        await table.save();
        await emitTableStatus();
      }

      const position = await getWaitlistPosition(waitlistEntry);
      return res.json({
        table: buildPublicTableResponse(table, waitlistLength, {
          includeSessionToken: true,
          sessionOwner: true,
        }),
        sessionToken: table.sessionToken,
        waitlist: {
          token: waitlistEntry.token,
          status: waitlistEntry.status,
          position: position,
          name: waitlistEntry.name || null,
          partySize: waitlistEntry.partySize || 1,
          notifiedAt: waitlistEntry.notifiedAt,
          sessionToken: waitlistEntry.sessionToken,
        },
      });
    }

    // Handle AVAILABLE table
    if (table.status === "AVAILABLE") {
      // Priority 1: Check if user has a NOTIFIED waitlist entry
      if (waitlistEntry && waitlistEntry.status === "NOTIFIED") {
        // This user is NOTIFIED - allow them access
        // Mark as RESERVED once a sessionToken is issued so admin sees not available
        if (!table.sessionToken) {
          // Clean up any old orders before starting new session
          // Note: table.sessionToken is null/undefined here, so oldSessionToken will be null
          const oldSessionToken = table.sessionToken || null; // Save old token if exists
          await cleanupOldSessionOrders(table._id, oldSessionToken);
          table.sessionToken = generateToken();
          table.status = "RESERVED";
          mutated = true;
          sessionTokenJustIssued = true;
        } else if (table.sessionToken !== waitlistEntry.sessionToken) {
          // Table has a different sessionToken - clean up old session orders
          await cleanupOldSessionOrders(table._id, table.sessionToken);
          table.sessionToken = waitlistEntry.sessionToken || generateToken();
          table.status = "RESERVED";
          mutated = true;
        }

        table.lastAssignedAt = new Date();
        if (mutated) {
          await table.save();
          await emitTableStatus();
        }

        const position = await getWaitlistPosition(waitlistEntry);
        return res.json({
          table: buildPublicTableResponse(table, waitlistLength, {
            includeSessionToken: true,
            sessionOwner: true,
          }),
          sessionToken: table.sessionToken,
          waitlist: {
            token: waitlistEntry.token,
            status: waitlistEntry.status,
            position: position,
            name: waitlistEntry.name || null,
            partySize: waitlistEntry.partySize || 1,
            notifiedAt: waitlistEntry.notifiedAt,
            sessionToken: null,
          },
        });
      }

      // Priority 2: Check if there's already a NOTIFIED entry (someone else)
      const notifiedEntry = await Waitlist.findOne({
        table: table._id,
        status: "NOTIFIED",
      }).sort({ createdAt: 1 });

      if (notifiedEntry) {
        // Someone else is already NOTIFIED - this user must wait
        // If user has waitToken but entry not found, don't create new entry
        if (!waitlistEntry && waitToken) {
          // waitToken was provided but entry not found - return error
          return res.status(400).json({
            message: "Invalid waitlist token. Please join the waitlist again.",
            table: buildPublicTableResponse(table, waitlistLength),
          });
        }

        if (!waitlistEntry) {
          // CRITICAL: Check if user already has an active waitlist entry for this table
          // This prevents duplicate entries when user scans QR multiple times
          const existingEntry = await Waitlist.findOne({
            table: table._id,
            status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
            $or: [
              { sessionToken: clientSessionToken },
              { token: waitToken },
            ].filter(Boolean), // Remove null/undefined conditions
          });

          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(
              `[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`
            );
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined, // Link to session if available
            });
            console.log(
              `[Table ${table.number}] Created new waitlist entry: ${token}`
            );
          }
        }

        const position = await getWaitlistPosition(waitlistEntry);
        return res.status(423).json({
          table: buildPublicTableResponse(table, waitlistLength, {
            sessionOwner: false,
          }),
          sessionActive: true,
          message: `Table is ready for another guest. You are #${position} in the waitlist.`,
          waitlist: {
            token: waitlistEntry.token,
            status: waitlistEntry.status,
            position: position,
            name: waitlistEntry.name || null,
            partySize: waitlistEntry.partySize || 1,
            notifiedAt: waitlistEntry.notifiedAt,
            sessionToken: null,
          },
        });
      }

      // Priority 3: Check if there are WAITING entries - notify next one
      // CRITICAL: When table is AVAILABLE, notify next waitlist person if any
      // But if current user is NOT the one being notified, they still get direct access
      // (since table is AVAILABLE, new users should not be forced into waitlist)
      const waitingCount = await Waitlist.countDocuments({
        table: table._id,
        status: "WAITING",
      });

      if (waitingCount > 0) {
        // There are people waiting - notify the next one
        const io = req.app?.get("io");
        const nextNotified = await notifyNextWaitlist(table._id, io);

        if (nextNotified) {
          // Someone was just notified - check if it's this user
          if (waitlistEntry && waitlistEntry.token === nextNotified.token) {
            // This user was just notified - allow them to proceed
            // Mark as RESERVED once a sessionToken is issued so admin sees not available
            if (!table.sessionToken) {
              // Clean up any old orders before starting new session
              // Note: table.sessionToken is null/undefined here, so oldSessionToken will be null
              const oldSessionToken = table.sessionToken || null; // Save old token if exists
              await cleanupOldSessionOrders(table._id, oldSessionToken);
              table.sessionToken = generateToken();
              table.status = "RESERVED";
              mutated = true;
              sessionTokenJustIssued = true;
            } else if (table.sessionToken !== nextNotified.sessionToken) {
              // Table has a different sessionToken - clean up old session orders
              await cleanupOldSessionOrders(table._id, table.sessionToken);
              table.sessionToken = nextNotified.sessionToken || generateToken();
              table.status = "RESERVED";
              mutated = true;
            }

            table.lastAssignedAt = new Date();
            if (mutated) {
              await table.save();
              await emitTableStatus();
            }

            const notifiedPosition = await getWaitlistPosition(nextNotified);
            return res.json({
              table: buildPublicTableResponse(table, waitlistLength, {
                includeSessionToken: true,
                sessionOwner: true,
              }),
              sessionToken: table.sessionToken,
              waitlist: {
                token: nextNotified.token,
                status: nextNotified.status,
                position: notifiedPosition,
                name: nextNotified.name || null,
                partySize: nextNotified.partySize || 1,
                notifiedAt: nextNotified.notifiedAt,
                sessionToken: null,
              },
            });
          }
          // CRITICAL: If someone else was notified but table is AVAILABLE,
          // current user should still get direct access (don't force into waitlist)
          // The waitlist logic only applies when table is OCCUPIED or RESERVED
          // Fall through to Priority 4 to allow direct access
        }
      }

      // Priority 4: No one waiting - allow direct access
      // CRITICAL: Keep table as AVAILABLE during lookup - only mark as OCCUPIED when user enters menu

      // CRITICAL: When table is AVAILABLE, always generate a NEW sessionToken
      // This ensures that if someone scans with an old sessionToken, they get a fresh session
      // Previous session is closed and old orders are cleaned up

      const oldSessionToken = table.sessionToken || clientSessionToken; // Save old token if exists

      // Always clean up old orders before starting new session (even if no old sessionToken)
      // This ensures no old order data is shown to the new customer
      await cleanupOldSessionOrders(table._id, oldSessionToken);

      // Generate a NEW sessionToken - this invalidates any old sessionTokens
      table.sessionToken = generateToken();
      mutated = true;
      sessionTokenJustIssued = true;

      console.log(
        `[TABLE] Table ${
          table.number
        } AVAILABLE - generated NEW sessionToken (old: ${
          oldSessionToken || "none"
        })`
      );

      // Keep status as AVAILABLE - don't change to RESERVED

      table.lastAssignedAt = new Date();
      // Keep table status as AVAILABLE - only mark as OCCUPIED when occupyTable is called
      if (mutated) await table.save();

      return res.json({
        table: buildPublicTableResponse(table, waitlistLength, {
          includeSessionToken: true,
          sessionOwner: true,
        }),
        sessionToken: table.sessionToken,
      });
    }

    // Handle OCCUPIED table
    if (table.status === "OCCUPIED") {
      if (isSessionOwner || hasActiveUnpaidOrder) {
        // Session owner or has active unpaid order - allow access
        table.lastAssignedAt = new Date();
        await table.save();

        // If user has active order, return it so frontend can restore order state
        if (hasActiveUnpaidOrder && activeOrder) {
          console.log(
            `[Table ${table.number}] Returning active order ${activeOrder._id} to customer (OCCUPIED table)`
          );
          return res.json({
            table: buildPublicTableResponse(table, waitlistLength, {
              includeSessionToken: true,
              sessionOwner: true,
            }),
            sessionToken: table.sessionToken,
            order: activeOrder,
          });
        }

        return res.json({
          table: buildPublicTableResponse(table, waitlistLength, {
            includeSessionToken: true,
            sessionOwner: true,
          }),
          sessionToken: table.sessionToken,
        });
      } else {
        // Not session owner - add to waitlist
        // CRITICAL: If waitToken provided but entry not found, don't create duplicate
        if (waitToken && !waitlistEntry) {
          // waitToken was provided but entry not found - return error instead of creating duplicate
          return res.status(400).json({
            message:
              "Invalid waitlist token. Your previous waitlist entry may have expired. Please scan again to join waitlist.",
            table: buildPublicTableResponse(table, waitlistLength),
          });
        }

        if (!waitlistEntry) {
          // CRITICAL: Check if user already has an active waitlist entry for this table
          // This prevents duplicate entries when user scans QR multiple times
          const existingEntry = await Waitlist.findOne({
            table: table._id,
            status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
            $or: [
              { sessionToken: clientSessionToken },
              { token: waitToken },
            ].filter(Boolean),
          });

          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(
              `[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`
            );
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined,
            });
            console.log(
              `[Table ${table.number}] Created new waitlist entry: ${token}`
            );
          }
        }

        const position = await getWaitlistPosition(waitlistEntry);
        return res.status(423).json({
          table: buildPublicTableResponse(table, waitlistLength, {
            sessionOwner: false,
          }),
          sessionActive: true,
          message: `Table is currently occupied. You are #${position} in the waitlist.`,
          waitlist: {
            token: waitlistEntry.token,
            status: waitlistEntry.status,
            position: position,
            name: waitlistEntry.name || null,
            partySize: waitlistEntry.partySize || 1,
            notifiedAt: waitlistEntry.notifiedAt,
            sessionToken: null,
          },
        });
      }
    }

    // Handle RESERVED or CLEANING table
    if (["RESERVED", "CLEANING"].includes(table.status)) {
      if (isSessionOwner || hasActiveUnpaidOrder) {
        // Session owner or has active unpaid order - allow access
        table.lastAssignedAt = new Date();
        await table.save();

        // If user has active order, return it
        if (hasActiveUnpaidOrder && table.currentOrder) {
          // Order is already imported at the top of the file (line 4), no need to require again
          try {
            const activeOrder = await Order.findById(table.currentOrder).lean();
            if (activeOrder) {
              console.log(
                `[Table ${table.number}] Returning active order ${activeOrder._id} to customer`
              );
              return res.json({
                table: buildPublicTableResponse(table, waitlistLength, {
                  includeSessionToken: true,
                  sessionOwner: true,
                }),
                sessionToken: table.sessionToken,
                order: activeOrder,
              });
            }
          } catch (err) {
            console.warn(
              `[Table ${table.number}] Error fetching active order:`,
              err
            );
          }
        }

        return res.json({
          table: buildPublicTableResponse(table, waitlistLength, {
            includeSessionToken: true,
            sessionOwner: true,
          }),
          sessionToken: table.sessionToken,
        });
      } else {
        // Not session owner - add to waitlist
        // CRITICAL: If waitToken provided but entry not found, don't create duplicate
        if (waitToken && !waitlistEntry) {
          // waitToken was provided but entry not found - return error instead of creating duplicate
          return res.status(400).json({
            message:
              "Invalid waitlist token. Your previous waitlist entry may have expired. Please scan again to join waitlist.",
            table: buildPublicTableResponse(table, waitlistLength),
          });
        }

        if (!waitlistEntry) {
          // CRITICAL: Check if user already has an active waitlist entry for this table
          // This prevents duplicate entries when user scans QR multiple times
          const existingEntry = await Waitlist.findOne({
            table: table._id,
            status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
            $or: [
              { sessionToken: clientSessionToken },
              { token: waitToken },
            ].filter(Boolean),
          });

          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(
              `[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`
            );
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined,
            });
            console.log(
              `[Table ${table.number}] Created new waitlist entry: ${token}`
            );
          }
        }

        const position = await getWaitlistPosition(waitlistEntry);
        return res.status(423).json({
          table: buildPublicTableResponse(table, waitlistLength, {
            sessionOwner: false,
          }),
          sessionActive: true,
          message: `Table is currently ${table.status.toLowerCase()}. You are #${position} in the waitlist.`,
          waitlist: {
            token: waitlistEntry.token,
            status: waitlistEntry.status,
            position: position,
            name: waitlistEntry.name || null,
            partySize: waitlistEntry.partySize || 1,
            notifiedAt: waitlistEntry.notifiedAt,
            sessionToken: null,
          },
        });
      }
    }

    // Fallback - should not reach here
    return res.status(500).json({ message: "Unexpected table status" });
  } catch (err) {
    console.error("Error in lookupTableBySlug:", err);
    // CRITICAL: Check if error is related to table variable initialization
    if (err.message && err.message.includes("Cannot access 'table' before initialization")) {
      console.error("[Table] CRITICAL: Table variable initialization error detected");
      console.error("[Table] Error details:", {
        message: err.message,
        stack: err.stack,
        slug: req.params?.slug,
      });
      // Return a more helpful error message
      return res.status(500).json({
        message: "Internal server error: Table initialization issue. Please try again.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
    return res.status(500).json({
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

exports.createTable = async (req, res) => {
  try {
    const {
      number,
      name,
      capacity,
      notes,
      qrContextType,
      officeName,
      officeAddress,
      officePhone,
      officeDeliveryCharge,
      officePaymentMode,
    } = req.body;

    const normalizedContext = normalizeQrContextPayload({
      qrContextType,
      officeName,
      officeAddress,
      officePhone,
      officeDeliveryCharge,
      officePaymentMode,
    });
    if (
      normalizedContext.qrContextType === "OFFICE" &&
      !normalizedContext.officeName
    ) {
      return res.status(400).json({
        message: "Office name is required when QR context type is OFFICE",
      });
    }
    if (
      normalizedContext.qrContextType === "OFFICE" &&
      !normalizedContext.officeAddress
    ) {
      return res.status(400).json({
        message: "Office address is required when QR context type is OFFICE",
      });
    }

    // Set cartId and franchiseId if user is cafe admin
    let cartId = null;
    let franchiseId = null;
    if (req.user && req.user.role === "admin" && req.user._id) {
      cartId = req.user._id;
      // Get franchiseId from cafe admin user
      if (req.user.franchiseId) {
        franchiseId = req.user.franchiseId;
      }
    }

    let numericNumber = null;
    const hasNumberInRequest =
      number !== undefined &&
      number !== null &&
      String(number).trim().length > 0;

    if (hasNumberInRequest) {
      numericNumber = Number(number);
      if (!Number.isFinite(numericNumber) || numericNumber <= 0) {
        return res
          .status(400)
          .json({ message: "Table number must be a positive number" });
      }
    } else if (normalizedContext.qrContextType === "OFFICE") {
      const scopeQuery = cartId
        ? { cartId }
        : { $or: [{ cartId: null }, { cartId: { $exists: false } }] };
      const latestTable = await Table.findOne(scopeQuery)
        .sort({ number: -1 })
        .select("number")
        .lean();
      numericNumber = Math.max(1, Number(latestTable?.number || 0) + 1);
    } else {
      return res.status(400).json({ message: "Table number is required" });
    }

    let resolvedCapacity = Number(capacity);
    if (normalizedContext.qrContextType === "OFFICE") {
      if (!Number.isFinite(resolvedCapacity) || resolvedCapacity <= 0) {
        resolvedCapacity = 1;
      }
    } else if (!Number.isFinite(resolvedCapacity) || resolvedCapacity <= 0) {
      return res
        .status(400)
        .json({ message: "Capacity must be a positive number" });
    }

    // Check uniqueness per cafe (cafe admins can have same table numbers)
    // For cafe admins: check if this cafe already has this table number
    // For non-cafe admins: check if any table exists with this number where cartId is null/undefined
    let existing = null;
    if (cartId) {
      existing = await Table.findOne({ number: numericNumber, cartId: cartId });
      if (existing) {
        const existingContext = String(existing.qrContextType || "TABLE")
          .trim()
          .toUpperCase();
        const requestedContext = normalizedContext.qrContextType;

        if (existingContext !== requestedContext) {
          return res.status(409).json({
            message:
              existingContext === "OFFICE"
                ? `Number ${numericNumber} is already used by an Office QR. Use a different number or edit it in Offices.`
                : `Number ${numericNumber} is already used by a Table QR. Use a different number or edit it in Tables.`,
          });
        }

        return res.status(409).json({
          message:
            existingContext === "OFFICE"
              ? "Office QR number already exists for this cafe"
              : "Table number already exists for this cafe",
        });
      }
    } else {
      // For non-cafe admins (super_admin, franchise_admin), check if any table exists with this number
      // where cartId is null or undefined (non-cafe admin tables)
      existing = await Table.findOne({
        number: numericNumber,
        $or: [{ cartId: null }, { cartId: { $exists: false } }],
      });
      if (existing) {
        return res.status(409).json({ message: "Table number already exists" });
      }
    }

    // Generate unique slug - keep trying until we get a unique one
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 10) {
      const existingSlug = await Table.findOne({ qrSlug: slug });
      if (!existingSlug) break;
      slug = generateSlug();
      attempts++;
    }
    if (attempts >= 10) {
      return res.status(500).json({
        message: "Failed to generate unique QR code. Please try again.",
      });
    }

    const table = await Table.create({
      number: numericNumber,
      tableNumber: String(numericNumber),
      name,
      capacity: resolvedCapacity,
      notes,
      qrSlug: slug,
      qrToken: slug,
      cartId: cartId || undefined, // Use undefined instead of null to avoid issues
      franchiseId: franchiseId || undefined, // Set franchiseId from cafe admin
      qrContextType: normalizedContext.qrContextType,
      officeName: normalizedContext.officeName,
      officeAddress: normalizedContext.officeAddress,
      officePhone: normalizedContext.officePhone,
      officeDeliveryCharge: normalizedContext.officeDeliveryCharge,
      officePaymentMode: normalizedContext.officePaymentMode,
    });

    return res.status(201).json(table);
  } catch (err) {
    console.error("Error creating table:", err);
    console.error("Error details:", {
      code: err.code,
      codeName: err.codeName,
      keyPattern: err.keyPattern,
      keyValue: err.keyValue,
      message: err.message,
    });

    // Handle MongoDB duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      if (
        field === "number_1_cartId_1" ||
        (err.keyPattern && err.keyPattern.number && err.keyPattern.cartId)
      ) {
        return res.status(409).json({
          message:
            "Table number already exists for this cafe. If you see this error repeatedly, please run: node scripts/fix-table-indexes.js",
        });
      }
      return res.status(409).json({
        message: `Table ${
          field === "number" ? "number" : field
        } already exists. If this persists, run: node scripts/fix-table-indexes.js`,
      });
    }
    return res.status(500).json({
      message: err.message || "Failed to create table",
      error: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

exports.occupyTable = async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionToken } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    // Verify session token matches (if provided)
    if (
      sessionToken &&
      table.sessionToken &&
      table.sessionToken !== sessionToken
    ) {
      return res.status(403).json({ message: "Invalid session token" });
    }

    // Office QR must stay stateless/multi-customer. Never mark it occupied.
    if (isOfficeQrContext(table)) {
      let officeStateUpdated = false;

      if (table.status !== "AVAILABLE") {
        table.status = "AVAILABLE";
        officeStateUpdated = true;
      }
      if (table.currentOrder) {
        table.currentOrder = null;
        officeStateUpdated = true;
      }
      if (table.sessionToken) {
        table.set("sessionToken", undefined);
        officeStateUpdated = true;
      }
      if (table.lastAssignedAt) {
        table.lastAssignedAt = null;
        officeStateUpdated = true;
      }

      if (officeStateUpdated) {
        await table.save();

        const io = req.app.get("io");
        const emitToCafe = req.app.get("emitToCafe");
        const tableStatusPayload = {
          id: table._id,
          number: table.number,
          status: "AVAILABLE",
          currentOrder: null,
          sessionToken: null,
        };

        if (io && table.cartId && emitToCafe) {
          emitToCafe(
            io,
            table.cartId.toString(),
            "table:status:updated",
            tableStatusPayload
          );
        }

        if (io) {
          io.emit("table:status:updated", tableStatusPayload);
        }
      }

      return res.json({
        success: true,
        table: buildPublicTableResponse(table, 0),
      });
    }

    // CRITICAL: Only mark as OCCUPIED if currently AVAILABLE/RESERVED
    // This ensures table stays AVAILABLE until user enters menu page
    if (table.status === "AVAILABLE" || table.status === "RESERVED") {
      table.status = "OCCUPIED";
      table.lastAssignedAt = new Date();
      if (sessionToken && !table.sessionToken) {
        table.sessionToken = sessionToken;
      }
      await table.save();

      // Emit to cart admin / cafe so status updates in real-time
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");
      const tableStatusPayload = {
        id: table._id,
        number: table.number,
        status: table.status,
        currentOrder: table.currentOrder || null,
        sessionToken: table.sessionToken || null,
      };

      // Emit to cafe room (for admin panel)
      if (io && table.cartId && emitToCafe) {
        emitToCafe(
          io,
          table.cartId.toString(),
          "table:status:updated",
          tableStatusPayload
        );
      }

      // Also emit globally so customers can receive real-time updates
      if (io) {
        io.emit("table:status:updated", tableStatusPayload);
      }
    }
    // If table is already OCCUPIED, do nothing

    return res.json({
      success: true,
      table: buildPublicTableResponse(
        table,
        await countActiveWaitlist(table._id)
      ),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    await ensureSessionTokenIndex();

    // CRITICAL: Fetch table FIRST before using it in any conditionals
    // This prevents "Cannot access 'table' before initialization" errors
    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    const updates = {};
    const allowedFields = [
      "number",
      "name",
      "capacity",
      "status",
      "notes",
      "qrContextType",
      "officeName",
      "officeAddress",
      "officePhone",
      "officeDeliveryCharge",
      "officePaymentMode",
    ];
    for (const field of allowedFields) {
      if (field in req.body) {
        updates[field] = req.body[field];
      }
    }
    
    // CRITICAL: Ensure cartId is preserved - never allow it to be cleared via updates
    // If table doesn't have cartId, try to set it from the user's context
    if (!table.cartId && req.user && req.user.role === "admin") {
      // If table has no cartId but user is cart admin, set it
      updates.cartId = req.user._id;
      console.log(`[TABLE] Setting cartId for table ${table.number} from admin user: ${req.user._id}`);
    }

    if (updates.number !== undefined) {
      const numericNumber = Number(updates.number);
      if (!Number.isFinite(numericNumber) || numericNumber <= 0) {
        return res
          .status(400)
          .json({ message: "Table number must be a positive number" });
      }
      updates.number = numericNumber;
      updates.tableNumber = String(numericNumber);
    }

    if (updates.status && !TABLE_STATUSES.includes(updates.status)) {
      return res.status(400).json({ message: "Invalid table status" });
    }
    if (
      updates.qrContextType !== undefined &&
      !["TABLE", "OFFICE"].includes(updates.qrContextType)
    ) {
      return res.status(400).json({ message: "Invalid QR context type" });
    }

    // Save original status before any updates
    const originalStatus = table.status;

    if (updates.number !== undefined && updates.number !== table.number) {
      // Check for duplicate number within the same cart
      const query = { number: updates.number, _id: { $ne: table._id } };
      if (table.cartId) {
        query.cartId = table.cartId;
      } else {
        // For tables without cartId, ensure no other table without cartId has this number
        query.$or = [{ cartId: null }, { cartId: { $exists: false } }];
      }
      const existing = await Table.findOne(query);
      if (existing) {
        return res
          .status(409)
          .json({ message: "Table number already exists for this cart" });
      }
    }
    
    // CRITICAL: Ensure cartId is preserved - never allow it to be cleared via updates
    // If table doesn't have cartId, try to set it from the user's context
    if (!table.cartId && req.user && req.user.role === "admin") {
      // If table has no cartId but user is cart admin, set it
      updates.cartId = req.user._id;
      console.log(`[TABLE] Setting cartId for table ${table.number} from admin user: ${req.user._id}`);
    }

    const hasQrContextField = [
      "qrContextType",
      "officeName",
      "officeAddress",
      "officePhone",
      "officeDeliveryCharge",
      "officePaymentMode",
    ].some((field) => field in req.body);
    if (hasQrContextField) {
      const normalizedContext = normalizeQrContextPayload({
        qrContextType:
          updates.qrContextType !== undefined
            ? updates.qrContextType
            : table.qrContextType,
        officeName:
          updates.officeName !== undefined
            ? updates.officeName
            : table.officeName,
        officeAddress:
          updates.officeAddress !== undefined
            ? updates.officeAddress
            : table.officeAddress,
        officePhone:
          updates.officePhone !== undefined
            ? updates.officePhone
            : table.officePhone,
        officeDeliveryCharge:
          updates.officeDeliveryCharge !== undefined
            ? updates.officeDeliveryCharge
            : table.officeDeliveryCharge,
        officePaymentMode:
          updates.officePaymentMode !== undefined
            ? updates.officePaymentMode
            : table.officePaymentMode,
      });

      if (
        normalizedContext.qrContextType === "OFFICE" &&
        !normalizedContext.officeName
      ) {
        return res.status(400).json({
          message: "Office name is required when QR context type is OFFICE",
        });
      }
      if (
        normalizedContext.qrContextType === "OFFICE" &&
        !normalizedContext.officeAddress
      ) {
        return res.status(400).json({
          message: "Office address is required when QR context type is OFFICE",
        });
      }

      updates.qrContextType = normalizedContext.qrContextType;
      updates.officeName = normalizedContext.officeName;
      updates.officeAddress = normalizedContext.officeAddress;
      updates.officePhone = normalizedContext.officePhone;
      updates.officeDeliveryCharge = normalizedContext.officeDeliveryCharge;
      updates.officePaymentMode = normalizedContext.officePaymentMode;
    }

    const isOfficeContextAfterUpdate = isOfficeQrContext({
      ...(table.toObject ? table.toObject() : table),
      ...updates,
    });
    if (isOfficeContextAfterUpdate && updates.status && updates.status !== "AVAILABLE") {
      updates.status = "AVAILABLE";
    }

    Object.assign(table, updates);

    const isOfficeTable = isOfficeQrContext(table);
    if (isOfficeTable) {
      table.status = "AVAILABLE";
      table.currentOrder = null;
      table.set("sessionToken", undefined);
      table.lastAssignedAt = null;
    }

    if (!table.tableNumber && table.number) {
      table.tableNumber = String(table.number);
    }

    if (!table.qrSlug) {
      table.qrSlug = generateSlug();
    }
    if (!table.qrToken) {
      table.qrToken = table.qrSlug || generateToken();
    }

    // When table is being set to AVAILABLE, close previous session and clean up
    if (!isOfficeTable && updates.status === "AVAILABLE") {
      // Save the old sessionToken before clearing it
      const oldSessionToken = table.sessionToken;

      // Clean up all old orders from previous session using the helper function
      // This ensures all non-paid orders are deleted before new session starts
      await cleanupOldSessionOrders(table._id, oldSessionToken);

      // Clear table's currentOrder and sessionToken - close previous session completely
      table.currentOrder = null;
      table.set("sessionToken", undefined);

      // Additional cleanup: Delete any remaining non-paid orders (double check)
      // This handles edge cases where orders might exist without sessionToken
      if (oldSessionToken) {
        console.log(
          `[TABLE] Closing session for table ${table.number} - old sessionToken: ${oldSessionToken}`
        );
      }

      // If table was OCCUPIED/RESERVED, ensure all related data is cleared
      if (table.status === "OCCUPIED" || table.status === "RESERVED") {
        console.log(
          `[TABLE] Table ${table.number} being set to AVAILABLE - previous session closed`
        );
      }
    } else if (!isOfficeTable && updates.status === "AVAILABLE" && table.currentOrder) {
      // If table already has a currentOrder, check if it's paid/cancelled
      const order = await Order.findById(table.currentOrder);
      if (order && shouldDisplayInActiveQueues(order)) {
        return res.status(400).json({
          message:
            "Cannot mark table available while active order exists. Please cancel or pay the order first.",
        });
      }
      table.currentOrder = null;
    }

    await table.save();

    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");

    // Emit socket event for table status update
    const tableStatusPayload = {
      id: table._id,
      number: table.number,
      status: table.status,
      currentOrder: table.currentOrder || null,
      sessionToken: table.sessionToken || null, // Include sessionToken for customer frontend
    };

    // Emit to cafe room (for admin panel)
    // CRITICAL: Use table.cartId to ensure admin receives updates for their tables
    if (io && emitToCafe && table.cartId) {
      const tableCartId = table.cartId.toString();
      console.log(`[TABLE] Emitting table:status:updated to cartId: ${tableCartId} for table ${table.number}`);
      emitToCafe(
        io,
        tableCartId,
        "table:status:updated",
        tableStatusPayload
      );
    } else if (io && emitToCafe) {
      console.warn(`[TABLE] Table ${table.number} has no cartId - cannot emit to admin room`);
    }

    // Also emit globally so customers can receive real-time updates
    if (io) {
      console.log(`[TABLE] Emitting table:status:updated globally for table ${table.number}`);
      io.emit("table:status:updated", tableStatusPayload);
    }

    // When table becomes AVAILABLE, notify next waitlist person
    // CRITICAL: Only notify if table status actually changed FROM non-AVAILABLE TO AVAILABLE
    // This prevents loops when updateTable is called multiple times or when table is already AVAILABLE
    const statusChangedToAvailable =
      updates.status === "AVAILABLE" &&
      table.status === "AVAILABLE" &&
      originalStatus !== "AVAILABLE";

    if (!isOfficeTable && statusChangedToAvailable) {
      // Check if there's already a NOTIFIED entry before calling notifyNextWaitlist
      // This prevents loops and duplicate notifications
      const existingNotified = await Waitlist.findOne({
        table: table._id,
        status: "NOTIFIED",
      });

      // Only notify if there's no existing NOTIFIED entry
      // notifyNextWaitlist already has this check, but adding it here prevents unnecessary calls
      if (!existingNotified) {
        await notifyNextWaitlist(table._id, io);
      } else {
        console.log(
          `[TABLE] Table ${table.number} became AVAILABLE but already has NOTIFIED waitlist entry - skipping notification`
        );
      }
    }

    const waitlistLength = await countActiveWaitlist(table._id);

    return res.json({
      ...table.toObject(),
      waitlistLength,
    });
  } catch (err) {
    console.error("Error in updateTable:", err);
    // CRITICAL: Check if error is related to table variable initialization
    if (err.message && err.message.includes("Cannot access 'table' before initialization")) {
      console.error("[Table] CRITICAL: Table variable initialization error detected in updateTable");
      console.error("[Table] Error details:", {
        message: err.message,
        stack: err.stack,
        tableId: req.params?.id,
        userId: req.user?._id,
        userRole: req.user?.role,
      });
      // Return a more helpful error message
      return res.status(500).json({
        message: "Internal server error: Table initialization issue. Please try again.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
    return res.status(500).json({ 
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// Get single table by ID
exports.getTable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    // Build query based on user role
    const query = await buildHierarchyQuery(req.user);
    query._id = id;

    const table = await Table.findOne(query)
      .populate("mergedWith", "number")
      .populate("mergedTables", "number capacity originalCapacity")
      .lean();

    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    const waitlistLength = await countActiveWaitlist(table._id);

    return res.json({
      success: true,
      table: buildPublicTableResponse(table, waitlistLength, {
        includeSessionToken: false,
      }),
    });
  } catch (err) {
    console.error("Error in getTable:", err);
    // CRITICAL: Check if error is related to table variable initialization
    if (err.message && err.message.includes("Cannot access 'table' before initialization")) {
      console.error("[Table] CRITICAL: Table variable initialization error detected in getTable");
      console.error("[Table] Error details:", {
        message: err.message,
        stack: err.stack,
        tableId: req.params?.id,
        userId: req.user?._id,
        userRole: req.user?.role,
      });
      // Return a more helpful error message
      return res.status(500).json({
        message: "Internal server error: Table initialization issue. Please try again.",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
    return res.status(500).json({ 
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

exports.deleteTable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    // Cancel all active waitlist entries for this table
    await Waitlist.updateMany(
      { table: table._id, status: { $in: activeWaitlistStatuses } },
      { status: "CANCELLED" }
    );

    // Delete the table directly
    await table.deleteOne();

    return res.json({ message: "Table deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.regenerateQrSlug = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    const newSlug = generateSlug();
    table.qrSlug = newSlug;
    table.qrToken = newSlug;
    await table.save();

    return res.json(table);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Merge tables
exports.mergeTables = async (req, res) => {
  try {
    const { primaryTableId, secondaryTableIds } = req.body;

    if (
      !primaryTableId ||
      !Array.isArray(secondaryTableIds) ||
      secondaryTableIds.length === 0
    ) {
      return res.status(400).json({
        message:
          "Primary table ID and at least one secondary table ID are required",
      });
    }

    // Validate all table IDs
    const allTableIds = [primaryTableId, ...secondaryTableIds];
    for (const tableId of allTableIds) {
      if (!mongoose.Types.ObjectId.isValid(tableId)) {
        return res
          .status(400)
          .json({ message: `Invalid table ID: ${tableId}` });
      }
    }

    // Get all tables
    const primaryTable = await Table.findById(primaryTableId);
    if (!primaryTable) {
      return res.status(404).json({ message: "Primary table not found" });
    }

    // Check hierarchy access
    const query = await buildHierarchyQuery(req.user);
    if (
      query.cartId &&
      primaryTable.cartId?.toString() !== query.cartId.toString()
    ) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (
      query.franchiseId &&
      primaryTable.franchiseId?.toString() !== query.franchiseId.toString()
    ) {
      return res.status(403).json({ message: "Access denied" });
    }

    const secondaryTables = await Table.find({
      _id: { $in: secondaryTableIds },
    });
    if (secondaryTables.length !== secondaryTableIds.length) {
      return res
        .status(404)
        .json({ message: "One or more secondary tables not found" });
    }

    // Check if any table is already merged or has active orders
    for (const table of [primaryTable, ...secondaryTables]) {
      if (table.mergedWith || table.mergedTables?.length > 0) {
        return res
          .status(400)
          .json({ message: `Table ${table.number} is already merged` });
      }
      if (table.currentOrder) {
        const order = await Order.findById(table.currentOrder);
        if (order && shouldDisplayInActiveQueues(order)) {
          return res
            .status(400)
            .json({ message: `Table ${table.number} has an active order` });
        }
      }
    }

    // Merge tables: mark secondary tables as merged with primary
    for (const secondaryTable of secondaryTables) {
      // Store original capacity before merging (if not already stored)
      if (!secondaryTable.originalCapacity) {
        secondaryTable.originalCapacity = secondaryTable.capacity || 2;
      }
      secondaryTable.status = "MERGED";
      secondaryTable.mergedWith = primaryTable._id;
      await secondaryTable.save();
    }

    // Update primary table to include merged tables
    if (
      !primaryTable.mergedTables ||
      !Array.isArray(primaryTable.mergedTables)
    ) {
      primaryTable.mergedTables = [];
    }
    // Convert secondary table IDs to ObjectIds and add to mergedTables
    const secondaryObjectIds = secondaryTableIds.map((id) => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        return new mongoose.Types.ObjectId(id);
      }
      return id;
    });
    primaryTable.mergedTables.push(...secondaryObjectIds);
    // Store original capacity if not already stored (for unmerge)
    if (!primaryTable.originalCapacity) {
      primaryTable.originalCapacity = primaryTable.capacity || 2;
    }
    // Update capacity to reflect merged tables (add secondary tables' capacities)
    const secondaryCapacity = secondaryTables.reduce(
      (sum, t) => sum + (t.capacity || 0),
      0
    );
    primaryTable.capacity =
      (primaryTable.originalCapacity || primaryTable.capacity || 0) +
      secondaryCapacity;
    await primaryTable.save();

    // Emit socket events for table merge
    const io = req.app.get("io");
    const emitToCafe = req.app.get("emitToCafe");

    // Get updated primary table with populated mergedTables
    const updatedPrimaryTable = await Table.findById(primaryTableId).populate(
      "mergedTables",
      "number capacity"
    );

    // Emit table:merged event to cafe room (for admin panel)
    if (io && emitToCafe && primaryTable.cartId) {
      const mergePayload = {
        primaryTable: {
          id: updatedPrimaryTable._id,
          number: updatedPrimaryTable.number,
          status: updatedPrimaryTable.status,
          capacity: updatedPrimaryTable.capacity,
          mergedTables: updatedPrimaryTable.mergedTables || [],
        },
        secondaryTables: secondaryTables.map((t) => ({
          id: t._id,
          number: t.number,
          status: t.status,
        })),
      };

      emitToCafe(
        io,
        primaryTable.cartId.toString(),
        "table:merged",
        mergePayload
      );
    }

    // Also emit globally for real-time updates
    if (io) {
      const mergePayload = {
        primaryTable: {
          id: updatedPrimaryTable._id,
          number: updatedPrimaryTable.number,
          status: updatedPrimaryTable.status,
          capacity: updatedPrimaryTable.capacity,
          mergedTables: updatedPrimaryTable.mergedTables || [],
        },
        secondaryTables: secondaryTables.map((t) => ({
          id: t._id,
          number: t.number,
          status: t.status,
        })),
      };
      io.emit("table:merged", mergePayload);
    }

    return res.json({
      message: "Tables merged successfully",
      primaryTable: updatedPrimaryTable,
      mergedTables: secondaryTables,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Unmerge tables
exports.unmergeTables = async (req, res) => {
  try {
    // Route parameter is 'id', not 'tableId'
    const { id } = req.params;

    console.log("[UNMERGE] Received id from params:", id, "Type:", typeof id);
    console.log("[UNMERGE] All params:", req.params);

    // Validate table ID
    if (!id) {
      return res.status(400).json({ message: "Table ID is required" });
    }

    // Convert to string and validate ObjectId format
    const tableIdStr = String(id).trim();
    if (!mongoose.Types.ObjectId.isValid(tableIdStr)) {
      console.log("[UNMERGE] Invalid ObjectId format:", tableIdStr);
      return res.status(400).json({
        message: "Invalid table ID format",
        receivedId: tableIdStr,
        idType: typeof id,
      });
    }

    const table = await Table.findById(tableIdStr);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    // Check hierarchy access
    const query = await buildHierarchyQuery(req.user);
    if (query.cartId && table.cartId?.toString() !== query.cartId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (
      query.franchiseId &&
      table.franchiseId?.toString() !== query.franchiseId.toString()
    ) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Check if table is merged (either as secondary or primary)
    // Secondary table: has mergedWith field pointing to primary table OR status is MERGED
    // Primary table: has mergedTables array with entries

    // Check mergedWith - handle both ObjectId and null cases
    let hasMergedWith = false;
    if (table.mergedWith) {
      try {
        const mergedWithStr = table.mergedWith.toString();
        hasMergedWith =
          mergedWithStr && mergedWithStr !== "null" && mergedWithStr !== "";
      } catch (e) {
        hasMergedWith = false;
      }
    }

    // Also check status - if status is MERGED, it's definitely a merged table
    const isMergedStatus = table.status === "MERGED";

    // Primary table: has mergedTables array with entries
    const hasMergedTables =
      table.mergedTables &&
      Array.isArray(table.mergedTables) &&
      table.mergedTables.length > 0;

    console.log("[UNMERGE] Table check:", {
      tableId: table._id.toString(),
      tableNumber: table.number,
      mergedWith: table.mergedWith ? table.mergedWith.toString() : "null",
      mergedWithType: typeof table.mergedWith,
      mergedTables: table.mergedTables ? table.mergedTables.length : 0,
      hasMergedWith,
      isMergedStatus,
      hasMergedTables,
      status: table.status,
    });

    // Table is merged if it has mergedWith, status is MERGED, or has mergedTables
    const isMerged = hasMergedWith || isMergedStatus || hasMergedTables;

    if (!isMerged) {
      return res.status(400).json({
        message: "Table is not merged",
        debug: {
          mergedWith: table.mergedWith ? table.mergedWith.toString() : null,
          mergedWithType: typeof table.mergedWith,
          mergedTablesCount: table.mergedTables ? table.mergedTables.length : 0,
          status: table.status,
          hasMergedWith,
          isMergedStatus,
          hasMergedTables,
        },
      });
    }

    // If this is a merged table (mergedWith exists or status is MERGED), unmerge it
    if (hasMergedWith || isMergedStatus) {
      // Only try to find primary table if mergedWith exists
      let primaryTable = null;
      if (hasMergedWith && table.mergedWith) {
        primaryTable = await Table.findById(table.mergedWith);
      }

      if (primaryTable) {
        // Remove from primary table's mergedTables array
        if (
          primaryTable.mergedTables &&
          Array.isArray(primaryTable.mergedTables)
        ) {
          primaryTable.mergedTables = primaryTable.mergedTables.filter((id) => {
            const idStr = id.toString ? id.toString() : String(id);
            return idStr !== table._id.toString();
          });
          // Restore capacity by subtracting this table's original capacity
          const currentCapacity = primaryTable.capacity || 0;
          const tableOriginalCapacity =
            table.originalCapacity || table.capacity || 0;
          primaryTable.capacity = Math.max(
            primaryTable.originalCapacity || 2,
            currentCapacity - tableOriginalCapacity
          );
          await primaryTable.save();
        }
      }
      table.status = "AVAILABLE";
      table.mergedWith = null;
      // Restore original capacity if it was stored
      if (table.originalCapacity) {
        table.capacity = table.originalCapacity;
        table.originalCapacity = undefined; // Clear after restore
      }
      await table.save();

      // Emit socket events for table unmerge
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");

      const unmergePayload = {
        unmergedTable: {
          id: table._id,
          number: table.number,
          status: table.status,
          capacity: table.capacity,
        },
        primaryTable: primaryTable
          ? {
              id: primaryTable._id,
              number: primaryTable.number,
              capacity: primaryTable.capacity,
              mergedTables: primaryTable.mergedTables || [],
            }
          : null,
      };

      // Emit to cafe room (for admin panel)
      if (io && emitToCafe && table.cartId) {
        emitToCafe(
          io,
          table.cartId.toString(),
          "table:unmerged",
          unmergePayload
        );
      }

      // Also emit globally for real-time updates
      if (io) {
        io.emit("table:unmerged", unmergePayload);
      }

      return res.json({ message: "Table unmerged successfully", table });
    }

    // If this is a primary table with merged tables, unmerge all
    if (hasMergedTables) {
      const mergedTableIds = table.mergedTables.map((id) =>
        id.toString ? id.toString() : String(id)
      );

      // Get merged tables to calculate capacity to subtract
      const mergedTables = await Table.find({
        _id: { $in: table.mergedTables },
      });

      // Get original capacity of merged tables (before they were merged)
      // We need to get their original capacities, not current capacities
      const mergedCapacity = mergedTables.reduce((sum, t) => {
        // Use originalCapacity if available, otherwise use current capacity
        return sum + (t.originalCapacity || t.capacity || 0);
      }, 0);

      // Unmerge all secondary tables and restore their original capacities
      const secondaryTablesToUnmerge = await Table.find({
        _id: { $in: table.mergedTables },
      });
      for (const secondaryTable of secondaryTablesToUnmerge) {
        secondaryTable.status = "AVAILABLE";
        secondaryTable.mergedWith = null;
        // Restore original capacity if it was stored
        if (secondaryTable.originalCapacity) {
          secondaryTable.capacity = secondaryTable.originalCapacity;
          secondaryTable.originalCapacity = undefined; // Clear after restore
        }
        await secondaryTable.save();
      }

      // Restore original capacity of primary table
      const originalCapacity = table.originalCapacity || 2;
      table.capacity = originalCapacity;
      table.originalCapacity = undefined; // Clear originalCapacity after restore
      table.mergedTables = [];
      await table.save();

      // Emit socket events for table unmerge (all tables)
      const io = req.app.get("io");
      const emitToCafe = req.app.get("emitToCafe");

      const unmergePayload = {
        primaryTable: {
          id: table._id,
          number: table.number,
          status: table.status,
          capacity: table.capacity,
          mergedTables: [],
        },
        unmergedTables: secondaryTablesToUnmerge.map((t) => ({
          id: t._id,
          number: t.number,
          status: t.status,
          capacity: t.capacity,
        })),
      };

      // Emit to cafe room (for admin panel)
      if (io && emitToCafe && table.cartId) {
        emitToCafe(
          io,
          table.cartId.toString(),
          "table:unmerged",
          unmergePayload
        );
      }

      // Also emit globally for real-time updates
      if (io) {
        io.emit("table:unmerged", unmergePayload);
      }

      return res.json({
        message: "All merged tables unmerged successfully",
        table,
      });
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get table occupancy dashboard
exports.getTableOccupancyDashboard = async (req, res) => {
  try {
    await syncTableFields();

    // Keep dashboard scoping consistent with listTables (admin/franchise/mobile roles).
    const query = await buildHierarchyQuery(req.user);
    if (Object.keys(query).length === 0 && req.user?.role !== "super_admin") {
      return res.json([]);
    }

    if (query.cartId && mongoose.Types.ObjectId.isValid(query.cartId)) {
      query.cartId = new mongoose.Types.ObjectId(query.cartId);
    }

    const tables = await Table.find(query)
      .populate("currentOrder")
      .populate("mergedTables", "number capacity status")
      .sort({ number: 1, updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    // Extra safety: enforce exact cart match and keep only modern table QR records.
    const scopedTables = tables.filter((table) => {
      if (query.cartId) {
        const tableCartId = table.cartId?.toString();
        const queryCartId = query.cartId.toString();
        if (!tableCartId || tableCartId !== queryCartId) {
          return false;
        }
      }
      return true;
    });

    const hasValidQrSlug = (table = {}) =>
      String(table?.qrSlug || "").trim().length > 0;
    const tableFreshnessScore = (table = {}) => {
      const ts = new Date(table?.updatedAt || table?.createdAt || 0).getTime();
      return Number.isFinite(ts) ? ts : 0;
    };
    const tableQualityScore = (table = {}) => {
      let score = 0;
      if (hasValidQrSlug(table)) score += 3;
      if (table?.cartId || table?.cafeId) score += 1;
      score += tableFreshnessScore(table) / 1e15;
      return score;
    };

    // Deduplicate by cart + table number and prefer latest QR-system records.
    const tableByLogicalKey = new Map();
    for (const table of scopedTables) {
      if (!hasValidQrSlug(table)) continue;
      if (String(table?.qrContextType || "").trim().toUpperCase() !== "TABLE") {
        continue;
      }

      const key = `${table.cartId || table.cafeId || table.franchiseId || "unknown"}-${table.number}`;
      if (!tableByLogicalKey.has(key)) {
        tableByLogicalKey.set(key, table);
        continue;
      }

      const existing = tableByLogicalKey.get(key);
      if (tableQualityScore(table) > tableQualityScore(existing)) {
        tableByLogicalKey.set(key, table);
      }
    }

    const uniqueTables = Array.from(tableByLogicalKey.values());

    const dashboard = uniqueTables.map((table) => {
      const isOccupied = ["OCCUPIED", "RESERVED"].includes(table.status);
      const isMerged = table.status === "MERGED" || table.mergedWith;

      // Calculate capacity display:
      // - For primary tables with merged tables: capacity field already includes merged tables
      //   So originalCapacity = originalCapacity (if stored), totalCapacity = capacity (current)
      // - For secondary tables (merged into another): use originalCapacity if stored
      // - For regular tables: use capacity
      let originalCapacity = table.capacity || 0;
      let totalCapacity = table.capacity || 0;

      if (table.mergedTables && table.mergedTables.length > 0) {
        // Primary table with merged tables
        // table.capacity already includes merged tables' capacities
        originalCapacity = table.originalCapacity || table.capacity || 0; // Original before merge
        totalCapacity = table.capacity || 0; // Current capacity (includes merged)
      } else if (table.mergedWith) {
        // Secondary table merged into another
        originalCapacity = table.originalCapacity || table.capacity || 0; // Original before merge
        totalCapacity = originalCapacity; // Secondary tables don't have merged capacity themselves
      } else {
        // Regular table (not merged)
        originalCapacity = table.capacity || 0;
        totalCapacity = table.capacity || 0;
      }

      return {
        id: table._id.toString(), // Ensure ID is a string
        _id: table._id.toString(), // Also include _id for compatibility
        number: table.number,
        name: table.name,
        capacity: originalCapacity, // Original/base capacity for display
        totalCapacity, // Total capacity including merged tables (for primary tables)
        status: table.status,
        isOccupied,
        isMerged,
        mergedWith: table.mergedWith ? table.mergedWith.toString() : null,
        mergedTables: table.mergedTables,
        currentOrder: table.currentOrder,
        waitlistLength: 0, // Will be populated below
      };
    });

    // Add waitlist length for each table
    const enriched = await Promise.all(dashboard.map(async (item) => ({
      ...item,
      waitlistLength: await countActiveWaitlist(item.id),
    })));

    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
