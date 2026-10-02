const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const { requireInventoryEnabled } = require("../middleware/inventoryFeatureMiddleware");
const {
  parseVoiceInventory,
  createVoiceInventory,
} = require("../controllers/voiceInventoryController");

const router = express.Router();

router.use(protect);

// Parsing voice text does not write any stock and remains available even
// when Inventory is disabled (it is only ever a precursor to /create).
router.post(
  "/parse",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  parseVoiceInventory,
);
// Creating an ingredient/stock row from a voice command is a direct
// Inventory mutation and must be guarded like any other.
router.post(
  "/create",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  requireInventoryEnabled({ operation: "voice-inventory-create" }),
  createVoiceInventory,
);

module.exports = router;

