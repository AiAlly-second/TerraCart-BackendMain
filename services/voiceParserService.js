const inventoryDictionary = require("../data/inventoryDictionary.json");
const { normalizeVoiceText } = require("../utils/normalizeVoiceText");
const { normalizeNumberWords } = require("../utils/numberNormalizer");
const { normalizeUnitWords } = require("../utils/unitNormalizer");
const { detectVoiceLanguage } = require("../utils/languageDetector");
const {
  validateInventoryItems,
  ALLOWED_INVENTORY_UNITS,
} = require("../utils/inventoryValidator");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";

const INVENTORY_ACTIONS = Object.freeze({
  ADD: "add",
  DEDUCT: "deduct",
  SET: "set",
  DELETE: "delete",
});

const QUANTITY_TOKEN_REGEX = /^\d+(?:\.\d+)?$/u;

const NAME_CONNECTOR_TOKENS = new Set([
  "and",
  "of",
  "the",
  "a",
  "an",
  "to",
  "ka",
  "ki",
  "ke",
  "ko",
]);

const NAME_SKIP_TOKENS = new Set([
  ...NAME_CONNECTOR_TOKENS,
  "add",
  "added",
  "increase",
  "plus",
  "restock",
  "purchase",
  "buy",
  "receive",
  "refill",
  "deduct",
  "deduce",
  "subtract",
  "minus",
  "remove",
  "reduce",
  "consume",
  "decrease",
  "khatam",
  "finish",
  "finished",
  "kar",
  "karo",
  "kare",
  "ho",
  "hogaya",
  "gaya",
  "gai",
  "gayi",
  "gya",
  "gyi",
  "zala",
  "zali",
  "jhala",
  "jhali",
  "sampala",
  "sampali",
  "sampla",
  "sampli",
  "hai",
  "aahe",
  "set",
  "update",
  "change",
  "replace",
  "delete",
  "deactivate",
  "disable",
  "discard",
  "inventory",
  "stock",
  "item",
  "items",
  "please",
  "give",
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "pack",
  "box",
  "bottle",
  "dozen",
  "\u0915\u092e",
  "\u0915\u092e\u0940",
  "\u0918\u091f\u093e",
  "\u0918\u091f\u093e\u0913",
  "\u0935\u091c\u093e",
  "\u0916\u0924\u092e",
  "\u0916\u0924\u094d\u092e",
  "\u0939\u094b",
  "\u0917\u092f\u093e",
  "\u0917\u0908",
  "\u0939\u0948",
  "\u0906\u0939\u0947",
  "\u0915\u0930",
]);

const DELETE_ACTION_PHRASES = Object.freeze([
  "delete",
  "deactivate",
  "disable",
  "discard",
]);

const DEDUCT_ACTION_PHRASES = Object.freeze([
  "deduct",
  "deduce",
  "subtract",
  "minus",
  "reduce",
  "remove",
  "consume",
  "decrease",
  "less",
  "kam",
  "kami",
  "ghata",
  "ghatao",
  "ghata do",
  "khatam",
  "khatam ho gaya",
  "khatam ho gya",
  "khatam ho gai",
  "khatam ho gayi",
  "nikaal",
  "nikal",
  "kadh",
  "kadha",
  "vaja",
  "sampla",
  "sampala",
  "sampali",
  "\u0915\u092e",
  "\u0915\u092e\u0940",
  "\u0918\u091f\u093e",
  "\u0918\u091f\u093e\u0913",
  "\u0935\u091c\u093e",
  "\u0916\u0924\u092e",
  "\u0916\u0924\u094d\u092e",
  "\u0915\u093e\u0922",
]);

const SET_ACTION_PHRASES = Object.freeze([
  "set",
  "update",
  "change",
  "replace",
  "equal",
  "set to",
  "make it",
]);

const ADD_ACTION_PHRASES = Object.freeze([
  "add",
  "increase",
  "plus",
  "restock",
  "purchase",
  "buy",
  "receive",
  "refill",
  "top up",
  "jod",
  "jodo",
  "joda",
  "vadh",
  "badha",
  "\u0935\u093e\u0922",
  "\u091c\u094b\u0921",
  "\u091c\u094b\u095c",
  "\u0916\u0930\u0940\u0926\u0940",
]);

