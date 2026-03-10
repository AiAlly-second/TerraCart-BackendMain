const ALLOWED_INVENTORY_UNITS = Object.freeze([
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "pack",
  "box",
  "bottle",
  "dozen",
]);
const DEFAULT_MAX_QUANTITY_WITHOUT_CONFIRMATION = 50;

const normalizeInventoryCandidate = (item = {}) => {
  const quantity = Number(item.quantity);
  const unit = String(item.unit || "")
    .trim()
    .toLowerCase();

  return {
    ...item,
    quantity,
    unit,
  };
};

const validateInventoryItem = (
  item,
  options = { maxQuantityWithoutConfirmation: DEFAULT_MAX_QUANTITY_WITHOUT_CONFIRMATION },
) => {
  const normalizedItem = normalizeInventoryCandidate(item);
  const errors = [];
  const warnings = [];
  let requiresConfirmation = false;

  if (!Number.isFinite(normalizedItem.quantity) || normalizedItem.quantity <= 0) {
    errors.push("quantity must be greater than 0");
  }

  if (!ALLOWED_INVENTORY_UNITS.includes(normalizedItem.unit)) {
    errors.push(`unit must be one of: ${ALLOWED_INVENTORY_UNITS.join(", ")}`);
  }

  if (normalizedItem.quantity > options.maxQuantityWithoutConfirmation) {
    requiresConfirmation = true;
    warnings.push(
      `quantity ${normalizedItem.quantity} is high; confirmation required`,
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    requiresConfirmation,
    item: normalizedItem,
  };
};

const validateInventoryItems = (items, options = {}) => {
  const candidates = Array.isArray(items) ? items : [];
  const normalizedItems = [];
  const errors = [];
  const warnings = [];
  let requiresConfirmation = false;

  candidates.forEach((item, index) => {
    const result = validateInventoryItem(item, {
      maxQuantityWithoutConfirmation:
        options.maxQuantityWithoutConfirmation ||
        DEFAULT_MAX_QUANTITY_WITHOUT_CONFIRMATION,
    });

    normalizedItems.push(result.item);
    if (!result.isValid) {
      result.errors.forEach((error) => {
        errors.push(`item_${index + 1}: ${error}`);
      });
    }

    if (result.warnings.length > 0) {
      warnings.push(...result.warnings.map((warning) => `item_${index + 1}: ${warning}`));
    }

    if (result.requiresConfirmation) {
      requiresConfirmation = true;
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    requiresConfirmation,
    items: normalizedItems,
  };
};

module.exports = {
  ALLOWED_INVENTORY_UNITS,
  DEFAULT_MAX_QUANTITY_WITHOUT_CONFIRMATION,
  validateInventoryItem,
  validateInventoryItems,
};
