const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { getMyFeatures } = require("../controllers/featureController");
const router = express.Router();

router.get("/", protect, getMyFeatures);
module.exports = router;
