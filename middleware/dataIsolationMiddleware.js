/**
 * Data Isolation Middleware
 * Automatically attaches cafeId/franchiseId to request based on user's role
 * This ensures data isolation across different cafes and franchises
 */

/**
 * Middleware to attach data isolation filters to request
 * This should be used after protect middleware
 */
exports.attachDataIsolation = (req, res, next) => {
  // Skip if user is not authenticated
  if (!req.user) {
    return next();
  }

  // Attach data isolation info to request
  req.dataIsolation = {
    cafeId: req.user.cafeId || null,
    franchiseId: req.user.franchiseId || null,
    cartId: req.user.cafeId || null, // For backward compatibility
  };

  next();
};

/**
 * Helper function to build query with data isolation
 * @param {Object} req - Express request object
 * @param {Object} baseQuery - Base query object
 * @returns {Object} - Query with data isolation applied
 */
exports.buildIsolatedQuery = (req, baseQuery = {}) => {
  const query = { ...baseQuery };

  if (req.user) {
    if (req.user.cafeId) {
      query.cafeId = req.user.cafeId;
      query.cartId = req.user.cafeId; // For backward compatibility
    } else if (req.user.franchiseId) {
      query.franchiseId = req.user.franchiseId;
    }
  }

  return query;
};

/**
 * Helper function to attach data isolation to new documents
 * @param {Object} req - Express request object
 * @param {Object} data - Document data
 * @returns {Object} - Data with isolation fields attached
 */
exports.attachIsolationFields = (req, data) => {
  const result = { ...data };

  if (req.user) {
    if (req.user.cafeId) {
      result.cafeId = req.user.cafeId;
      result.cartId = req.user.cafeId; // For backward compatibility
      if (req.user.franchiseId) {
        result.franchiseId = req.user.franchiseId;
      }
    } else if (req.user.franchiseId) {
      result.franchiseId = req.user.franchiseId;
    }
  }

  return result;
};

module.exports = exports;

