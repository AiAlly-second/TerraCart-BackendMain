const express = require("express");
const {
  getAppVersion,
  downloadApkByVersion,
} = require("../controllers/appUpdateController");

const router = express.Router();

router.get("/version", getAppVersion);
router.get("/apk/:version", downloadApkByVersion);

module.exports = router;
