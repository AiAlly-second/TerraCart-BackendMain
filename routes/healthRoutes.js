// Health check endpoint for fallback system
// Add this to your backend routes

const express = require('express');
const router = express.Router();

const HEALTH_CACHE_TTL_MS = 5000;
let cachedHealthResponse = null;
let cachedHealthExpiresAt = 0;

/**
 * @route   GET /api/health
 * @desc    Health check endpoint
 * @access  Public
 */
router.get('/health', (req, res) => {
  const now = Date.now();
  if (!cachedHealthResponse || now >= cachedHealthExpiresAt) {
    cachedHealthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };
    cachedHealthExpiresAt = now + HEALTH_CACHE_TTL_MS;
  }

  res.status(200).json(cachedHealthResponse);
});

module.exports = router;
