/**
 * Unit Conversion Utilities
 * Centralized conversion logic for ingredient units
 */

const UNIT_CONVERSIONS = {
  // Weight conversions (to grams as base)
  kg: { base: "g", factor: 1000 },
  g: { base: "g", factor: 1 },
  
  // Volume conversions (to ml as base)
  l: { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  
  // Count-based (default 1:1 with pcs unless customized elsewhere)
  pcs: { base: "pcs", factor: 1 },
  pack: { base: "pcs", factor: 1 },
  box: { base: "pcs", factor: 1 },
  bottle: { base: "pcs", factor: 1 },
  dozen: { base: "pcs", factor: 12 },
};

/**
 * Convert quantity from one unit to another
 * @param {Number} qty - Quantity to convert
 * @param {String} fromUom - Source unit
 * @param {String} toUom - Target unit
 * @returns {Number} Converted quantity
 */
function convertUnit(qty, fromUom, toUom) {
  if (fromUom === toUom) return qty;

  const from = UNIT_CONVERSIONS[fromUom];
  const to = UNIT_CONVERSIONS[toUom];

  if (!from || !to) {
    throw new Error(`Unknown unit: ${fromUom} or ${toUom}`);
  }

  // If same base unit, convert directly
  if (from.base === to.base) {
    return (qty * from.factor) / to.factor;
  }

  // Cannot convert between different base types (weight vs volume vs count)
  throw new Error(`Cannot convert from ${fromUom} (${from.base}) to ${toUom} (${to.base})`);
}

/**
 * Get conversion factor between two units
 * @param {String} fromUom - Source unit
 * @param {String} toUom - Target unit
 * @returns {Number} Conversion factor
 */
function getConversionFactor(fromUom, toUom) {
  if (fromUom === toUom) return 1;
  return convertUnit(1, fromUom, toUom);
}

/**
 * Check if two units are compatible (same base type)
 * @param {String} uom1 - First unit
 * @param {String} uom2 - Second unit
 * @returns {Boolean} True if compatible
 */
function areUnitsCompatible(uom1, uom2) {
  if (uom1 === uom2) return true;
  
  const unit1 = UNIT_CONVERSIONS[uom1];
  const unit2 = UNIT_CONVERSIONS[uom2];
  
  if (!unit1 || !unit2) return false;
  
  return unit1.base === unit2.base;
}

module.exports = {
  convertUnit,
  getConversionFactor,
  areUnitsCompatible,
  UNIT_CONVERSIONS,
};




