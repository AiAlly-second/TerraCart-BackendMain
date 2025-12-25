/**
 * Distance Calculator Utility
 * Uses Haversine formula to calculate distance between two coordinates
 */

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {Number} lat1 - Latitude of first point
 * @param {Number} lon1 - Longitude of first point
 * @param {Number} lat2 - Latitude of second point
 * @param {Number} lon2 - Longitude of second point
 * @returns {Number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers

  return Math.round(distance * 100) / 100; // Round to 2 decimal places
}

/**
 * Convert degrees to radians
 * @param {Number} degrees - Angle in degrees
 * @returns {Number} Angle in radians
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Check if customer location is within delivery radius
 * @param {Number} customerLat - Customer latitude
 * @param {Number} customerLon - Customer longitude
 * @param {Number} cartLat - Cart latitude
 * @param {Number} cartLon - Cart longitude
 * @param {Number} maxRadius - Maximum delivery radius in km
 * @returns {Object} { isWithinRange: Boolean, distance: Number }
 */
function isWithinDeliveryRange(customerLat, customerLon, cartLat, cartLon, maxRadius) {
  if (!customerLat || !customerLon || !cartLat || !cartLon) {
    return { isWithinRange: false, distance: null };
  }

  const distance = calculateDistance(customerLat, customerLon, cartLat, cartLon);
  return {
    isWithinRange: distance <= maxRadius,
    distance: distance,
  };
}

module.exports = {
  calculateDistance,
  toRadians,
  isWithinDeliveryRange,
};

