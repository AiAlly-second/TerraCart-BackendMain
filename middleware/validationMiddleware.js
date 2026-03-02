/**
 * Input Validation Middleware
 * Provides validation for common input types to prevent injection and bad data
 */

/**
 * Email validation regex
 */
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Phone number validation (Indian format)
 */
const phoneRegex = /^(\+91[\-\s]?)?[0]?(91)?[789]\d{9}$/;

/**
 * MongoDB ObjectId validation
 */
const objectIdRegex = /^[a-f\d]{24}$/i;

/**
 * GST Number validation (Indian format)
 */
const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Validate required fields in request body
 */
const validateRequired = (fields) => (req, res, next) => {
  const missing = [];
  
  for (const field of fields) {
    const value = req.body[field];
    if (value === undefined || value === null || value === '') {
      missing.push(field);
    }
  }
  
  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(', ')}`
    });
  }
  
  next();
};

/**
 * Validate email format
 */
const validateEmail = (field = 'email') => (req, res, next) => {
  const email = req.body[field];
  
  if (email && !emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid email format'
    });
  }
  
  // Normalize email to lowercase
  if (email) {
    req.body[field] = email.toLowerCase().trim();
  }
  
  next();
};

/**
 * Validate phone number
 */
const validatePhone = (field = 'phone', required = false) => (req, res, next) => {
  const phone = req.body[field];
  
  if (required && !phone) {
    return res.status(400).json({
      success: false,
      message: 'Phone number is required'
    });
  }
  
  if (phone && !phoneRegex.test(phone.replace(/\s/g, ''))) {
    return res.status(400).json({
      success: false,
      message: 'Invalid phone number format'
    });
  }
  
  next();
};

/**
 * Validate password strength
 */
const validatePassword = (field = 'password', minLength = 6) => (req, res, next) => {
  const password = req.body[field];
  
  if (!password) {
    return next(); // Let required validation handle missing password
  }
  
  if (password.length < minLength) {
    return res.status(400).json({
      success: false,
      message: `Password must be at least ${minLength} characters long`
    });
  }
  
  // Optional: Add more password strength checks
  // const hasUppercase = /[A-Z]/.test(password);
  // const hasLowercase = /[a-z]/.test(password);
  // const hasNumber = /[0-9]/.test(password);
  
  next();
};

/**
 * Validate MongoDB ObjectId in params
 */
const validateObjectId = (paramName = 'id') => (req, res, next) => {
  const id = req.params[paramName];
  
  if (id && !objectIdRegex.test(id)) {
    return res.status(400).json({
      success: false,
      message: `Invalid ${paramName} format`
    });
  }
  
  next();
};

/**
 * Validate GST number
 */
const validateGST = (field = 'gstNumber', required = false) => (req, res, next) => {
  const gst = req.body[field];
  
  if (required && !gst) {
    return res.status(400).json({
      success: false,
      message: 'GST number is required'
    });
  }
  
  if (gst && !gstRegex.test(gst.toUpperCase())) {
    return res.status(400).json({
      success: false,
      message: 'Invalid GST number format'
    });
  }
  
  // Normalize to uppercase
  if (gst) {
    req.body[field] = gst.toUpperCase();
  }
  
  next();
};

/**
 * Validate role
 */
const validateRole = (allowedRoles = []) => (req, res, next) => {
  const role = req.body.role;
  
  if (role && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    return res.status(400).json({
      success: false,
      message: `Invalid role. Must be one of: ${allowedRoles.join(', ')}`
    });
  }
  
  next();
};

/**
 * Validate date of birth (age validation)
 */
const validateDOB = (field = 'dob', minAge = 18) => (req, res, next) => {
  const dob = req.body[field];
  
  if (!dob) {
    return next(); // Let required validation handle if needed
  }
  
  const birthDate = new Date(dob);
  if (isNaN(birthDate.getTime())) {
    return res.status(400).json({
      success: false,
      message: 'Invalid date of birth format'
    });
  }
  
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  if (age < minAge) {
    return res.status(400).json({
      success: false,
      message: `Minimum age requirement is ${minAge} years (as per Indian labor laws)`
    });
  }
  
  if (age > 120) {
    return res.status(400).json({
      success: false,
      message: 'Invalid date of birth'
    });
  }
  
  next();
};

/**
 * Validate price/amount (positive number)
 */
const validatePrice = (field = 'price') => (req, res, next) => {
  const price = req.body[field];
  
  if (price !== undefined && price !== null) {
    const numPrice = parseFloat(price);
    
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({
        success: false,
        message: `${field} must be a positive number`
      });
    }
    
    // Store as number
    req.body[field] = numPrice;
  }
  
  next();
};

/**
 * Validate quantity (positive integer)
 */
const validateQuantity = (field = 'quantity') => (req, res, next) => {
  const quantity = req.body[field];
  
  if (quantity !== undefined && quantity !== null) {
    const numQuantity = parseInt(quantity, 10);
    
    if (isNaN(numQuantity) || numQuantity < 1) {
      return res.status(400).json({
        success: false,
        message: `${field} must be a positive integer`
      });
    }
    
    req.body[field] = numQuantity;
  }
  
  next();
};

/**
 * Validate order status
 */
const validOrderStatuses = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const validateOrderStatus = (field = 'status') => (req, res, next) => {
  const status = req.body[field];
  
  if (status && !validOrderStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Must be one of: ${validOrderStatuses.join(', ')}`
    });
  }
  
  next();
};

/**
 * Combine multiple validators
 */
const validate = (...validators) => {
  return async (req, res, next) => {
    for (const validator of validators) {
      let passed = true;
      await new Promise((resolve) => {
        validator(req, res, (err) => {
          if (err) {
            passed = false;
          }
          resolve();
        });
      });
      
      // If response was sent, stop processing
      if (res.headersSent) {
        return;
      }
    }
    next();
  };
};

/**
 * Sanitize HTML from string fields
 */
const sanitizeHtml = (fields = []) => (req, res, next) => {
  for (const field of fields) {
    if (req.body[field] && typeof req.body[field] === 'string') {
      // Remove HTML tags
      req.body[field] = req.body[field]
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
    }
  }
  next();
};

module.exports = {
  validateRequired,
  validateEmail,
  validatePhone,
  validatePassword,
  validateObjectId,
  validateGST,
  validateRole,
  validateDOB,
  validatePrice,
  validateQuantity,
  validateOrderStatus,
  validate,
  sanitizeHtml,
  validOrderStatuses
};







