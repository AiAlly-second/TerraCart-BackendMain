const express = require('express');
const router = express.Router();
const { printKOT, testPrinter } = require('../controllers/networkPrinterController');
const { getPendingKots } = require('../controllers/orderController');
const { protect, authorize } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

// Pending KOTs for Print Bridge recovery (when socket is down)
router.get(
  '/pending-kots',
  authorize(['admin', 'manager', 'waiter', 'captain']),
  getPendingKots
);

// Print KOT to network printer
router.post('/network', printKOT);

// Test printer connection
router.post('/test', testPrinter);

module.exports = router;
