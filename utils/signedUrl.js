/**
 * Signed URL Utility
 * Generates and validates signed URLs for secure file access
 * 
 * This prevents unauthorized access to uploaded files like:
 * - Aadhar cards
 * - PAN cards
 * - Certificates
 * - Other sensitive documents
 */

const crypto = require('crypto');

// Get signing secret from environment or use a derived one
const getSigningSecret = () => {
  const secret = process.env.SIGNED_URL_SECRET || process.env.JWT_SECRET;
  return secret || 'default-signed-url-secret-change-in-production';
};

/**
 * Generate a signed URL for accessing a protected file
 * @param {string} filePath - The file path (e.g., "/uploads/franchise-docs/file.pdf")
 * @param {number} expiresInMinutes - Expiration time in minutes (default: 60)
 * @returns {object} - { signedUrl, expiresAt }
 */
const generateSignedUrl = (filePath, expiresInMinutes = 60) => {
  if (!filePath) return null;

  const secret = getSigningSecret();
  const expiresAt = Date.now() + (expiresInMinutes * 60 * 1000);
  
  // Create signature
  const dataToSign = `${filePath}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex');

  // Build signed URL
  const baseUrl = process.env.API_BASE_URL || '';
  const signedUrl = `${baseUrl}/api/files/secure${filePath}?expires=${expiresAt}&signature=${signature}`;

  return {
    signedUrl,
    expiresAt: new Date(expiresAt).toISOString()
  };
};

/**
 * Validate a signed URL signature
 * @param {string} filePath - The requested file path
 * @param {number} expires - Expiration timestamp
 * @param {string} signature - The provided signature
 * @returns {object} - { valid, error }
 */
const validateSignedUrl = (filePath, expires, signature) => {
  // Check if URL has expired
  if (Date.now() > parseInt(expires)) {
    return { valid: false, error: 'URL has expired' };
  }

  // Validate signature
  const secret = getSigningSecret();
  const dataToSign = `${filePath}:${expires}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    
    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: false, error: 'Invalid signature' };
    }
  } catch (err) {
    return { valid: false, error: 'Invalid signature format' };
  }

  return { valid: true };
};

/**
 * Transform user object to include signed URLs for documents
 * @param {object} user - User object from database
 * @param {number} expiresInMinutes - URL expiration (default: 60 minutes)
 * @returns {object} - User object with signed URLs
 */
const addSignedUrlsToUser = (user, expiresInMinutes = 60) => {
  if (!user) return user;

  const userObj = user.toObject ? user.toObject() : { ...user };
  
  // List of document fields that need signed URLs
  const documentFields = [
    'udyamCertificate',
    'aadharCard', 
    'panCard',
    'gstCertificate',
    'shopActLicense',
    'fssaiLicense',
    'electricityBill',
    'rentAgreement'
  ];

  documentFields.forEach(field => {
    if (userObj[field]) {
      const result = generateSignedUrl(userObj[field], expiresInMinutes);
      if (result) {
        // Store both original path (for admin reference) and signed URL
        userObj[`${field}Url`] = result.signedUrl;
        userObj[`${field}Expires`] = result.expiresAt;
      }
    }
  });

  return userObj;
};

module.exports = {
  generateSignedUrl,
  validateSignedUrl,
  addSignedUrlsToUser
};







