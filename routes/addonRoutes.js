const express = require("express");
const router = express.Router();
const addonController = require("../controllers/addonController");
const { protect } = require("../middleware/authMiddleware");

// Public routes (for customer frontend)
router.get("/public", addonController.getPublicAddons);

// Protected routes (for admin panel)
router.use(protect); // All routes below require authentication

router.get("/", addonController.getAddons);
router.post("/", addonController.createAddon);
router.put("/:id", addonController.updateAddon);
router.delete("/:id", addonController.deleteAddon);

module.exports = router;


