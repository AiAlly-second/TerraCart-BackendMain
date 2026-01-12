/**
 * Signed URL Utility
 * Generates and validates signed URLs for secure file access (S3 and Local)
 * 
 * This prevents unauthorized access to uploaded files like:
 * - Aadhar cards
 * - PAN cards
 * - Certificates
 * - Other sensitive documents
 */

const crypto = require('crypto');
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3 } = require("../config/uploadConfig");

// Get signing secret from environment or use a derived one
const getSigningSecret = () => {
  const secret = process.env.SIGNED_URL_SECRET || process.env.JWT_SECRET;
  return secret || 'default-signed-url-secret-change-in-production';
};

/**
 * Generate a signed URL for accessing a protected file
 * @param {string} filePath - The file path (e.g., "/uploads/franchise-docs/file.pdf" or S3 URL)
 * @param {number} expiresInMinutes - Expiration time in minutes (default: 60)
 * @returns {Promise<object>} - { signedUrl, expiresAt }
 */
const generateSignedUrl = async (filePath, expiresInMinutes = 60) => {
  if (!filePath) return null;
  
  const expiresAtMs = Date.now() + (expiresInMinutes * 60 * 1000);
  const expiresAtISO = new Date(expiresAtMs).toISOString();

  // CHECK IF S3 URL (starts with http/https)
  if (filePath.startsWith('http')) {
    try {
      if (process.env.USE_S3 !== "true") {
        // If system is not configured for S3 but we have an S3 URL, return it as is or try to sign it?
        // Let's assume we sign it if it looks like S3.
      }
      
      // Extract Key from URL
      // URL format: https://bucket.s3.region.amazonaws.com/folder/file.ext
      // or https://s3.region.amazonaws.com/bucket/folder/file.ext
      
      let key;
      try {
        const urlObj = new URL(filePath);
        // Pathname is /folder/file.ext (for subdomain style)
        // or /bucket/folder/file.ext (for path style)
        
        // Simple heuristic: If pathname starts with slash, remove it.
        key = urlObj.pathname.substring(1); 
        
        // Note: This simple key extraction assumes subdomain style for most S3 URLs.
        // If path style is used, key might include bucket name? 
        // SDK 'location' usually returns subdomain style if configured.
        // Let's rely on decoding it simply.
        
        // Decode URI components (spaces, etc)
        key = decodeURIComponent(key);
      } catch (e) {
        console.error("Invalid S3 URL parsing:", e);
        return { signedUrl: filePath, expiresAt: expiresAtISO }; // Fallback
      }

      const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
      });

      const signedUrl = await getSignedUrl(s3, command, { expiresIn: expiresInMinutes * 60 });
      
      return {
        signedUrl,
        expiresAt: expiresAtISO // AWS signed URL expiry is embedded, but we return our calc for consistency
      };
    } catch (error) {
      console.error("Error signing S3 URL:", error);
      return { signedUrl: filePath, expiresAt: expiresAtISO }; // Fallback to original
    }
  }

  // LOCAL SIGNING LOGIC
  const secret = getSigningSecret();
  
  // Create signature
  const dataToSign = `${filePath}:${expiresAtMs}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex');

  // Build signed URL
  const baseUrl = process.env.API_BASE_URL || '';
  const signedUrl = `${baseUrl}/api/files/secure${filePath}?expires=${expiresAtMs}&signature=${signature}`;

  return {
    signedUrl,
    expiresAt: expiresAtISO
  };
};

/**
 * Validate a signed URL signature (Local only)
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
 * @returns {Promise<object>} - User object with signed URLs
 */
const addSignedUrlsToUser = async (user, expiresInMinutes = 60) => {
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

  // Use Promise.all to handle concurrent signing
  const signingPromises = documentFields.map(async (field) => {
    if (userObj[field]) {
      const result = await generateSignedUrl(userObj[field], expiresInMinutes);
      if (result) {
        // Store both original path (for admin reference) and signed URL
        userObj[`${field}Url`] = result.signedUrl;
        userObj[`${field}Expires`] = result.expiresAt;
      }
    }
  });

  await Promise.all(signingPromises);

  return userObj;
};

module.exports = {
  generateSignedUrl,
  validateSignedUrl,
  addSignedUrlsToUser
};
