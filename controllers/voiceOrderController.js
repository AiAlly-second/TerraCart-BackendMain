const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TRANSCRIPT_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || "whisper-1";
const MAX_MENU_ITEMS = 300;
const MAX_RESULT_ITEMS = 12;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const { preprocessVoiceText } = require("../services/voiceParserService");
const { detectVoiceLanguage } = require("../utils/languageDetector");
const {
  generateVoiceResponse,
  combineVoiceResponses,
  getTtsLocaleForLanguage,
} = require("../services/voiceResponseService");

const hasExplicitPlaceOrderIntent = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) return false;

  const phrases = [
    "place order",
    "confirm order",
    "checkout",
    "confirm",
    "submit order",
    "pay now",
    "order now",
  ];
  return phrases.some((phrase) => normalized.includes(phrase));
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeAction = (value) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (["ADD_ITEMS", "PLACE_ORDER", "SHOW_CART", "CLEAR_CART", "NONE"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "ADD") return "ADD_ITEMS";
  if (normalized === "CHECKOUT") return "PLACE_ORDER";
  if (normalized === "OPEN_CART") return "SHOW_CART";
  return "NONE";
};

const parseJsonSafely = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch (_error) {
    const jsonMatch = value.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_innerError) {
      return null;
    }
  }
};

const responseKeyFromOrderAction = (action) => {
  if (action === "CLEAR_CART") return "clear_cart";
  if (action === "SHOW_CART") return "show_cart";
  if (action === "PLACE_ORDER") return "place_order";
  return "command_not_recognized";
};

const buildLocalizedOrderReply = ({
  action,
  items,
  notFound,
  language,
}) => {
  const responseParts = [];
  const safeItems = Array.isArray(items) ? items : [];
  const safeNotFound = Array.isArray(notFound) ? notFound : [];

  if (action === "ADD_ITEMS") {
    if (safeItems.length > 0) {
      safeItems.forEach((entry) => {
        const itemName = String(entry?.name || "").trim();
        if (!itemName) return;
        const quantity = Number(entry?.quantity) || 1;
        const addedSingle = generateVoiceResponse({
          action: "add_to_cart",
          language,
          qty: quantity,
          item: itemName,
        }).text;
        if (addedSingle) responseParts.push(addedSingle);
      });
    }
  } else {
    const actionReply = generateVoiceResponse({
      action: responseKeyFromOrderAction(action),
      language,
    }).text;
    if (actionReply) responseParts.push(actionReply);
  }

  if (safeNotFound.length === 1) {
    const notFoundSingle = generateVoiceResponse({
      action: "item_not_found",
      language,
      item: safeNotFound[0],
    }).text;
    if (notFoundSingle) responseParts.push(notFoundSingle);
  } else if (safeNotFound.length > 1) {
    const notFoundMany = generateVoiceResponse({
      action: "some_items_not_found",
      language,
      count: safeNotFound.length,
    }).text;
    if (notFoundMany) responseParts.push(notFoundMany);
  }

  if (responseParts.length === 0) {
    const fallback = generateVoiceResponse({
      action: "command_not_recognized",
      language,
    }).text;
    if (fallback) responseParts.push(fallback);
  }

  return combineVoiceResponses({
    responses: responseParts,
    language,
    separator: " ",
    maxParts: 6,
  }).text;
};

const resolveWhisperLanguage = (locale = "") => {
  const normalized = String(locale || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("hi")) return "hi";
  if (normalized.startsWith("mr")) return "mr";
  if (normalized.startsWith("gu")) return "gu";
  if (normalized.startsWith("en")) return "en";
  return null;
};

exports.transcribeTapToOrderAudio = async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ message: "OPENAI_API_KEY is not configured" });
    }

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ message: "audio file is required" });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return res.status(413).json({ message: "audio file is too large" });
    }

    const mimeType = String(file.mimetype || "audio/webm");
    const fileName = String(file.originalname || "tap-to-order.webm");
    const locale = String(req.body?.locale || "en-IN").trim();
    const whisperLanguage = resolveWhisperLanguage(locale);

    const formData = new FormData();
    formData.append("model", OPENAI_WHISPER_MODEL);
    formData.append(
      "file",
      new Blob([file.buffer], { type: mimeType }),
      fileName,
    );
    if (whisperLanguage) {
      formData.append("language", whisperLanguage);
    }
    formData.append("response_format", "json");

    const openAiResponse = await fetch(OPENAI_TRANSCRIPT_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!openAiResponse.ok) {
      const details = await openAiResponse.text();
      console.error(
        `[VOICE_ORDER] Whisper transcription failed status=${openAiResponse.status} body=${details.slice(0, 400)}`,
      );
      return res.status(502).json({ message: "Failed to transcribe audio" });
    }

    const payload = await openAiResponse.json().catch(() => ({}));
    const transcript = String(payload?.text || "").trim();
    if (!transcript) {
      return res.status(502).json({ message: "No speech detected in audio" });
    }

    return res.json({ transcript });
  } catch (error) {
    console.error("[VOICE_ORDER] transcribeTapToOrderAudio error:", error);
    return res.status(500).json({ message: "Voice transcription failed" });
  }
};

