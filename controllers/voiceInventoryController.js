const Ingredient = require("../models/costing-v2/ingredientModel");
const {
  parseInventoryText,
  validateDetectedInventory,
  toIngredientCreatePayload,
} = require("../services/aiInventoryService");
const {
  generateVoiceResponse,
  combineVoiceResponses,
  getTtsLocaleForLanguage,
} = require("../services/voiceResponseService");
const { setOutletContext } = require("../utils/costing-v2/accessControl");

const inventoryResponseKey = (action) => {
  const normalized = String(action || "").trim().toLowerCase();
  if (normalized === "deduct") return "inventory_deducted";
  if (normalized === "set") return "inventory_set";
  if (normalized === "delete") return "inventory_deleted";
  return "inventory_added";
};

const toDetectedItems = (detected, fallbackLanguage = "en") => {
  const items = Array.isArray(detected?.items) && detected.items.length
    ? detected.items
    : [detected].filter(Boolean);

  return items.map((item) => {
    const language = String(item.language || fallbackLanguage || "en")
      .trim()
      .toLowerCase();
    const assistantReply = generateVoiceResponse({
      action: inventoryResponseKey(item.action),
      language,
      qty: item.quantity,
      item: item.name,
    }).text;

    return {
      language,
      action: item.action,
      name: item.name,
      originalText: item.originalText,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      schemaCategory: item.schemaCategory,
      assistantReply,
    };
  });
};

exports.parseVoiceInventory = async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({
        success: false,
        message: "text is required",
      });
    }

    const detected = await parseInventoryText(text);
    const validation = validateDetectedInventory(detected);

    if (!validation.isValid) {
      return res.status(422).json({
        success: false,
        message: "Detected inventory is invalid",
        errors: validation.errors,
        warnings: validation.warnings,
        requiresConfirmation: validation.requiresConfirmation,
        detected,
      });
    }

    const detectedItems = toDetectedItems(detected, detected.language);
    const primary = detectedItems[0];
    const assistantReply = combineVoiceResponses({
      responses: detectedItems.map((item) => item.assistantReply),
      language: primary.language,
      separator: " ",
      maxParts: 2,
    }).text;

    return res.json({
      success: true,
      originalText: text,
      language: primary.language,
      ttsLocale: getTtsLocaleForLanguage(primary.language),
      parsedCommand: {
        action: primary.action,
        items: detectedItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        })),
      },
      detected: {
        language: primary.language,
        action: primary.action,
        name: primary.name,
        originalText: primary.originalText,
        quantity: primary.quantity,
        unit: primary.unit,
        category: primary.category,
        assistantReply: primary.assistantReply,
      },
      action: primary.action,
      assistantReply,
      items: detectedItems,
      warnings: validation.warnings,
      requiresConfirmation: validation.requiresConfirmation,
      aiFallbackUsed: detected.aiFallbackUsed === true,
      parser: detected.parser || "regex",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to parse voice inventory text",
    });
  }
};

exports.createVoiceInventory = async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({
        success: false,
        message: "text is required",
      });
    }

    const detected = await parseInventoryText(text);
    const validation = validateDetectedInventory(detected);
    if (!validation.isValid) {
      return res.status(422).json({
        success: false,
        message: "Detected inventory is invalid",
        errors: validation.errors,
        warnings: validation.warnings,
        requiresConfirmation: validation.requiresConfirmation,
        detected,
      });
    }

    if (
      validation.requiresConfirmation &&
      req.body?.confirmLargeQuantity !== true
    ) {
      return res.status(409).json({
        success: false,
        message: "Large quantity detected. Please confirm to continue.",
        requiresConfirmation: true,
        warnings: validation.warnings,
        detected,
      });
    }

    const detectedItems = toDetectedItems(detected, detected.language);
    const primaryDetected = detectedItems[0];
    const assistantReply = combineVoiceResponses({
      responses: detectedItems.map((item) => item.assistantReply),
      language: primaryDetected.language,
      separator: " ",
      maxParts: 2,
    }).text;

    // Build schema-compatible payload with required defaults.
    const basePayload = toIngredientCreatePayload({
      detected: primaryDetected,
      cartId: req.body?.cartId,
    });

    // Apply role-aware cart/franchise context (shared for super admin by default).
    const ingredientData = await setOutletContext(req.user, basePayload, false);

    const ingredient = new Ingredient(ingredientData);
    await ingredient.save();

    return res.status(201).json({
      success: true,
      originalText: text,
      language: primaryDetected.language,
      ttsLocale: getTtsLocaleForLanguage(primaryDetected.language),
      parsedCommand: {
        action: primaryDetected.action,
        items: detectedItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        })),
      },
      detected: {
        language: primaryDetected.language,
        action: primaryDetected.action,
        name: primaryDetected.name,
        quantity: primaryDetected.quantity,
        unit: primaryDetected.unit,
        category: primaryDetected.category,
        assistantReply: primaryDetected.assistantReply,
      },
      action: primaryDetected.action,
      assistantReply,
      items: detectedItems,
      warnings: validation.warnings,
      multipleDetected: detectedItems.length > 1,
      createdIngredient: ingredient,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Ingredient already exists",
      });
    }

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to create ingredient from voice text",
    });
  }
};
