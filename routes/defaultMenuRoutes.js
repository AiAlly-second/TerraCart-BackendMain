const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getDefaultMenu,
  updateDefaultMenu,
  deleteDefaultMenu,
  pushToFranchise,
  pushToCafe,
} = require("../controllers/defaultMenuController");

// All routes require admin (super_admin or franchise_admin)
router.use(protect);
router.use(authorize(["super_admin", "franchise_admin"]));

router.get("/", getDefaultMenu);
router.put("/", updateDefaultMenu);
router.delete("/", deleteDefaultMenu);
router.post("/push/franchise/:franchiseId", pushToFranchise);
router.post("/push/cafe/:cartId", pushToCafe);

module.exports = router;

