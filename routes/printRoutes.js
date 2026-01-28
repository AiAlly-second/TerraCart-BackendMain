const express = require('express');
const router = express.Router();
const { printKOT, testPrinter } = require('../controllers/networkPrinterController');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

// Print KOT to network printer
router.post('/network', printKOT);

// Test printer connection
router.post('/test', testPrinter);

module.exports = router;
