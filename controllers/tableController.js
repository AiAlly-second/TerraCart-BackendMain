const crypto = require("crypto");
const mongoose = require("mongoose");
const { Table, TABLE_STATUSES } = require("../models/tableModel");
const Order = require("../models/orderModel");
const Waitlist = require("../models/waitlistModel");
const { notifyNextWaitlist } = require("./waitlistController");

const activeWaitlistStatuses = ["WAITING", "NOTIFIED"];

const countActiveWaitlist = (tableId) =>
  Waitlist.countDocuments({
    table: tableId,
    status: { $in: activeWaitlistStatuses },
  });

// Helper function to build query based on user role
const buildHierarchyQuery = (user) => {
  const query = {};
  if (user && user.role === "admin" && user._id) {
    query.cartId = user._id;
  } else if (user && user.role === "franchise_admin" && user._id) {
    query.franchiseId = user._id;
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
          _id: { $lt: entry._id } 
        }
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
          _id: { $lt: entry._id } 
        }
      ],
    });
    return ahead + 1;
  }
  
  // For SEATED or CANCELLED, return 0
  return 0;
};

const buildPublicTableResponse = (table, waitlistLength = 0, options = {}) => {
  const payload = {
    id: table._id,
    number: table.number,
    name: table.name,
    capacity: table.capacity,
    status: table.status,
    qrSlug: table.qrSlug,
    currentOrder: table.currentOrder || null,
    waitlistLength,
    // CRITICAL: Include cartId so frontend can filter menu by cart
    cartId: table.cartId || null,
    cafeId: table.cartId || null, // Alias for compatibility
  };

  if (options.includeSessionToken) {
    payload.sessionToken = table.sessionToken || null;
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
    
    // Build query to find ALL non-paid orders for this table
    // When a new session starts, we want to clean up all previous orders (except paid ones)
    const orderQuery = {
      table: tableId,
      status: { $nin: ["Paid", "Cancelled"] }
    };
    
    // Find all non-paid orders for this table
    const oldOrders = await Order.find(orderQuery);
    
    if (oldOrders.length > 0) {
      console.log(`[TABLE] Cleaning up ${oldOrders.length} old orders for table ${tableId} (old sessionToken: ${oldSessionToken || 'none'})`);
      
      // Delete associated non-paid payments
      for (const order of oldOrders) {
        try {
          const payments = await Payment.find({ orderId: order._id });
          for (const payment of payments) {
            // Only delete non-paid payments
            if (payment.status !== "PAID") {
              await Payment.findByIdAndDelete(payment._id);
              console.log(`[TABLE] Deleted non-paid payment ${payment._id} for order ${order._id}`);
            }
          }
        } catch (err) {
          console.error(`[TABLE] Error deleting payments for order ${order._id}:`, err);
        }
      }
      
      // Delete all non-paid orders for this table
      const deleteResult = await Order.deleteMany(orderQuery);
      console.log(`[TABLE] Deleted ${deleteResult.deletedCount} old orders for table ${tableId}`);
    } else {
      console.log(`[TABLE] No old orders to clean up for table ${tableId}`);
    }
  } catch (err) {
    console.error(`[TABLE] Error cleaning up old session orders for table ${tableId}:`, err);
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

    await Table.updateMany({ sessionToken: null }, { $unset: { sessionToken: "" } });

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
      { qrToken: null }
    ]
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
    
    // Filter tables based on admin role:
    // - Cafe admin: only see tables from their cafe (cartId matches their _id)
    // - Franchise admin: only see tables from cafes under their franchise (franchiseId matches their _id)
    // - Super admin: see all tables (no filter)
    const query = {};
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only see tables from their cafe
      query.cartId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      // Franchise admin - only see tables from cafes under their franchise
      query.franchiseId = req.user._id;
    }
    // For super_admin, no filter (see all tables)
    
    const tables = await Table.find(query).sort({ number: 1 }).lean();
    const enriched = await Promise.all(
      tables.map(async (table) => ({
        ...table,
        waitlistLength: await countActiveWaitlist(table._id),
      }))
    );
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getAvailableTables = async (_req, res) => {
  try {
    await syncTableFields();
    const tables = await Table.find({ status: "AVAILABLE" })
      .sort({ number: 1 })
      .lean();
    const enriched = await Promise.all(
      tables.map(async (table) =>
        buildPublicTableResponse(
          table,
          await countActiveWaitlist(table._id)
        )
      )
    );
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.lookupTableBySlug = async (req, res) => {
  try {
    await syncTableFields();
    const { slug } = req.params;
    let { waitToken, sessionToken: clientSessionToken } = req.query;
    
    // Sanitize waitToken - remove any trailing :number pattern (e.g., "token:1" -> "token")
    // This can happen if the token gets corrupted in localStorage or URL
    if (waitToken) {
      waitToken = waitToken.replace(/:\d+$/, '');
    }
    
    const table = await Table.findOne({ qrSlug: slug });
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
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
        message: `This table (Table ${table.number}) has been merged with Table ${primaryTableNumber || 'another table'}. Please scan the primary table's QR code to place your order.`,
        isMerged: true,
        mergedTable: {
          number: table.number,
          mergedWith: primaryTableNumber,
        },
        primaryTable: primaryTable ? {
          number: primaryTable.number,
          qrSlug: primaryTable.qrSlug,
        } : null,
      });
    }

    const waitlistLength = await countActiveWaitlist(table._id);
    const { notifyNextWaitlist } = require("./waitlistController");
    
    // CRITICAL: Get user's waitlist entry if provided
    // This is the PRIMARY way to identify the same customer
    let waitlistEntry = null;
    if (waitToken) {
      waitlistEntry = await Waitlist.findOne({ token: waitToken });
      if (waitlistEntry && !["WAITING", "NOTIFIED", "SEATED"].includes(waitlistEntry.status)) {
        // Entry exists but is CANCELLED - don't use it
        waitlistEntry = null;
      }
      if (waitlistEntry) {
        console.log(`[Table ${table.number}] Found existing waitlist entry via waitToken: ${waitToken}, status: ${waitlistEntry.status}`);
      } else if (waitToken) {
        console.log(`[Table ${table.number}] WaitToken provided but entry not found or invalid: ${waitToken}`);
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
        console.log(`[Table ${table.number}] Found existing waitlist entry via sessionToken: ${clientSessionToken}, token: ${existingBySession.token}`);
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

    // Check if user is session owner
    const isSessionOwner = table.sessionToken && candidateSessionTokens.has(table.sessionToken);
    
    let mutated = false;
    let sessionTokenJustIssued = false;

    // REDESIGNED WAITLIST FLOW:
    // Priority order:
    // 1. Session owner always gets access (if they have valid session token)
    // 2. NOTIFIED waitlist entry gets priority when table is AVAILABLE
    // 3. SEATED waitlist entry gets access (they were already seated)
    // 4. Otherwise, follow normal flow

    // Check if user has a SEATED waitlist entry
    if (waitlistEntry?.status === "SEATED" && waitlistEntry.sessionToken) {
      // User was already seated - give them access
      // CRITICAL: Keep table as AVAILABLE during lookup - only mark as OCCUPIED when user enters menu
      if (!table.sessionToken || table.sessionToken !== waitlistEntry.sessionToken) {
        // Restore their session token
        table.sessionToken = waitlistEntry.sessionToken;
        // Keep status as AVAILABLE - don't change to RESERVED
        mutated = true;
      }
      
      table.lastAssignedAt = new Date();
      if (mutated) await table.save();
      
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
        // CRITICAL: Keep table as AVAILABLE during lookup - only mark as OCCUPIED when user enters menu
        if (!table.sessionToken) {
          // Clean up any old orders before starting new session
          const oldSessionToken = table.sessionToken; // Save old token if exists
          await cleanupOldSessionOrders(table._id, oldSessionToken);
          table.sessionToken = generateToken();
          // Keep status as AVAILABLE - don't change to RESERVED
          mutated = true;
          sessionTokenJustIssued = true;
        } else if (table.sessionToken !== waitlistEntry.sessionToken) {
          // Table has a different sessionToken - clean up old session orders
          await cleanupOldSessionOrders(table._id, table.sessionToken);
          table.sessionToken = waitlistEntry.sessionToken || generateToken();
          // Keep status as AVAILABLE - don't change to RESERVED
          mutated = true;
        }
        
        table.lastAssignedAt = new Date();
        if (mutated) await table.save();
        
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
              { token: waitToken }
            ].filter(Boolean), // Remove null/undefined conditions
          });
          
          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(`[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`);
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined, // Link to session if available
            });
            console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
            // CRITICAL: Keep table as AVAILABLE during lookup - only mark as OCCUPIED when user enters menu
            if (!table.sessionToken) {
              // Clean up any old orders before starting new session
              const oldSessionToken = table.sessionToken; // Save old token if exists
              await cleanupOldSessionOrders(table._id, oldSessionToken);
              table.sessionToken = generateToken();
              // Keep status as AVAILABLE - don't change to RESERVED
              mutated = true;
              sessionTokenJustIssued = true;
            } else if (table.sessionToken !== nextNotified.sessionToken) {
              // Table has a different sessionToken - clean up old session orders
              await cleanupOldSessionOrders(table._id, table.sessionToken);
              table.sessionToken = nextNotified.sessionToken || generateToken();
              // Keep status as AVAILABLE - don't change to RESERVED
              mutated = true;
            }
            
            table.lastAssignedAt = new Date();
            if (mutated) await table.save();
            
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
          } else {
            // Someone else was notified - this user must wait
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
              const existingEntry = await Waitlist.findOne({
                table: table._id,
                status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
                $or: [
                  { sessionToken: clientSessionToken },
                  { token: waitToken }
                ].filter(Boolean),
              });
              
              if (existingEntry) {
                waitlistEntry = existingEntry;
                console.log(`[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`);
              } else {
                // No existing entry - create new waitlist entry
                const token = crypto.randomBytes(6).toString("hex");
                waitlistEntry = await Waitlist.create({
                  table: table._id,
                  tableNumber: String(table.number),
                  token,
                  sessionToken: clientSessionToken || undefined,
                });
                console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
      
      console.log(`[TABLE] Table ${table.number} AVAILABLE - generated NEW sessionToken (old: ${oldSessionToken || 'none'})`);
      
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
      if (isSessionOwner) {
        // Session owner - allow access
        table.lastAssignedAt = new Date();
        await table.save();
        
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
            message: "Invalid waitlist token. Your previous waitlist entry may have expired. Please scan again to join waitlist.",
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
              { token: waitToken }
            ].filter(Boolean),
          });
          
          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(`[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`);
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined,
            });
            console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
      if (isSessionOwner) {
        // Session owner - allow access
        table.lastAssignedAt = new Date();
        await table.save();
        
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
            message: "Invalid waitlist token. Your previous waitlist entry may have expired. Please scan again to join waitlist.",
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
              { token: waitToken }
            ].filter(Boolean),
          });
          
          if (existingEntry) {
            waitlistEntry = existingEntry;
            console.log(`[Table ${table.number}] Reusing existing waitlist entry: ${existingEntry.token}`);
          } else {
            // No existing entry - create new waitlist entry
            const token = crypto.randomBytes(6).toString("hex");
            waitlistEntry = await Waitlist.create({
              table: table._id,
              tableNumber: String(table.number),
              token,
              sessionToken: clientSessionToken || undefined,
            });
            console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
    console.error('Error in lookupTableBySlug:', err);
    return res.status(500).json({ 
      message: err.message, 
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined 
    });
  }
};

