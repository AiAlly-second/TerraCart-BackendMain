/**
 * Security Middleware
 * Provides production-ready security features:
 * - Rate limiting to prevent brute force and DDoS
 * - Security headers
 * - Input sanitization
 * - XSS protection
 */

const User = require("../models/userModel");

// ============= RATE LIMITING =============
// Simple in-memory rate limiter (for single instance)
// For production with multiple instances, use Redis

const rateLimitStore = new Map();
const apiKeyBypassCache = new Map();
const API_KEY_CACHE_TTL_MS = Number.parseInt(
  process.env.API_KEY_BYPASS_CACHE_TTL_MS || "60000",
  10,
);

const isTrustedApiKey = async (rawApiKey) => {
  const apiKey = String(rawApiKey || "").trim();
  if (!apiKey || !apiKey.startsWith("tc_live_")) return false;

  const now = Date.now();
  const cached = apiKeyBypassCache.get(apiKey);
  if (cached && now < cached.expiresAt) {
    return cached.allowed;
  }

  const exists = await User.exists({ "apiKeys.key": apiKey });
  const allowed = Boolean(exists);
  apiKeyBypassCache.set(apiKey, {
    allowed,
    expiresAt: now + (Number.isFinite(API_KEY_CACHE_TTL_MS) ? API_KEY_CACHE_TTL_MS : 60000),
  });

  return allowed;
};

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
  for (const [key, data] of apiKeyBypassCache.entries()) {
    if (!data || now > data.expiresAt) {
      apiKeyBypassCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware factory
 * @param {object} options - Configuration options
 */
const createRateLimiter = (options = {}) => {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // In development, use much more lenient limits or disable
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100, // Max requests per window
    message = 'Too many requests, please try again later',
    keyGenerator = (req) => {
      // Better IP detection
      return req.ip || 
             req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
             req.connection?.remoteAddress || 
             req.socket?.remoteAddress ||
             'unknown';
    },
    skipSuccessfulRequests = false,
    skipFailedRequests = false
  } = options;

  // In development, multiply limits by 50x or disable entirely
  const effectiveMax = isDevelopment ? (max * 50) : max;
  const effectiveWindowMs = isDevelopment ? (windowMs / 2) : windowMs; // Shorter window in dev

  return async (req, res, next) => {
    // Skip rate limiting in development if explicitly disabled
    if (isDevelopment && process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    // SPECIAL: Exempt trusted API key requests (Fabric Team / Analytics Integration).
    // Do not bypass based on prefix alone.
    const apiKey = req.headers["x-api-key"];
    if (apiKey) {
      try {
        const trusted = await isTrustedApiKey(apiKey);
        if (trusted) return next();
      } catch (error) {
        // Continue with normal rate limiting if API key lookup fails.
      }
    }
    
    // In development, be very lenient - allow almost unlimited requests
    if (isDevelopment) {
      // Only enforce rate limiting if explicitly enabled
      if (process.env.ENABLE_RATE_LIMIT !== 'true') {
        return next();
      }
    }

    const key = keyGenerator(req);
    const now = Date.now();

    let data = rateLimitStore.get(key);
    
    if (!data || now > data.resetTime) {
      // New window
      data = {
        count: 0,
        resetTime: now + effectiveWindowMs
      };
    }

    data.count++;
    rateLimitStore.set(key, data);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', effectiveMax);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, effectiveMax - data.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(data.resetTime / 1000));

    if (data.count > effectiveMax) {
      res.setHeader('Retry-After', Math.ceil((data.resetTime - now) / 1000));
      return res.status(429).json({
        success: false,
        message: isDevelopment 
          ? `Rate limit exceeded (dev mode: ${effectiveMax} requests per ${effectiveWindowMs/1000}s)`
          : message,
        retryAfter: Math.ceil((data.resetTime - now) / 1000)
      });
    }

    // Hook into response to track success/failure
    if (skipSuccessfulRequests || skipFailedRequests) {
      const originalEnd = res.end;
      res.end = function(...args) {
        if ((skipSuccessfulRequests && res.statusCode < 400) ||
            (skipFailedRequests && res.statusCode >= 400)) {
          data.count = Math.max(0, data.count - 1);
          rateLimitStore.set(key, data);
        }
        originalEnd.apply(res, args);
      };
    }

    next();
  };
};

// Pre-configured rate limiters
const isDevelopment = process.env.NODE_ENV !== 'production';

const rateLimiters = {
  // General API rate limit
  // In dev: Disabled by default (can enable with ENABLE_RATE_LIMIT=true)
  // In prod: 500 requests per 15 min
  api: createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // 500 requests per 15 min (disabled in dev by default)
    message: 'Too many API requests'
  }),

  // Login attempts - secure default in production
  // In dev: Disabled by default unless ENABLE_RATE_LIMIT=true.
  // In prod: configurable via RATE_LIMIT_LOGIN env var, with secure default.
  login: createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: Number.parseInt(process.env.RATE_LIMIT_LOGIN || "10", 10) || 10,
    message: 'Too many login attempts. Please try again later.',
    skipSuccessfulRequests: true // Don't count successful logins
  }),

  // Very strict for password reset
  // In dev: 50 attempts per 30 min, in prod: 5 per hour
  passwordReset: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // Only 5 password reset requests per hour (50 in dev)
    message: 'Too many password reset attempts. Please try again later.'
  }),

  // File upload limit
  // In dev: 500 uploads per 30 min, in prod: 50 per hour
  upload: createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // 50 uploads per hour (500 in dev)
    message: 'Upload limit exceeded. Please try again later.'
  }),

  // Order creation limit
  // In dev: 300 orders per 30 sec, in prod: 30 per minute
  orders: createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 orders per minute per IP (300 in dev)
    message: 'Order rate limit exceeded. Please slow down.'
  })
};

