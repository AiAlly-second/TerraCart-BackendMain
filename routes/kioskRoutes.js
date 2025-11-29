const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getAllKiosks,
  getKiosk,
  createKiosk,
  updateKiosk,
  deleteKiosk,
} = require("../controllers/kioskController");

router.use(protect); // All routes require authentication

router.get("/", getAllKiosks);
router.get("/:id", getKiosk);
router.post("/", createKiosk);
router.put("/:id", updateKiosk);
router.delete("/:id", deleteKiosk);

module.exports = router;













