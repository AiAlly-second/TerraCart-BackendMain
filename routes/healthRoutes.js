// Health check endpoint for fallback system
// Add this to your backend routes

const express = require('express');
const mongoose = require("mongoose");
const { getRedisAppStatus } = require("../services/redisAppClient");
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
    const mongoReady = mongoose.connection.readyState === 1;
    const redis = getRedisAppStatus();
    cachedHealthResponse = {
      status: mongoReady ? (redis.configured && !redis.ready ? "degraded" : "healthy") : "unhealthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      mongo: { ready: mongoReady },
      redis,
    };
    cachedHealthExpiresAt = now + HEALTH_CACHE_TTL_MS;
  }

  res.status(cachedHealthResponse.mongo.ready ? 200 : 503).json(cachedHealthResponse);
});

module.exports = router;