// Helper to clear rate limit store (useful for development)
if (isDevelopment) {
  // Clear rate limits on server restart
  rateLimitStore.clear();
}

// ============= SECURITY HEADERS =============
/**
 * Add security headers to response
 */
const securityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  // Remove server identification
  res.removeHeader('X-Powered-By');
  
  next();
};

// ============= INPUT SANITIZATION =============
/**
 * Sanitize string to prevent XSS
 */
const sanitizeString = (str) => {
  if (typeof str !== 'string') return str;
  
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
};

/**
 * Recursively sanitize an object
 */
const sanitizeObject = (obj, depth = 0) => {
  // Prevent deep nesting attacks
  if (depth > 10) return obj;
  
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, depth + 1));
  }
  
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const key of Object.keys(obj)) {
      // Sanitize key names too
      const safeKey = sanitizeString(key);
      sanitized[safeKey] = sanitizeObject(obj[key], depth + 1);
    }
    return sanitized;
  }
  
  return obj;
};

/**
 * Middleware to sanitize request body, query, and params
 */
const sanitizeInput = (req, res, next) => {
  // Skip sanitization for file uploads and specific routes
  if (req.is('multipart/form-data')) {
    return next();
  }

  // Skip sanitization for certain fields that need raw content
  const skipFields = ['password', 'confirmPassword', 'newPassword', 'oldPassword'];
  
  const sanitizeWithSkip = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    const result = {};
    for (const key of Object.keys(obj)) {
      if (skipFields.includes(key)) {
        result[key] = obj[key]; // Keep passwords raw
      } else {
        result[key] = sanitizeObject(obj[key]);
      }
    }
    return result;
  };

  if (req.body) req.body = sanitizeWithSkip(req.body);
  if (req.query) req.query = sanitizeObject(req.query);
  if (req.params) req.params = sanitizeObject(req.params);
  
  next();
};

// ============= REQUEST VALIDATION =============
/**
 * Validate MongoDB ObjectId
 */
const isValidObjectId = (id) => {
  return /^[a-f\d]{24}$/i.test(id);
};

/**
 * Middleware to validate ID parameters
 */
