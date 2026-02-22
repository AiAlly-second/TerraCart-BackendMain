const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getPrinterConfig,
  savePrinterConfig,
} = require("../controllers/printerConfigController");

router.use(protect);

// GET: waiter/captain/manager/admin (to print KOT/Bill)
router.get("/", authorize(["waiter", "captain", "manager", "admin"]), getPrinterConfig);
// PUT: manager/admin (to configure printer)
router.put("/", authorize(["manager", "admin"]), savePrinterConfig);

module.exports = router;
