/**
 * Secure File Routes
 * Handles serving protected files with signed URL verification
 * 
 * Note: Using manual path parsing for Express 5 compatibility
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { validateSignedUrl, generateSignedUrl } = require('../utils/signedUrl');
const { protect } = require('../middleware/authMiddleware');

/**
 * Middleware to handle secure file requests
 * Matches /api/files/secure/uploads/... paths
 */
const handleSecureFile = (req, res, next) => {
  // Check if this is a secure file request
  if (!req.path.startsWith('/secure/uploads/')) {
    return next();
  }
//jai hind maafi hai
  try {
    // Extract the file path after /secure/uploads/
    const filePathAfterPrefix = req.path.replace('/secure/uploads/', '');
    const requestedPath = '/uploads/' + filePathAfterPrefix;
    const { expires, signature } = req.query;

    // Validate required parameters
    if (!expires || !signature) {
      return res.status(401).json({
        success: false,
        message: 'Missing authorization parameters'
      });
    }

    // Validate the signed URL
    const validation = validateSignedUrl(requestedPath, expires, signature);
    if (!validation.valid) {
      return res.status(401).json({
        success: false,
        message: validation.error || 'Invalid or expired URL'
      });
    }

    // Construct the actual file path
    const filePath = path.join(__dirname, '..', requestedPath);

    // Security: Prevent directory traversal
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(uploadsDir)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.jfif': 'image/jpeg'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Set security headers for file serving
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600'); // 1 hour cache for signed URLs
    
    // For images, allow inline display; for documents, suggest download
    if (ext === '.pdf') {
      res.setHeader('Content-Disposition', 'inline');
    }

    // Send the file
    res.sendFile(resolvedPath);
  } catch (error) {
    console.error('[FILE SERVE] Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error serving file'
    });
  }
};

/**
 * Middleware to handle public menu image requests
 * Matches /api/files/public/uploads/menu/... paths
 */
const handlePublicMenuImage = (req, res, next) => {
  // Check if this is a public menu image request
  if (!req.path.startsWith('/public/uploads/menu/')) {
    return next();
  }

  try {
    // Extract the file path after /public/uploads/menu/
    const filePathAfterPrefix = req.path.replace('/public/uploads/menu/', '');
    const filePath = path.join(__dirname, '..', 'uploads', 'menu', filePathAfterPrefix);

    // Security: Prevent directory traversal
    const menuDir = path.join(__dirname, '..', 'uploads', 'menu');
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(menuDir)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }

    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const contentType = mimeTypes[ext] || 'image/jpeg';

    // Set headers for caching
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hour cache

    res.sendFile(resolvedPath);
  } catch (error) {
    console.error('[PUBLIC FILE] Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error serving file'
    });
  }
};

// Apply middleware to handle file requests
router.use(handleSecureFile);
router.use(handlePublicMenuImage);

/**
 * @route   POST /api/files/generate-url
 * @desc    Generate a signed URL for a file (admin only)
 * @access  Private (requires authentication)
 */
router.post('/generate-url', protect, async (req, res) => {
  try {
    const { filePath, expiresInMinutes = 60 } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: 'File path is required'
      });
    }

    // Only allow authorized users to generate signed URLs
    if (!['super_admin', 'franchise_admin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to generate file URLs'
      });
    }

    const result = await generateSignedUrl(filePath, expiresInMinutes);
    
    if (!result) {
      return res.status(400).json({
        success: false,
        message: 'Failed to generate signed URL'
      });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[FILE URL] Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error generating URL'
    });
  }
});

module.exports = router;