exports.parseTapToOrderVoice = async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const locale = String(req.body?.locale || "en-IN").trim();
    const language = detectVoiceLanguage(transcript, { locale });
    const rawMenuItems = Array.isArray(req.body?.menuItems) ? req.body.menuItems : [];

    if (!transcript) {
      return res.status(400).json({ message: "transcript is required" });
    }
    if (!rawMenuItems.length) {
      return res.status(400).json({ message: "menuItems are required" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ message: "OPENAI_API_KEY is not configured" });
    }

    const preprocessedTranscript = preprocessVoiceText(transcript, {
      applyDictionary: false,
      removeFillerWords: true,
    });
    const normalizedTranscript =
      String(preprocessedTranscript.finalText || "").trim() || transcript;
    console.log(`[VOICE_ORDER] raw voice text: ${transcript}`);
    console.log(`[VOICE_ORDER] normalized text: ${normalizedTranscript}`);

    const menuItems = rawMenuItems
      .map((entry) =>
        typeof entry === "string" ? entry : String(entry?.name || "").trim(),
      )
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, MAX_MENU_ITEMS);

    if (!menuItems.length) {
      return res.status(400).json({ message: "menuItems are required" });
    }

    const menuLookup = new Map();
    menuItems.forEach((name) => {
      menuLookup.set(normalizeText(name), name);
    });

    const systemPrompt = [
      "You are a restaurant voice-order parser for a Tap to Order button.",
      "Return JSON only with keys: action, items, notFound, assistantReply.",
      "Allowed action values: ADD_ITEMS, PLACE_ORDER, SHOW_CART, CLEAR_CART, NONE.",
      "If user asks to place/confirm/checkout then action is PLACE_ORDER.",
      "If user asks to open/show cart then action is SHOW_CART.",
      "If user asks to clear/reset cart then action is CLEAR_CART.",
      "Otherwise action is ADD_ITEMS when food items are requested.",
      "items must contain objects: {\"name\": string, \"quantity\": integer >= 1}.",
      "Use only item names from the provided menu list. If uncertain, put item text in notFound.",
      "assistantReply must be short, polite, and easy to speak out loud.",
      "Do not include markdown.",
    ].join(" ");

    const openAiResponse = await fetch(OPENAI_API_URL, {
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
              transcript: normalizedTranscript,
              rawTranscript: transcript,
              locale,
              menuItems,
            }),
          },
        ],
      }),
    });

    if (!openAiResponse.ok) {
      const details = await openAiResponse.text();
      console.error(
        `[VOICE_ORDER] OpenAI request failed status=${openAiResponse.status} body=${details.slice(0, 400)}`,
      );
      return res.status(502).json({ message: "Failed to process voice command" });
    }

    const responseBody = await openAiResponse.json();
    const rawContent = responseBody?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonSafely(rawContent);
    if (!parsed || typeof parsed !== "object") {
      return res.status(502).json({ message: "Unable to parse voice command" });
    }

    let action = normalizeAction(parsed.action);
    const responseItems = Array.isArray(parsed.items) ? parsed.items.slice(0, MAX_RESULT_ITEMS) : [];
    const notFoundSet = new Set(
      (Array.isArray(parsed.notFound) ? parsed.notFound : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    );

    const items = [];
    responseItems.forEach((entry) => {
      const requestedName = String(entry?.name || "").trim();
      if (!requestedName) return;
      const quantityRaw = Number(entry?.quantity);
      const quantity = Number.isFinite(quantityRaw)
        ? Math.max(1, Math.min(20, Math.round(quantityRaw)))
        : 1;

      const canonicalName = menuLookup.get(normalizeText(requestedName));
      if (!canonicalName) {
        notFoundSet.add(requestedName);
        return;
      }

      items.push({ name: canonicalName, quantity });
    });

    if (
      action === "PLACE_ORDER" &&
      !hasExplicitPlaceOrderIntent(transcript) &&
      !hasExplicitPlaceOrderIntent(normalizedTranscript)
    ) {
      action = items.length > 0 ? "ADD_ITEMS" : "NONE";
    }

    const notFound = Array.from(notFoundSet).slice(0, 8);
    const assistantReply = buildLocalizedOrderReply({
      action,
      items,
      notFound,
      language,
    }).slice(0, 220);

    console.log(
      `[VOICE_ORDER] parsed output: ${JSON.stringify({
        action,
        language,
        itemCount: items.length,
        notFoundCount: notFoundSet.size,
      })}`,
    );
    console.log("[VOICE_ORDER] ai fallback usage: false");

    return res.json({
      originalText: transcript,
      language,
      ttsLocale: getTtsLocaleForLanguage(language),
      parsedCommand: {
        action,
        items,
        notFound,
      },
      action,
      items,
      notFound,
      assistantReply,
    });
  } catch (error) {
    console.error("[VOICE_ORDER] parseTapToOrderVoice error:", error);
    return res.status(500).json({ message: "Voice parsing failed" });
  }
};