const CATEGORY_KEY_TO_SCHEMA = Object.freeze({
  vegetable: "Vegetables",
  dairy: "Dairy",
  meat_poultry: "Meat & Poultry",
  grains_staples: "Grains & Staples",
  spices_seasoning: "Spices & Seasoning",
  oils_ghee: "Cooking Oils & Ghee",
  bread_buns_rotis: "Bread, Buns & Rotis",
  snacks_ingredients: "Snacks Ingredients",
  packaged_items: "Packaged Items",
  beverages: "Beverages",
  tissue_paper: "Tissue & Paper Products",
  packaging_materials: "Packaging Materials",
  disposable_items: "Disposable Items",
  cleaning_supplies: "Cleaning Supplies",
  safety_hygiene: "Safety & Hygiene",
  gas_fuel: "Gas & Fuel",
  prepared_items: "Prepared Items",
  premixes: "Pre-mixes",
  other: "Other",
});

const CATEGORY_ALIAS_TO_KEY = Object.freeze({
  vegetable: "vegetable",
  vegetables: "vegetable",
  veg: "vegetable",
  dairy: "dairy",
  milk: "dairy",
  beverage: "beverages",
  beverages: "beverages",
  drink: "beverages",
  drinks: "beverages",
  other: "other",
});

const logVoiceStage = (stage, payload) => {
  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    console.log(`[VOICE_PIPELINE] ${stage}: ${serialized}`);
  } catch (_error) {
    console.log(`[VOICE_PIPELINE] ${stage}: [unserializable payload]`);
  }
};

const parseJsonSafely = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch (_error) {
    const objectMatch = value.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_innerError) {
      return null;
    }
  }
};

const normalizeDictionaryKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const NORMALIZED_INVENTORY_DICTIONARY = Object.freeze(
  Object.entries(inventoryDictionary).reduce((acc, [key, canonical]) => {
    const normalizedKey = normalizeDictionaryKey(key);
    if (normalizedKey) {
      acc[normalizedKey] = canonical;
    }
    return acc;
  }, {}),
);

const escapeRegExp = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toTitleCase = (value) =>
  String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");

const detectLanguage = (value) => detectVoiceLanguage(value);

const containsPhrase = (normalizedText, phrase) => {
  const normalizedPhrase = normalizeDictionaryKey(phrase);
  if (!normalizedPhrase) return false;

  const paddedText = ` ${normalizedText} `;
  const paddedPhrase = ` ${normalizedPhrase} `;
  return paddedText.includes(paddedPhrase);
};

const containsAnyPhrase = (normalizedText, phrases) =>
  phrases.some((phrase) => containsPhrase(normalizedText, phrase));

const normalizeDetectedAction = (value) => {
  const normalized = normalizeDictionaryKey(value).replace(/\s+/g, " ");
  if (!normalized) return "";

  if (normalized === INVENTORY_ACTIONS.ADD) return INVENTORY_ACTIONS.ADD;
  if (normalized === INVENTORY_ACTIONS.DEDUCT) return INVENTORY_ACTIONS.DEDUCT;
  if (normalized === INVENTORY_ACTIONS.SET) return INVENTORY_ACTIONS.SET;
  if (normalized === INVENTORY_ACTIONS.DELETE) return INVENTORY_ACTIONS.DELETE;

  if (containsAnyPhrase(normalized, DELETE_ACTION_PHRASES)) {
    return INVENTORY_ACTIONS.DELETE;
  }
  if (containsAnyPhrase(normalized, DEDUCT_ACTION_PHRASES)) {
    return INVENTORY_ACTIONS.DEDUCT;
  }
  if (containsAnyPhrase(normalized, SET_ACTION_PHRASES)) {
    return INVENTORY_ACTIONS.SET;
  }
  if (containsAnyPhrase(normalized, ADD_ACTION_PHRASES)) {
    return INVENTORY_ACTIONS.ADD;
  }

  return "";
};

