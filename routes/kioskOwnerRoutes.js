const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllKioskOwners,
  getKioskOwner,
  createKioskOwner,
  updateKioskOwner,
  deleteKioskOwner,
} = require("../controllers/kioskOwnerController");

router.use(protect); // All routes require authentication

router.get("/", getAllKioskOwners);
router.get("/:id", getKioskOwner);
router.post("/", createKioskOwner);
router.put("/:id", updateKioskOwner);
router.delete("/:id", deleteKioskOwner);

module.exports = router;













