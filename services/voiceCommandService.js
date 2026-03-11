const { preprocessVoiceText } = require("./voiceParserService");
const { detectVoiceLanguage } = require("../utils/languageDetector");
const {
  generateVoiceResponse,
  getTtsLocaleForLanguage,
} = require("./voiceResponseService");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";

const INTENTS = Object.freeze({
  NAV_DASHBOARD: "NAV_DASHBOARD",
  NAV_INVENTORY: "NAV_INVENTORY",
  NAV_ORDERS: "NAV_ORDERS",
  NAV_TABLES: "NAV_TABLES",
  NAV_REQUESTS: "NAV_REQUESTS",
  NAV_SETTINGS: "NAV_SETTINGS",
  NAV_BILLING: "NAV_BILLING",
  NAV_KOT: "NAV_KOT",
  NAV_EMPLOYEES: "NAV_EMPLOYEES",
  NAV_BACK: "NAV_BACK",
  NAV_ADD_ITEM: "NAV_ADD_ITEM",
  UNKNOWN: "UNKNOWN",
});

const INTENT_KEYWORDS = Object.freeze({
  [INTENTS.NAV_DASHBOARD]: [
    "dashboard",
    "home",
    "main screen",
    "overview",
    "डैशबोर्ड",
  ],
  [INTENTS.NAV_INVENTORY]: [
    "inventory",
    "stock",
    "ingredient",
    "ingredients",
    "restock",
    "इन्वेंटरी",
    "स्टॉक",
    "साठा",
  ],
  [INTENTS.NAV_ORDERS]: [
    "order",
    "orders",
    "new order",
    "cart",
    "takeaway",
    "ऑर्डर",
    "ऑर्डर्स",
  ],
  [INTENTS.NAV_TABLES]: [
    "table",
    "tables",
    "dine in",
    "seat",
  ],
  [INTENTS.NAV_REQUESTS]: [
    "request",
    "requests",
    "customer request",
    "help desk",
    "support",
  ],
  [INTENTS.NAV_SETTINGS]: [
    "settings",
    "setting",
    "preferences",
    "configuration",
    "सेटिंग",
    "सेटिंग्स",
    "सेटिंग्ज",
  ],
  [INTENTS.NAV_BILLING]: [
    "billing",
    "payment",
    "payments",
    "bill",
    "invoice",
    "बिलिंग",
    "पेमेंट",
    "भुगतान",
  ],
  [INTENTS.NAV_KOT]: [
    "kot",
    "kitchen",
    "kitchen order ticket",
    "kitchen queue",
  ],
  [INTENTS.NAV_EMPLOYEES]: [
    "employee",
    "employees",
    "staff",
    "attendance",
  ],
  [INTENTS.NAV_BACK]: [
    "go back",
    "back",
    "previous",
    "last page",
    "वापस",
    "मागे",
  ],
  [INTENTS.NAV_ADD_ITEM]: [
    "add item",
    "new item",
    "create item",
    "add inventory item",
  ],
});

const INTENT_TO_RESPONSE_KEY = Object.freeze({
  [INTENTS.NAV_DASHBOARD]: "nav_dashboard",
  [INTENTS.NAV_INVENTORY]: "nav_inventory",
  [INTENTS.NAV_ORDERS]: "nav_orders",
  [INTENTS.NAV_TABLES]: "nav_tables",
  [INTENTS.NAV_REQUESTS]: "nav_requests",
  [INTENTS.NAV_SETTINGS]: "nav_settings",
  [INTENTS.NAV_BILLING]: "nav_billing",
  [INTENTS.NAV_KOT]: "nav_kot",
  [INTENTS.NAV_EMPLOYEES]: "nav_employees",
  [INTENTS.NAV_BACK]: "nav_back",
  [INTENTS.NAV_ADD_ITEM]: "nav_add_item",
  [INTENTS.UNKNOWN]: "command_not_recognized",
});

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

const containsKeyword = (text, keyword) => {
  const wrappedText = ` ${text} `;
  const wrappedKeyword = ` ${keyword} `;
  return wrappedText.includes(wrappedKeyword);
};

