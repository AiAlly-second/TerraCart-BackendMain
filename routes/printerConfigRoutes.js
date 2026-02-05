const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getPrinterConfig,
  savePrinterConfig,
} = require("../controllers/printerConfigController");

router.use(protect);

// GET: waiter, captain, manager (to print KOT/Bill)
router.get("/", authorize(["waiter", "captain", "manager"]), getPrinterConfig);
// PUT: manager only (to configure printer)
router.put("/", authorize(["manager"]), savePrinterConfig);

module.exports = router;
