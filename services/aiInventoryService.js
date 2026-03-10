const Ingredient = require("../models/costing-v2/ingredientModel");
const {
  parseVoiceInventory,
  INVENTORY_ACTIONS,
  normalizeDetectedAction,
  toSchemaCategory,
  toBaseUnit,
  convertToBaseQty,
} = require("./voiceParserService");
const { validateInventoryItems } = require("../utils/inventoryValidator");

const ALLOWED_UOMS = Ingredient.schema.path("uom").enumValues || [];
const ALLOWED_SCHEMA_CATEGORIES =
  Ingredient.schema.path("category").enumValues || [];

const sanitizeQuantity = (value, fallback = 1) => {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty <= 0) return fallback;
  return Math.round(qty * 1000) / 1000;
};

const normalizeDetectedItem = (
  item = {},
  fallbackLanguage = "en",
  fallbackAction = INVENTORY_ACTIONS.ADD,
) => {
  const unitCandidate = String(item.unit || "pcs")
    .trim()
    .toLowerCase();
  const unit = ALLOWED_UOMS.includes(unitCandidate) ? unitCandidate : "pcs";
  const quantity = sanitizeQuantity(item.quantity, 1);
  const categoryKey = String(item.category || "other")
    .trim()
    .toLowerCase();
  const schemaCategory = toSchemaCategory(categoryKey);
  const action = normalizeDetectedAction(item.action) || fallbackAction;

  return {
    language: String(item.language || fallbackLanguage || "en")
      .trim()
      .toLowerCase(),
    action,
    name: String(item.name || "").trim() || "Unknown Ingredient",
    originalText:
      String(item.originalText || item.name || "").trim() ||
      "Unknown Ingredient",
    quantity,
    unit,
    category: categoryKey || "other",
    schemaCategory,
    baseUnit: toBaseUnit(unit),
    qtyInBaseUnit: convertToBaseQty(quantity, unit),
  };
};

const parseInventoryText = async (text) => {
  const parsed = await parseVoiceInventory(text);
  const fallbackAction =
    normalizeDetectedAction(parsed.action) || INVENTORY_ACTIONS.ADD;

  const normalizedItems = (parsed.items || []).map((item) =>
    normalizeDetectedItem(item, parsed.language, fallbackAction),
  );

  if (!normalizedItems.length) {
    const error = new Error("Unable to parse inventory voice text");
    error.statusCode = 422;
    throw error;
  }

  const primary = {
    ...normalizedItems[0],
    action: fallbackAction,
    items: normalizedItems,
    aiFallbackUsed: parsed.aiFallbackUsed,
    parser: parsed.parser,
    rawText: parsed.rawText,
    normalizedText: parsed.normalizedText,
    validation: parsed.validation,
  };

  return primary;
};

const validateDetectedInventory = (detected) => {
  const items = Array.isArray(detected?.items) && detected.items.length
    ? detected.items
    : [detected].filter(Boolean);

  const validation = validateInventoryItems(items);
  const schemaErrors = [];

  items.forEach((item, index) => {
    const schemaCategory = String(item?.schemaCategory || "").trim();
    if (!ALLOWED_SCHEMA_CATEGORIES.includes(schemaCategory)) {
      schemaErrors.push(
        `item_${index + 1}: category must map to one of: ${ALLOWED_SCHEMA_CATEGORIES.join(", ")}`,
      );
    }
  });

  const errors = [...validation.errors, ...schemaErrors];

  return {
    isValid: errors.length === 0,
    errors,
    warnings: validation.warnings,
    requiresConfirmation: validation.requiresConfirmation,
  };
};

const toIngredientCreatePayload = ({ detected, cartId = null } = {}) => {
  const unit = String(detected?.unit || "pcs")
    .trim()
    .toLowerCase();
  const schemaUnit = ALLOWED_UOMS.includes(unit) ? unit : "pcs";

  const payload = {
    name: String(detected?.name || "").trim(),
    category: String(detected?.schemaCategory || "Other").trim(),
    uom: schemaUnit,
    baseUnit: toBaseUnit(schemaUnit),
    reorderLevel: 0,
    isActive: true,
    qtyOnHand: convertToBaseQty(detected?.quantity, schemaUnit),
  };

  if (cartId) {
    payload.cartId = cartId;
  }

  return payload;
};

module.exports = {
  ALLOWED_UOMS,
  ALLOWED_SCHEMA_CATEGORIES,
  parseInventoryText,
  validateDetectedInventory,
  toIngredientCreatePayload,
};