const detectInventoryAction = (rawText) => {
  const normalizedRaw = normalizeVoiceText(rawText, {
    removeFillerWords: false,
  });
  const detected = normalizeDetectedAction(normalizedRaw);
  if (detected) return detected;
  return INVENTORY_ACTIONS.ADD;
};

const normalizeCategoryKey = (value) => {
  const normalized = normalizeDictionaryKey(value).replace(/\s+/g, "_");
  if (!normalized) return "other";
  if (CATEGORY_KEY_TO_SCHEMA[normalized]) return normalized;
  if (CATEGORY_ALIAS_TO_KEY[normalized]) return CATEGORY_ALIAS_TO_KEY[normalized];
  return "other";
};

const toSchemaCategory = (categoryKey) =>
  CATEGORY_KEY_TO_SCHEMA[normalizeCategoryKey(categoryKey)] || "Other";

const toBaseUnit = (uom) => {
  if (uom === "kg" || uom === "g") return "g";
  if (uom === "l" || uom === "ml") return "ml";
  return "pcs";
};

const convertToBaseQty = (quantity, unit) => {
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity)) return 0;

  if (unit === "kg") return numericQuantity * 1000;
  if (unit === "g") return numericQuantity;
  if (unit === "l") return numericQuantity * 1000;
  if (unit === "ml") return numericQuantity;
  return numericQuantity;
};

const sanitizeQuantity = (value) => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return 1;
  return Math.round(quantity * 1000) / 1000;
};

const sanitizeUnit = (value) => {
  const normalized = normalizeUnitWords(String(value || "").toLowerCase())
    .split(" ")
    .filter(Boolean)[0];
  if (!normalized) return "pcs";
  if (ALLOWED_INVENTORY_UNITS.includes(normalized)) return normalized;
  return "pcs";
};

const inferCategory = (canonicalName) => {
  const normalizedName = normalizeDictionaryKey(canonicalName);
  if (normalizedName === "milk") return "dairy";
  if (normalizedName === "tea" || normalizedName === "coffee") return "beverages";
  if (["onion", "potato", "tomato", "garlic", "ginger"].includes(normalizedName)) {
    return "vegetable";
  }
  return "other";
};

const mapCanonicalName = (value) => {
  const normalized = normalizeDictionaryKey(value);
  if (!normalized) return "";

  const dictionaryHit = NORMALIZED_INVENTORY_DICTIONARY[normalized];
  if (dictionaryHit) return dictionaryHit;

  const firstToken = normalized.split(" ")[0];
  const firstTokenHit = NORMALIZED_INVENTORY_DICTIONARY[firstToken];
  if (firstTokenHit) return firstTokenHit;

  return toTitleCase(value);
};