const validateIdParam = (paramName = 'id') => (req, res, next) => {
  const id = req.params[paramName];
  
  if (id && !isValidObjectId(id)) {
    return res.status(400).json({
      success: false,
      message: `Invalid ${paramName} format`
    });
  }
  
  next();
};

// ============= LOGGING (Production Safe) =============
/**
 * Safe request logger that doesn't log sensitive data
 */
const safeLogger = (req, res, next) => {
  // Only log in development or if explicitly enabled
  if (process.env.NODE_ENV !== 'development' && !process.env.ENABLE_REQUEST_LOGGING) {
    return next();
  }

  const start = Date.now();
  
  // Log request without sensitive data
  const logData = {
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent')?.substring(0, 50)
  };
  
  // Don't log passwords, tokens, or other sensitive data
  const sensitiveFields = ['password', 'token', 'authorization', 'cookie', 'aadhar', 'pan'];
  const safeBody = { ...req.body };
  sensitiveFields.forEach(field => {
    if (safeBody[field]) safeBody[field] = '[REDACTED]';
    // Also check nested objects
    Object.keys(safeBody).forEach(key => {
      if (key.toLowerCase().includes(field.toLowerCase())) {
        safeBody[key] = '[REDACTED]';
      }
    });
  });
  
  // Request logging removed for cleaner console output
  
  // Log response time
  res.on('finish', () => {
    // Response completed
  });
  
  next();
};

// ============= ERROR HANDLER =============
/**
 * Production-safe error handler that doesn't leak sensitive info
 */
const errorHandler = (err, req, res, next) => {
  // Handle CORS errors gracefully (don't log as errors)
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      message: 'CORS: Origin not allowed'
    });
  }

  // Skip logging for OPTIONS requests (preflight)
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Log error internally (skip for CORS)
  if (err.message !== 'Not allowed by CORS') {
    console.error('[ERROR]', {
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      path: req.path,
      method: req.method
    });
  }

  // Determine status code
  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  if (err.name === 'ValidationError') statusCode = 400;
  if (err.name === 'CastError') statusCode = 400;
  if (err.name === 'JsonWebTokenError') statusCode = 401;
  if (err.name === 'TokenExpiredError') statusCode = 401;

  // Send safe error response
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production' 
      ? 'An error occurred. Please try again.'
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// ============= CORS CONFIGURATION =============
/**
 * Get production CORS configuration
 */
const getCorsConfig = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Session-Token',
    'x-session-token',
    'X-Order-Session-Token',
    'x-order-session-token',
    'X-Idempotency-Key',
    'x-idempotency-key',
    'Idempotency-Key',
    'X-Session-Token',
    'x-session-token',
    'X-Session-Id',
    'x-session-id',
    'X-Anonymous-Session-Id',
    'x-anonymous-session-id',
  ];
  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [
        'http://localhost:3000', 
        'http://localhost:5173', 
        'http://localhost:5174', 
        'http://localhost:5175',
        // S3 Static Website URLs
        'http://teracart-customer-app.s3-website.ap-south-1.amazonaws.com',
        'http://teracart-admin-panel.s3-website.ap-south-1.amazonaws.com',
        // CloudFront URLs (add your actual CloudFront domains)
        'https://d1ncz4zbdagpz3.cloudfront.net',  // Replace with your actual CloudFront domain
        'https://d3sp6r9lbwue9i.cloudfront.net',  // Replace with your actual CloudFront domain
      ];

  // In development, allow all origins
  if (!isProduction) {
    return {
      origin: true, // Allow all origins in development
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders,
      exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
      maxAge: 86400,
      preflightContinue: false,
      optionsSuccessStatus: 204
    };
  }

  // Production: strict origin checking
  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204
  };
};

module.exports = {
  rateLimiters,
  createRateLimiter,
  securityHeaders,
  sanitizeInput,
  sanitizeString,
  sanitizeObject,
  validateIdParam,
  isValidObjectId,
  safeLogger,
  errorHandler,
  getCorsConfig
};

