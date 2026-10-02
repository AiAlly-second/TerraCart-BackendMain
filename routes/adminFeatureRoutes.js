const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const controller = require("../controllers/featureController");
const router = express.Router();

router.use(protect, authorize(["super_admin"]));
router.get("/features", controller.getPlatformFeatures);
router.patch("/features/inventory", controller.patchPlatformInventory);
router.post("/features/inventory/bulk", controller.bulkPatchFranchiseInventory);
router.get("/franchises/:franchiseAdminId/features", controller.getFranchiseFeatures);
router.patch("/franchises/:franchiseAdminId/features/inventory", controller.patchFranchiseInventory);

module.exports = router;
