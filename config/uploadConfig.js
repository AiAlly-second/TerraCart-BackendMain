const multer = require("multer");
const { S3Client } = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3");
const path = require("path");
const fs = require("fs");

// Initialize S3 Client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Creates a Multer storage engine based on environment configuration.
 * @param {string} folderName - The specific folder for this upload type (e.g., 'menu', 'invoices')
 */
const getStorageCallback = (folderName) => {
  // If USE_S3 is true, upload to AWS S3
  if (process.env.USE_S3 === "true") {
    return multerS3({
      s3: s3,
      bucket: process.env.AWS_BUCKET_NAME,
      metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
      },
      key: function (req, file, cb) {
        // Generate unique filename: folder/timestamp-random.ext
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        const fullPath = `${folderName}/${uniqueSuffix}${ext}`;
        cb(null, fullPath);
      },
      contentType: multerS3.AUTO_CONTENT_TYPE,
    });
  }

  // Otherwise, fallback to Local Disk Storage (default)
  const uploadsDir = path.join(__dirname, "..", "uploads", folderName);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `${uniqueSuffix}${ext}`);
    },
  });
};

/**
 * Helper to get the public URL of an uploaded file.
 * Handles both S3 URLs and local server URLs.
 */
const getFileUrl = (req, file, folderName = "") => {
  if (process.env.USE_S3 === "true") {
    // S3 file object has a 'location' property with the full URL
    return file.location; 
  } else {
    // Local file - return relative path only (no leading slash)
    // Frontend will prepend the API base URL
    if (folderName) {
      return `uploads/${folderName}/${file.filename}`;
    }
    return `uploads/${file.filename}`;
  }
};

module.exports = {
  s3,
  getStorageCallback,
  getFileUrl
};
