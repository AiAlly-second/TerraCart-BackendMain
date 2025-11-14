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
  };

  if (options.includeSessionToken) {
    payload.sessionToken = table.sessionToken || null;
  }
  return payload;
};

const generateSlug = () => crypto.randomBytes(8).toString("hex");
const generateToken = () => crypto.randomBytes(10).toString("hex");

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
    // - Cafe admin: only see tables from their cafe (cafeId matches their _id)
    // - Franchise admin: only see tables from cafes under their franchise (franchiseId matches their _id)
    // - Super admin: see all tables (no filter)
    const query = {};
    if (req.user && req.user.role === "admin" && req.user._id) {
      // Cafe admin - only see tables from their cafe
      query.cafeId = req.user._id;
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
      if (!table.sessionToken || table.sessionToken !== waitlistEntry.sessionToken) {
        // Restore their session token
        table.sessionToken = waitlistEntry.sessionToken;
        if (table.status === "AVAILABLE") {
          table.status = "RESERVED";
        }
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
        if (!table.sessionToken) {
          table.sessionToken = generateToken();
          table.status = "RESERVED";
          mutated = true;
          sessionTokenJustIssued = true;
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
          // No waitToken - create new waitlist entry
          const token = crypto.randomBytes(6).toString("hex");
          waitlistEntry = await Waitlist.create({
            table: table._id,
            tableNumber: String(table.number),
            token,
          });
          console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
            if (!table.sessionToken) {
              table.sessionToken = generateToken();
              table.status = "RESERVED";
              mutated = true;
              sessionTokenJustIssued = true;
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
              // No waitToken - create new waitlist entry
              const token = crypto.randomBytes(6).toString("hex");
              waitlistEntry = await Waitlist.create({
                table: table._id,
                tableNumber: String(table.number),
                token,
              });
              console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
      if (!table.sessionToken) {
        table.sessionToken = generateToken();
        mutated = true;
        sessionTokenJustIssued = true;
      }
      
      table.lastAssignedAt = new Date();
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
          // No waitToken - create new waitlist entry
          const token = crypto.randomBytes(6).toString("hex");
          waitlistEntry = await Waitlist.create({
            table: table._id,
            tableNumber: String(table.number),
            token,
          });
          console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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
          // No waitToken - create new waitlist entry
          const token = crypto.randomBytes(6).toString("hex");
          waitlistEntry = await Waitlist.create({
            table: table._id,
            tableNumber: String(table.number),
            token,
          });
          console.log(`[Table ${table.number}] Created new waitlist entry: ${token}`);
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

    // Set cafeId and franchiseId if user is cafe admin
    let cafeId = null;
    let franchiseId = null;
    if (req.user && req.user.role === "admin" && req.user._id) {
      cafeId = req.user._id;
      // Get franchiseId from cafe admin user
      if (req.user.franchiseId) {
        franchiseId = req.user.franchiseId;
      }
    }
    
    // Check uniqueness per cafe (cafe admins can have same table numbers)
    // For cafe admins: check if this cafe already has this table number
    // For non-cafe admins: check if any table exists with this number where cafeId is null/undefined
    let existing = null;
    if (cafeId) {
      existing = await Table.findOne({ number: numericNumber, cafeId: cafeId });
      if (existing) {
        return res.status(409).json({ message: "Table number already exists for this cafe" });
      }
    } else {
      // For non-cafe admins (super_admin, franchise_admin), check if any table exists with this number
      // where cafeId is null or undefined (non-cafe admin tables)
      existing = await Table.findOne({
        number: numericNumber,
        $or: [
          { cafeId: null },
          { cafeId: { $exists: false } }
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
      cafeId: cafeId || undefined, // Use undefined instead of null to avoid issues
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
      if (field === 'number_1_cafeId_1' || (err.keyPattern && err.keyPattern.number && err.keyPattern.cafeId)) {
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

    // Only mark as OCCUPIED if currently AVAILABLE or RESERVED
    if (["AVAILABLE", "RESERVED"].includes(table.status)) {
      table.status = "OCCUPIED";
      if (sessionToken && !table.sessionToken) {
        table.sessionToken = sessionToken;
      }
      await table.save();
    }

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
      const existing = await Table.findOne({ number: updates.number });
      if (existing) {
        return res.status(409).json({ message: "Table number already exists" });
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

    if (updates.status === "AVAILABLE" && table.currentOrder) {
      const order = await Order.findById(table.currentOrder);
      if (order && !["Paid", "Cancelled"].includes(order.status)) {
        return res.status(400).json({
          message: "Cannot mark table available while active order exists",
        });
      }
      table.currentOrder = null;
    }
    if (updates.status === "AVAILABLE") {
      table.set("sessionToken", undefined);
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
