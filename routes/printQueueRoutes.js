const express = require('express');
const router = express.Router();
const {
  getPending,
  markPrinted,
  addToQueue,
  getAll,
  cleanup
} = require('../controllers/printQueueController');
const { protect, authorize } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

// Get pending print jobs
router.get('/pending', authorize(['admin', 'franchise_admin', 'super_admin']), getPending);

// Mark as printed
router.post('/:id/printed', authorize(['admin', 'franchise_admin', 'super_admin']), markPrinted);

// Add to queue
router.post('/', authorize(['admin', 'franchise_admin', 'super_admin']), addToQueue);

// Get all jobs
router.get('/', authorize(['admin', 'franchise_admin', 'super_admin']), getAll);

// Cleanup old jobs
router.delete('/cleanup', authorize(['admin', 'franchise_admin', 'super_admin']), cleanup);

module.exports = router;
