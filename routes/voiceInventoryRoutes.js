const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  parseVoiceInventory,
  createVoiceInventory,
} = require("../controllers/voiceInventoryController");

const router = express.Router();

router.use(protect);

router.post(
  "/parse",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  parseVoiceInventory,
);
router.post(
  "/create",
  authorize(["super_admin", "franchise_admin", "admin", "manager"]),
  createVoiceInventory,
);

module.exports = router;

