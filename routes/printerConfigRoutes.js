const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/authMiddleware");
const {
  getPrinterConfig,
  savePrinterConfig,
} = require("../controllers/printerConfigController");

router.use(protect);
router.use(authorize(["manager"]));

router.get("/", getPrinterConfig);
router.put("/", savePrinterConfig);

module.exports = router;
