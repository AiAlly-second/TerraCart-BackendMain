const express = require("express");
const { reverseGeocode } = require("../controllers/geocodeController");

const router = express.Router();

// Public endpoint used by customer app to avoid browser CORS issues
// against third-party reverse geocoding services.
router.get("/reverse", reverseGeocode);

module.exports = router;

