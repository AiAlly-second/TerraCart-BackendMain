const express = require("express");
const { optionalProtect } = require("../middleware/authMiddleware");
const { translateMenuPageTexts } = require("../controllers/translationController");

const router = express.Router();

router.post("/menu-page", optionalProtect, translateMenuPageTexts);

module.exports = router;