const mapInventoryTerms = (value) => {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";

  // First map multi-word aliases, then per-token aliases.
  const phraseMapped = Object.entries(NORMALIZED_INVENTORY_DICTIONARY)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((output, [alias, canonical]) => {
      const normalizedAlias = normalizeDictionaryKey(alias);
      if (!normalizedAlias.includes(" ")) return output;
      const pattern = new RegExp(
        `\\b${escapeRegExp(normalizedAlias).replace(/\s+/g, "\\s+")}\\b`,
        "gu",
      );
      return output.replace(
        pattern,
        normalizeVoiceText(canonical, { removeFillerWords: false }),
      );
    }, compact);

  return phraseMapped
    .split(" ")
    .map((token) => {
      const canonical =
        NORMALIZED_INVENTORY_DICTIONARY[normalizeDictionaryKey(token)];
      if (!canonical) return token;
      return normalizeVoiceText(canonical, { removeFillerWords: false });
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
};

const preprocessVoiceText = (value, options = {}) => {
  const rawText = String(value || "").trim();
  const normalizedText = normalizeVoiceText(rawText, {
    removeFillerWords: options.removeFillerWords !== false,
  });
  const numberNormalizedText = normalizeNumberWords(normalizedText);
  const unitNormalizedText = normalizeUnitWords(numberNormalizedText);
  const dictionaryMappedText =
    options.applyDictionary === false
      ? unitNormalizedText
      : mapInventoryTerms(unitNormalizedText);

  return {
    rawText,
    normalizedText,
    numberNormalizedText,
    unitNormalizedText,
    dictionaryMappedText,
    finalText: dictionaryMappedText,
  };
};

const buildParsedItem = ({
  name,
  quantity,
  unit,
  category,
  sourceText,
  language,
  action,
}) => {
  const canonicalName = mapCanonicalName(name || sourceText);
  const normalizedCategory = normalizeCategoryKey(category || inferCategory(canonicalName));
  const normalizedUnit = sanitizeUnit(unit);
  const normalizedQuantity = sanitizeQuantity(quantity);
  const normalizedAction = normalizeDetectedAction(action) || INVENTORY_ACTIONS.ADD;

  return {
    name: canonicalName || "Unknown Item",
    quantity: normalizedQuantity,
    unit: normalizedUnit,
    category: normalizedCategory,
    originalText: String(sourceText || "").trim() || canonicalName || "",
    language: language || detectLanguage(sourceText || canonicalName),
    action: normalizedAction,
  };
};

const parseInventoryWithRegex = (normalizedText, language, action) => {
  const text = String(normalizedText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];

  const tokens = text.split(" ").filter(Boolean);
  if (!tokens.length) return [];

  const parsedItems = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const quantityToken = tokens[index];
    if (!QUANTITY_TOKEN_REGEX.test(quantityToken)) {
      continue;
    }

    let pointer = index + 1;
    let unitToken = "";
    if (
      pointer < tokens.length &&
      ALLOWED_INVENTORY_UNITS.includes(tokens[pointer])
    ) {
      unitToken = tokens[pointer];
      pointer += 1;
    }

    while (pointer < tokens.length && NAME_CONNECTOR_TOKENS.has(tokens[pointer])) {
      pointer += 1;
    }

    const nameTokens = [];
    while (pointer < tokens.length && !QUANTITY_TOKEN_REGEX.test(tokens[pointer])) {
      const token = tokens[pointer];
      if (ALLOWED_INVENTORY_UNITS.includes(token)) {
        if (!unitToken) {
          unitToken = token;
        }
        pointer += 1;
        continue;
      }
      if (!NAME_SKIP_TOKENS.has(token)) {
        nameTokens.push(token);
      }
      pointer += 1;
    }

    if (nameTokens.length === 0) {
      const backwardTokens = [];
      let backPointer = index - 1;
      while (backPointer >= 0 && !QUANTITY_TOKEN_REGEX.test(tokens[backPointer])) {
        const token = tokens[backPointer];
        if (NAME_SKIP_TOKENS.has(token)) {
          if (backwardTokens.length > 0) break;
          backPointer -= 1;
          continue;
        }
        backwardTokens.unshift(token);
        backPointer -= 1;
      }
      nameTokens.push(...backwardTokens);
    }

    if (nameTokens.length > 0) {
      const sourceText = [quantityToken, unitToken, ...nameTokens]
        .filter(Boolean)
        .join(" ");

      parsedItems.push(
        buildParsedItem({
          name: nameTokens.join(" "),
          quantity: quantityToken,
          unit: unitToken,
          sourceText,
          language,
          action,
        }),
      );
    }

    // Continue parsing from the next unseen quantity token.
    index = pointer - 1;
  }

  return parsedItems;
};

const parseDeleteItemWithoutQuantity = (normalizedText, language, action) => {
  if (action !== INVENTORY_ACTIONS.DELETE) return [];
  const text = String(normalizedText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];

  const nameTokens = text
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) =>
        !QUANTITY_TOKEN_REGEX.test(token) &&
        !ALLOWED_INVENTORY_UNITS.includes(token) &&
        !NAME_SKIP_TOKENS.has(token),
    );

  if (nameTokens.length === 0) return [];

  return [
    buildParsedItem({
      name: nameTokens.join(" "),
      quantity: 1,
      unit: "pcs",
      sourceText: nameTokens.join(" "),
      language,
      action,
    }),
  ];
};