const detectKeywordIntent = (normalizedText) => {
  const inventoryQuantityPattern =
    /\b\d+(?:\.\d+)?\s*(kg|kilo|kilogram|g|gram|l|liter|litre|ml|pcs|piece|stock|inventory)\b/i;
  if (inventoryQuantityPattern.test(normalizedText)) {
    return {
      intent: INTENTS.NAV_INVENTORY,
      confidence: "high",
    };
  }

  const orderQuantityPattern =
    /\b\d+(?:\.\d+)?\b.*\b(order|cart|item|items|tea|coffee|chai|food)\b/i;
  if (orderQuantityPattern.test(normalizedText)) {
    return {
      intent: INTENTS.NAV_ORDERS,
      confidence: "high",
    };
  }

  let bestIntent = null;
  let bestScore = 0;

  Object.entries(INTENT_KEYWORDS).forEach(([intent, keywords]) => {
    const score = keywords.reduce((count, keyword) => {
      if (containsKeyword(normalizedText, keyword)) return count + 1;
      return count;
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  });

  if (!bestIntent || bestScore <= 0) return null;

  return {
    intent: bestIntent,
    confidence: bestScore > 1 ? "high" : "medium",
  };
};

const callAiIntentFallback = async ({ text, normalizedText, role }) => {
  if (!process.env.OPENAI_API_KEY) {
    return { intent: INTENTS.UNKNOWN, confidence: "low" };
  }

  const systemPrompt = [
    "You are a POS app voice navigation intent classifier.",
    "Classify the command into one intent from this list only:",
    Object.values(INTENTS).join(", "),
    "Rules:",
    "- Prefer navigation intents over action details.",
    "- Use NAV_BILLING for payment/invoice/billing screens.",
    "- Use NAV_ADD_ITEM for create/add inventory item requests.",
    "- Use UNKNOWN if intent is unclear.",
    "Return JSON only with keys: intent, confidence.",
  ].join(" ");

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
            text,
            normalizedText,
            role,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `OpenAI command intent fallback failed (${response.status}): ${details.slice(0, 300)}`,
    );
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonSafely(rawContent);
  if (!parsed || typeof parsed !== "object") {
    return { intent: INTENTS.UNKNOWN, confidence: "low" };
  }

  const rawIntent = String(parsed.intent || "")
    .trim()
    .toUpperCase();
  const confidence = String(parsed.confidence || "low")
    .trim()
    .toLowerCase();

  return {
    intent: Object.values(INTENTS).includes(rawIntent) ? rawIntent : INTENTS.UNKNOWN,
    confidence: ["high", "medium", "low"].includes(confidence)
      ? confidence
      : "low",
  };
};

const parseVoiceCommandIntent = async ({ text, role = "manager" }) => {
  const rawText = String(text || "").trim();
  if (!rawText) {
    const error = new Error("text is required");
    error.statusCode = 400;
    throw error;
  }
  const language = detectVoiceLanguage(rawText);

  const preprocessed = preprocessVoiceText(rawText, {
    removeFillerWords: false,
    applyDictionary: false,
  });

  console.log(`[VOICE_COMMAND] raw voice text: ${rawText}`);
  console.log(`[VOICE_COMMAND] normalized text: ${preprocessed.finalText}`);

  const keywordResult = detectKeywordIntent(preprocessed.finalText);
  if (keywordResult) {
    const assistantReply = generateVoiceResponse({
      action: INTENT_TO_RESPONSE_KEY[keywordResult.intent] || "command_not_recognized",
      language,
      text: rawText,
    }).text;
    console.log(
      `[VOICE_COMMAND] parsed output: ${JSON.stringify({
        intent: keywordResult.intent,
        source: "keyword",
      })}`,
    );
    console.log("[VOICE_COMMAND] ai fallback usage: false");
    return {
      intent: keywordResult.intent,
      confidence: keywordResult.confidence,
      source: "keyword",
      aiFallbackUsed: false,
      language,
      ttsLocale: getTtsLocaleForLanguage(language),
      originalText: rawText,
      normalizedText: preprocessed.finalText,
      parsedCommand: {
        intent: keywordResult.intent,
      },
      assistantReply,
      rawText,
    };
  }

  let aiResult = { intent: INTENTS.UNKNOWN, confidence: "low" };
  try {
    aiResult = await callAiIntentFallback({
      text: rawText,
      normalizedText: preprocessed.finalText,
      role,
    });
  } catch (error) {
    console.error("[VOICE_COMMAND] AI fallback failed:", error.message);
  }

  console.log(
    `[VOICE_COMMAND] parsed output: ${JSON.stringify({
      intent: aiResult.intent,
      source: aiResult.intent === INTENTS.UNKNOWN ? "fallback" : "ai",
    })}`,
  );
  console.log("[VOICE_COMMAND] ai fallback usage: true");

  const assistantReply = generateVoiceResponse({
    action: INTENT_TO_RESPONSE_KEY[aiResult.intent] || "command_not_recognized",
    language,
    text: rawText,
  }).text;

  return {
    intent: aiResult.intent,
    confidence: aiResult.confidence,
    source: aiResult.intent === INTENTS.UNKNOWN ? "fallback" : "ai",
    aiFallbackUsed: true,
    language,
    ttsLocale: getTtsLocaleForLanguage(language),
    originalText: rawText,
    normalizedText: preprocessed.finalText,
    parsedCommand: {
      intent: aiResult.intent,
    },
    assistantReply,
    rawText,
  };
};

module.exports = {
  INTENTS,
  parseVoiceCommandIntent,
};
