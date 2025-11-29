const crypto = require("crypto");
const mongoose = require("mongoose");
const Waitlist = require("../models/waitlistModel");
const { Table } = require("../models/tableModel");

function buildWaitlistResponse(entry, position, table) {
  return {
    token: entry.token,
    status: entry.status,
    position,
    name: entry.name || null,
    partySize: entry.partySize || 1,
    table: {
      id: table._id,
      number: table.number,
      status: table.status,
      capacity: table.capacity,
    },
    notifiedAt: entry.notifiedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

async function computePosition(entry) {
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
}

/**
 * Join waitlist for a table
 */
exports.joinWaitlist = async (req, res) => {
  try {
    let { tableId, name, partySize, slug, token: providedToken } = req.body || {};
    
    // Sanitize waitToken - remove any trailing :number pattern (e.g., "token:1" -> "token")
    // This can happen if the token gets corrupted in localStorage or URL
    if (providedToken) {
      providedToken = providedToken.replace(/:\d+$/, '');
    }
    
    let table;

    if (tableId) {
      table = await Table.findById(tableId);
    } else if (slug) {
      table = await Table.findOne({ qrSlug: slug });
    }

    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    // Check if table is available - if so, user shouldn't join waitlist
    if (table.status === "AVAILABLE" && !table.sessionToken) {
      return res.status(400).json({ 
        message: "Table is available. No need to join waitlist." 
      });
    }

    // If a token is provided, check if it exists and is still active
    if (providedToken) {
      const existingByToken = await Waitlist.findOne({
        token: providedToken,
        table: table._id,
        status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
      });

      if (existingByToken) {
        // User already has an active entry - return it instead of creating duplicate
        const position = await computePosition(existingByToken);
        return res.status(200).json({
          token: existingByToken.token,
          position: position,
          name: existingByToken.name || null,
          partySize: existingByToken.partySize || 1,
          message: "Already in waitlist",
          table: {
            id: table._id,
            number: table.number,
            status: table.status,
          },
        });
      }
    }

    // CRITICAL: Check if user already has an active waitlist entry for this table
    // Check by sessionToken if available (from table lookup)
    // This prevents duplicate entries when user clicks "Join Waitlist" multiple times
    const { sessionToken } = req.body;
    if (sessionToken) {
      const existingBySession = await Waitlist.findOne({
        table: table._id,
        sessionToken: sessionToken,
        status: { $in: ["WAITING", "NOTIFIED", "SEATED"] },
      });
      
      if (existingBySession) {
        // User already has an active entry - return it instead of creating duplicate
        const position = await computePosition(existingBySession);
        return res.status(200).json({
          token: existingBySession.token,
          position: position,
          name: existingBySession.name || null,
          partySize: existingBySession.partySize || 1,
          message: "Already in waitlist",
          table: {
            id: table._id,
            number: table.number,
            status: table.status,
          },
        });
      }
    }

    const token = providedToken || crypto.randomBytes(6).toString("hex");
    const entry = await Waitlist.create({
      table: table._id,
      tableNumber: table.number ? String(table.number) : "",
      token,
      name,
      partySize,
      sessionToken: sessionToken || undefined, // Link to session if available
    });

    // Calculate position after entry is created - this ensures accurate ordering
    const position = await computePosition(entry);
    
    // Fallback: if computePosition returns 0 (shouldn't happen for WAITING), calculate manually
    // Count all active entries created before or at the same time as this entry
    // For same timestamp, use _id comparison for deterministic ordering
    const finalPosition = position > 0 ? position : (await Waitlist.countDocuments({
      table: table._id,
      status: { $in: ["WAITING", "NOTIFIED"] },
      $or: [
        { createdAt: { $lt: entry.createdAt } },
        { 
          createdAt: entry.createdAt, 
          _id: { $lte: entry._id } 
        }
      ],
    }));

    const io = req.app?.get("io");
    if (io) {
      io.emit("waitlistUpdated", {
        tableId: table._id.toString(),
        token: entry.token,
        status: entry.status,
      });
    }

    return res.status(201).json({
      token,
      position: finalPosition,
      name: entry.name || null,
      partySize: entry.partySize || 1,
      message: "Added to waitlist",
      table: {
        id: table._id,
        number: table.number,
        status: table.status,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Get waitlist status by token
 */
exports.getWaitlistStatus = async (req, res) => {
  try {
    let { token } = req.query;
    if (!token) {
      return res.status(400).json({ message: "token is required" });
    }

    // Sanitize waitToken - remove any trailing :number pattern (e.g., "token:1" -> "token")
    token = token.replace(/:\d+$/, '');

    const entry = await Waitlist.findOne({ token });
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    const table = await Table.findById(entry.table);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    const position = await computePosition(entry);
    return res.json(buildWaitlistResponse(entry, position, table));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Cancel a waitlist entry
 */
exports.cancelWaitlistEntry = async (req, res) => {
  try {
    let { token } = req.params;
    // Sanitize waitToken - remove any trailing :number pattern
    token = token.replace(/:\d+$/, '');
    const entry = await Waitlist.findOne({ token });
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    if (entry.status === "SEATED") {
      return res.status(400).json({ message: "Cannot cancel seated entry" });
    }

    const wasNotified = entry.status === "NOTIFIED";
    entry.status = "CANCELLED";
    await entry.save();

    const io = req.app?.get("io");
    if (io) {
      io.emit("waitlistUpdated", {
        tableId: entry.table.toString(),
        token: entry.token,
        status: entry.status,
      });
      
      // If cancelled entry was NOTIFIED, notify next person
      if (wasNotified) {
        await exports.notifyNextWaitlist(entry.table, io);
      }
    }

    return res.json({ message: "Waitlist entry cancelled" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Seat a waitlist entry - assign table to the person
 * This is called when a NOTIFIED person confirms they're ready
 */
exports.seatWaitlistEntry = async (req, res) => {
  try {
    let { token } = req.params;
    // Sanitize waitToken - remove any trailing :number pattern
    token = token.replace(/:\d+$/, '');
    const entry = await Waitlist.findOne({ token });
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    // Only allow seating if entry is WAITING or NOTIFIED
    if (!["WAITING", "NOTIFIED"].includes(entry.status)) {
      return res.status(400).json({ 
        message: `Cannot seat waitlist entry with status: ${entry.status}. Only WAITING or NOTIFIED entries can be seated.` 
      });
    }

    const table = await Table.findById(entry.table);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    // Check if table is available or reserved
    // If OCCUPIED, we can still seat if it's the same person (session owner)
    if (!["AVAILABLE", "RESERVED", "OCCUPIED"].includes(table.status)) {
      return res.status(400).json({ 
        message: `Cannot seat at table with status: ${table.status}` 
      });
    }

    // Generate session token
    let sessionToken = null;
    let saved = false;
    let attempts = 0;
    while (!saved && attempts < 5) {
      attempts += 1;
      try {
        sessionToken = crypto.randomBytes(10).toString("hex");
        table.sessionToken = sessionToken;
        
        // Update table status
        if (table.status === "AVAILABLE") {
          table.status = "RESERVED";
        }
        // If RESERVED or OCCUPIED, keep status but assign session token
        
        table.lastAssignedAt = new Date();
        await table.save();
        saved = true;
      } catch (err) {
        if (err?.code === 11000 && attempts < 5) {
          continue; // Retry if duplicate session token
        }
        throw err;
      }
    }

    // Mark entry as SEATED
    entry.status = "SEATED";
    entry.seatedAt = new Date();
    entry.sessionToken = sessionToken;
    await entry.save();

    const io = req.app?.get("io");
    if (io) {
      io.emit("waitlistUpdated", {
        tableId: entry.table.toString(),
        token: entry.token,
        status: entry.status,
      });
    }

    return res.json({
      success: true,
      message: "Waitlist entry marked as seated",
      sessionToken,
      table: {
        id: table._id,
        number: table.number,
        status: table.status,
      },
    });
  } catch (err) {
    console.error("Error seating waitlist entry:", err);
    return res.status(500).json({ message: err.message });
  }
};

/**
 * List all active waitlist entries for a table
 */
exports.listWaitlistForTable = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    const entries = await Waitlist.find({
      table: id,
      status: { $in: ["WAITING", "NOTIFIED"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.json(entries);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Notify the next person in waitlist when table becomes available
 * Returns the notified entry or null if no one is waiting
 * IMPORTANT: Only one person can be NOTIFIED at a time per table
 */
exports.notifyNextWaitlist = async (tableId, io) => {
  try {
    // First check if there's already a NOTIFIED entry (they have priority)
    const alreadyNotified = await Waitlist.findOne({
      table: tableId,
      status: "NOTIFIED",
    }).sort({ createdAt: 1 });

    if (alreadyNotified) {
      // Someone is already notified - don't notify another person
      // Return the existing notified entry
      return alreadyNotified;
    }

    // Find next WAITING entry (oldest first)
    const next = await Waitlist.findOne({
      table: tableId,
      status: "WAITING",
    }).sort({ createdAt: 1 });

    if (!next) {
      return null; // No one waiting
    }

    // Notify the next person
    next.status = "NOTIFIED";
    next.notifiedAt = new Date();
    await next.save();

    if (io) {
      io.emit("waitlistUpdated", {
        tableId: tableId.toString(),
        token: next.token,
        status: next.status,
      });
    }

    console.log(`[Waitlist] Notified next person for table ${tableId}: ${next.token}`);
    return next;
  } catch (err) {
    console.error("notifyNextWaitlist error:", err);
    return null;
  }
};

/**
 * Manual route to notify next waitlist entry (admin action)
 */
exports.notifyNextWaitlistRoute = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid table id" });
    }

    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }

    const io = req.app?.get("io");
    const entry = await exports.notifyNextWaitlist(id, io);
    if (!entry) {
      return res.status(404).json({ message: "No waiting guests for this table" });
    }

    return res.json(entry);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Manually notify a specific waitlist entry (admin action)
 */
exports.notifyWaitlistEntry = async (req, res) => {
  try {
    let { token } = req.params;
    // Sanitize waitToken - remove any trailing :number pattern
    token = token.replace(/:\d+$/, '');
    const entry = await Waitlist.findOne({ token });
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    if (entry.status === "NOTIFIED") {
      return res.json(entry);
    }

    if (entry.status !== "WAITING") {
      return res.status(400).json({ message: "Only waiting guests can be notified" });
    }

    // Cancel any other NOTIFIED entries for this table first
    await Waitlist.updateMany(
      {
        table: entry.table,
        status: "NOTIFIED",
        _id: { $ne: entry._id },
      },
      { status: "WAITING", notifiedAt: null }
    );

    entry.status = "NOTIFIED";
    entry.notifiedAt = new Date();
    await entry.save();

    const io = req.app?.get("io");
    if (io) {
      io.emit("waitlistUpdated", {
        tableId: entry.table.toString(),
        token: entry.token,
        status: entry.status,
      });
    }

    return res.json(entry);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