exports.createTable = async (req, res) => {
  try {
    const { number, name, capacity, notes } = req.body;
    if (!number) {
      return res.status(400).json({ message: "Table number is required" });
    }

    const numericNumber = Number(number);
    if (!Number.isFinite(numericNumber) || numericNumber <= 0) {
      return res.status(400).json({ message: "Table number must be a positive number" });
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
    
    // Check uniqueness per cafe (cafe admins can have same table numbers)
    // For cafe admins: check if this cafe already has this table number
    // For non-cafe admins: check if any table exists with this number where cartId is null/undefined
    let existing = null;
    if (cartId) {
      existing = await Table.findOne({ number: numericNumber, cartId: cartId });
      if (existing) {
        return res.status(409).json({ message: "Table number already exists for this cafe" });
      }
    } else {
      // For non-cafe admins (super_admin, franchise_admin), check if any table exists with this number
      // where cartId is null or undefined (non-cafe admin tables)
      existing = await Table.findOne({
        number: numericNumber,
        $or: [
          { cartId: null },
          { cartId: { $exists: false } }
        ]
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
      return res.status(500).json({ message: "Failed to generate unique QR code. Please try again." });
    }

    const table = await Table.create({
      number: numericNumber,
      tableNumber: String(numericNumber),
      name,
      capacity,
      notes,
      qrSlug: slug,
      qrToken: slug,
      cartId: cartId || undefined, // Use undefined instead of null to avoid issues
      franchiseId: franchiseId || undefined, // Set franchiseId from cafe admin
    });

    return res.status(201).json(table);
  } catch (err) {
    console.error('Error creating table:', err);
    console.error('Error details:', {
      code: err.code,
      codeName: err.codeName,
      keyPattern: err.keyPattern,
      keyValue: err.keyValue,
      message: err.message
    });
    
    // Handle MongoDB duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      if (field === 'number_1_cartId_1' || (err.keyPattern && err.keyPattern.number && err.keyPattern.cartId)) {
        return res.status(409).json({ 
          message: 'Table number already exists for this cafe. If you see this error repeatedly, please run: node scripts/fix-table-indexes.js'
        });
      }
      return res.status(409).json({ 
        message: `Table ${field === 'number' ? 'number' : field} already exists. If this persists, run: node scripts/fix-table-indexes.js`
      });
    }
    return res.status(500).json({ 
      message: err.message || 'Failed to create table',
      error: process.env.NODE_ENV === 'development' ? err.stack : undefined
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
    if (sessionToken && table.sessionToken && table.sessionToken !== sessionToken) {
      return res.status(403).json({ message: "Invalid session token" });
    }

    // CRITICAL: Only mark as OCCUPIED if currently AVAILABLE
    // This ensures table stays AVAILABLE until user enters menu page
    if (table.status === "AVAILABLE") {
      table.status = "OCCUPIED";
      if (sessionToken && !table.sessionToken) {
        table.sessionToken = sessionToken;
      }
      await table.save();
    } else if (table.status === "RESERVED") {
      // If table is RESERVED, also mark as OCCUPIED (for backward compatibility)
      table.status = "OCCUPIED";
      if (sessionToken && !table.sessionToken) {
        table.sessionToken = sessionToken;
      }
      await table.save();
    }
    // If table is already OCCUPIED, do nothing

    return res.json({
      success: true,
      table: buildPublicTableResponse(table, await countActiveWaitlist(table._id)),
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

    const updates = {};
    const allowedFields = ["number", "name", "capacity", "status", "notes"];
    for (const field of allowedFields) {
      if (field in req.body) {
        updates[field] = req.body[field];
      }
    }

    if (updates.number !== undefined) {
      const numericNumber = Number(updates.number);
      if (!Number.isFinite(numericNumber) || numericNumber <= 0) {
        return res.status(400).json({ message: "Table number must be a positive number" });
      }
      updates.number = numericNumber;
      updates.tableNumber = String(numericNumber);
    }

    if (updates.status && !TABLE_STATUSES.includes(updates.status)) {
      return res.status(400).json({ message: "Invalid table status" });
    }

    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

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
        return res.status(409).json({ message: "Table number already exists for this cart" });
      }
    }

    Object.assign(table, updates);

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
    if (updates.status === "AVAILABLE") {
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
        console.log(`[TABLE] Closing session for table ${table.number} - old sessionToken: ${oldSessionToken}`);
      }
      
      // If table was OCCUPIED/RESERVED, ensure all related data is cleared
      if (table.status === "OCCUPIED" || table.status === "RESERVED") {
        console.log(`[TABLE] Table ${table.number} being set to AVAILABLE - previous session closed`);
      }
    } else if (updates.status === "AVAILABLE" && table.currentOrder) {
      // If table already has a currentOrder, check if it's paid/cancelled
      const order = await Order.findById(table.currentOrder);
      if (order && !["Paid", "Cancelled"].includes(order.status)) {
        return res.status(400).json({
          message: "Cannot mark table available while active order exists. Please cancel or pay the order first.",
        });
      }
      table.currentOrder = null;
    }

    await table.save();

    const io = req.app.get("io");
    
    // When table becomes AVAILABLE, notify next waitlist person
    // Don't cancel waitlist entries - let the flow handle it naturally
    if (updates.status === "AVAILABLE" && table.status === "AVAILABLE") {
      // Notify next person in waitlist (if any)
      await notifyNextWaitlist(table._id, io);
      // Note: We don't cancel waitlist entries here
      // They will be handled when:
      // 1. NOTIFIED person accesses table and gets seated
      // 2. Someone takes direct access (no waitlist entries)
      // 3. Waitlist entries expire or are cancelled
    }

    const waitlistLength = await countActiveWaitlist(table._id);

    return res.json({
      ...table.toObject(),
      waitlistLength,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
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

    if (table.currentOrder) {
      return res.status(400).json({ message: "Cannot delete table with active order" });
    }

    await Waitlist.updateMany(
      { table: table._id, status: { $in: activeWaitlistStatuses } },
      { status: "CANCELLED" }
    );

    await table.deleteOne();
    return res.json({ message: "Table deleted" });
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
    
    if (!primaryTableId || !Array.isArray(secondaryTableIds) || secondaryTableIds.length === 0) {
      return res.status(400).json({ message: "Primary table ID and at least one secondary table ID are required" });
    }
    
    // Validate all table IDs
    const allTableIds = [primaryTableId, ...secondaryTableIds];
    for (const tableId of allTableIds) {
      if (!mongoose.Types.ObjectId.isValid(tableId)) {
        return res.status(400).json({ message: `Invalid table ID: ${tableId}` });
      }
    }
    
    // Get all tables
    const primaryTable = await Table.findById(primaryTableId);
    if (!primaryTable) {
      return res.status(404).json({ message: "Primary table not found" });
    }
    
    // Check hierarchy access
    const query = buildHierarchyQuery(req.user);
    if (query.cartId && primaryTable.cartId?.toString() !== query.cartId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (query.franchiseId && primaryTable.franchiseId?.toString() !== query.franchiseId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    
    const secondaryTables = await Table.find({ _id: { $in: secondaryTableIds } });
    if (secondaryTables.length !== secondaryTableIds.length) {
      return res.status(404).json({ message: "One or more secondary tables not found" });
    }
    
    // Check if any table is already merged or has active orders
    for (const table of [primaryTable, ...secondaryTables]) {
      if (table.mergedWith || table.mergedTables?.length > 0) {
        return res.status(400).json({ message: `Table ${table.number} is already merged` });
      }
      if (table.currentOrder) {
        const order = await Order.findById(table.currentOrder);
        if (order && !["Paid", "Cancelled"].includes(order.status)) {
          return res.status(400).json({ message: `Table ${table.number} has an active order` });
        }
      }
    }
    
    // Merge tables: mark secondary tables as merged with primary
    for (const secondaryTable of secondaryTables) {
      secondaryTable.status = "MERGED";
      secondaryTable.mergedWith = primaryTable._id;
      await secondaryTable.save();
    }
    
    // Update primary table to include merged tables
    if (!primaryTable.mergedTables || !Array.isArray(primaryTable.mergedTables)) {
      primaryTable.mergedTables = [];
    }
    // Convert secondary table IDs to ObjectIds and add to mergedTables
    const secondaryObjectIds = secondaryTableIds.map(id => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        return new mongoose.Types.ObjectId(id);
      }
      return id;
    });
    primaryTable.mergedTables.push(...secondaryObjectIds);
    // Update capacity to reflect merged tables
    const totalCapacity = secondaryTables.reduce((sum, t) => sum + (t.capacity || 0), primaryTable.capacity || 0);
    primaryTable.capacity = totalCapacity;
    await primaryTable.save();
    
    return res.json({
      message: "Tables merged successfully",
      primaryTable: await Table.findById(primaryTableId).populate("mergedTables", "number capacity"),
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
    
    console.log('[UNMERGE] Received id from params:', id, 'Type:', typeof id);
    console.log('[UNMERGE] All params:', req.params);
    
    // Validate table ID
    if (!id) {
      return res.status(400).json({ message: "Table ID is required" });
    }
    
    // Convert to string and validate ObjectId format
    const tableIdStr = String(id).trim();
    if (!mongoose.Types.ObjectId.isValid(tableIdStr)) {
      console.log('[UNMERGE] Invalid ObjectId format:', tableIdStr);
      return res.status(400).json({ 
        message: "Invalid table ID format",
        receivedId: tableIdStr,
        idType: typeof id
      });
    }
    
    const table = await Table.findById(tableIdStr);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }
    
    // Check hierarchy access
    const query = buildHierarchyQuery(req.user);
    if (query.cartId && table.cartId?.toString() !== query.cartId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (query.franchiseId && table.franchiseId?.toString() !== query.franchiseId.toString()) {
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
        hasMergedWith = mergedWithStr && mergedWithStr !== 'null' && mergedWithStr !== '';
      } catch (e) {
        hasMergedWith = false;
      }
    }
    
    // Also check status - if status is MERGED, it's definitely a merged table
    const isMergedStatus = table.status === "MERGED";
    
    // Primary table: has mergedTables array with entries
    const hasMergedTables = table.mergedTables && 
                            Array.isArray(table.mergedTables) && 
                            table.mergedTables.length > 0;
    
    console.log('[UNMERGE] Table check:', {
      tableId: table._id.toString(),
      tableNumber: table.number,
      mergedWith: table.mergedWith ? table.mergedWith.toString() : 'null',
      mergedWithType: typeof table.mergedWith,
      mergedTables: table.mergedTables ? table.mergedTables.length : 0,
      hasMergedWith,
      isMergedStatus,
      hasMergedTables,
      status: table.status
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
          hasMergedTables
        }
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
        if (primaryTable.mergedTables && Array.isArray(primaryTable.mergedTables)) {
          primaryTable.mergedTables = primaryTable.mergedTables.filter(
            id => {
              const idStr = id.toString ? id.toString() : String(id);
              return idStr !== table._id.toString();
            }
          );
          // Restore capacity by subtracting this table's capacity
          const currentCapacity = primaryTable.capacity || 0;
          const tableCapacity = table.capacity || 0;
          primaryTable.capacity = Math.max(2, currentCapacity - tableCapacity);
          await primaryTable.save();
        }
      }
      table.status = "AVAILABLE";
      table.mergedWith = null;
      await table.save();
      return res.json({ message: "Table unmerged successfully", table });
    }
    
    // If this is a primary table with merged tables, unmerge all
    if (hasMergedTables) {
      const mergedTableIds = table.mergedTables.map(id => id.toString ? id.toString() : String(id));
      
      // Get merged tables to calculate capacity to subtract
      const mergedTables = await Table.find({ 
        _id: { $in: table.mergedTables } 
      });
      
      // Calculate total capacity of merged tables
      const mergedCapacity = mergedTables.reduce((sum, t) => sum + (t.capacity || 0), 0);
      
      // Unmerge all secondary tables
      await Table.updateMany(
        { _id: { $in: table.mergedTables } },
        { $set: { status: "AVAILABLE", mergedWith: null } }
      );
      
      // Restore original capacity by subtracting merged capacity
      const currentCapacity = table.capacity || 0;
      table.capacity = Math.max(2, currentCapacity - mergedCapacity);
      table.mergedTables = [];
      await table.save();
      
      return res.json({ message: "All merged tables unmerged successfully", table });
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Get table occupancy dashboard
exports.getTableOccupancyDashboard = async (req, res) => {
  try {
    // Filter tables based on admin role
    const query = {};
    if (req.user && req.user.role === "admin" && req.user._id) {
      query.cartId = req.user._id;
    } else if (req.user && req.user.role === "franchise_admin" && req.user._id) {
      query.franchiseId = req.user._id;
    }
    
    const tables = await Table.find(query)
      .populate("currentOrder")
      .populate("mergedTables", "number capacity status")
      .sort({ number: 1 })
      .lean();
    
    const dashboard = tables.map((table) => {
      const isOccupied = ["OCCUPIED", "RESERVED"].includes(table.status);
      const isMerged = table.status === "MERGED" || table.mergedWith;
      const mergedCapacity = table.mergedTables?.reduce((sum, t) => sum + (t.capacity || 0), 0) || 0;
      const totalCapacity = (table.capacity || 0) + mergedCapacity;
      
      return {
        id: table._id.toString(), // Ensure ID is a string
        _id: table._id.toString(), // Also include _id for compatibility
        number: table.number,
        name: table.name,
        capacity: table.capacity,
        totalCapacity,
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
    const enriched = await Promise.all(
      dashboard.map(async (item) => ({
        ...item,
        waitlistLength: await countActiveWaitlist(item.id),
      }))
    );
    
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