const callAiInventoryFallback = async ({ rawText, normalizedText }) => {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured");
    error.statusCode = 503;
    throw error;
  }

  const systemPrompt = [
    "You are an inventory parser.",
    "Extract:",
    "action",
    "name",
    "quantity",
    "unit",
    "category",
    "Rules:",
    "- action must be one of: add, deduct, set, delete",
    "- quantity must remain unchanged",
    "- if quantity missing assume 1",
    "- units allowed: kg g l ml pcs pack box bottle dozen",
    "- never guess large numbers",
    "- if multiple items are present, return them in items[]",
    "Return JSON only.",
  ].join("\n");

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            text: rawText,
            normalizedText,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(
      `OpenAI inventory fallback failed (${response.status}): ${details.slice(0, 300)}`,
    );
    error.statusCode = 502;
    throw error;
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonSafely(rawContent);
  if (!parsed || typeof parsed !== "object") {
    const error = new Error("OpenAI inventory fallback returned invalid JSON");
    error.statusCode = 502;
    throw error;
  }

  return parsed;
};

const normalizeAiParsedItems = (aiPayload, language, fallbackAction) => {
  let candidates = [];
  if (Array.isArray(aiPayload)) {
    candidates = aiPayload;
  } else if (Array.isArray(aiPayload?.items)) {
    candidates = aiPayload.items;
  } else if (aiPayload && typeof aiPayload === "object") {
    candidates = [aiPayload];
  }

  const payloadAction = normalizeDetectedAction(aiPayload?.action) || fallbackAction;

  return candidates
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) =>
      buildParsedItem({
        name: entry.name,
        quantity: entry.quantity,
        unit: entry.unit,
        category: entry.category,
        sourceText: `${entry.quantity || ""} ${entry.unit || ""} ${entry.name || ""}`.trim(),
        language,
        action: normalizeDetectedAction(entry.action) || payloadAction,
      }),
    )
    .filter((entry) => entry.name && entry.quantity > 0);
};

const parseVoiceInventory = async (value) => {
  const rawText = String(value || "").trim();
  if (!rawText) {
    const error = new Error("text is required");
    error.statusCode = 400;
    throw error;
  }

  const language = detectLanguage(rawText);
  const detectedAction = detectInventoryAction(rawText);
  const preprocessed = preprocessVoiceText(rawText, {
    applyDictionary: true,
    removeFillerWords: true,
  });

  logVoiceStage("raw voice text", rawText);
  logVoiceStage("normalized text", preprocessed.finalText);

  let parser = "regex";
  let aiFallbackUsed = false;
  let items = parseInventoryWithRegex(
    preprocessed.finalText,
    language,
    detectedAction,
  );

  if (items.length === 0) {
    items = parseDeleteItemWithoutQuantity(
      preprocessed.finalText,
      language,
      detectedAction,
    );
  }

  if (items.length === 0) {
    parser = "ai";
    aiFallbackUsed = true;
    const aiPayload = await callAiInventoryFallback({
      rawText,
      normalizedText: preprocessed.finalText,
    });
    items = normalizeAiParsedItems(aiPayload, language, detectedAction);
  }

  if (items.length === 0) {
    const error = new Error("Unable to parse inventory voice text");
    error.statusCode = 422;
    throw error;
  }

  const validation = validateInventoryItems(items);

  logVoiceStage("parsed output", {
    parser,
    items,
    validation: {
      isValid: validation.isValid,
      requiresConfirmation: validation.requiresConfirmation,
    },
  });
  logVoiceStage("ai fallback usage", {
    aiFallbackUsed,
  });

  return {
    originalText: rawText,
    rawText,
    normalizedText: preprocessed.finalText,
    preprocessed,
    parser,
    aiFallbackUsed,
    language,
    action: detectedAction,
    items,
    validation,
  };
};

module.exports = {
  OPENAI_MODEL,
  INVENTORY_ACTIONS,
  CATEGORY_KEY_TO_SCHEMA,
  preprocessVoiceText,
  parseVoiceInventory,
  detectInventoryAction,
  normalizeDetectedAction,
  toSchemaCategory,
  toBaseUnit,
  convertToBaseQty,
};
