const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL =
  process.env.OPENAI_TRANSLATE_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const SUPPORTED_LANGUAGES = {
  en: "English",
  hi: "Hindi",
  mr: "Marathi",
  gu: "Gujarati",
};

const MAX_TEXTS = 800;
const MAX_TEXT_LENGTH = 160;
const BATCH_SIZE = 80;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const CACHE_LIMIT = 10000;
const TRANSLATION_STYLE_VERSION = "script_preserve_english_v1";

const translationCache = new Map();

const normalizeLang = (value) => {
  const lang = String(value || "en").trim().toLowerCase();
  return SUPPORTED_LANGUAGES[lang] ? lang : "en";
};

const normalizeText = (value) => String(value || "").trim();

const toCacheKey = (lang, text) =>
  `${TRANSLATION_STYLE_VERSION}::${lang}::${text}`;

const pruneCache = () => {
  const now = Date.now();
  for (const [key, value] of translationCache.entries()) {
    if (!value || now - Number(value.createdAt || 0) > CACHE_TTL_MS) {
      translationCache.delete(key);
    }
  }
  if (translationCache.size <= CACHE_LIMIT) return;
  const overflow = translationCache.size - CACHE_LIMIT;
  let removed = 0;
  for (const key of translationCache.keys()) {
    translationCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
};

const parseJsonSafely = (rawContent) => {
  if (!rawContent) return null;
  if (typeof rawContent === "object") return rawContent;
  if (typeof rawContent !== "string") return null;

  try {
    return JSON.parse(rawContent);
  } catch (_error) {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_innerError) {
      return null;
    }
  }
};

const callOpenAiTranslationBatch = async ({ targetLang, texts }) => {
  if (!texts.length) return [];
  const targetLanguageName = SUPPORTED_LANGUAGES[targetLang] || "English";

  const systemPrompt = [
    "You are a restaurant menu text converter.",
    `Convert each input string to ${targetLanguageName} script while preserving the original English meaning exactly.`,
    "Return JSON only with this shape: {\"translations\":[{\"index\":0,\"translated\":\"...\"}]}",
    "Rules:",
    "- Do not perform semantic translation or synonym replacement.",
    "- Use transliteration/script conversion so wording remains the same as English.",
    "- Keep brand names, dish names, and token order intact.",
    "- Example intent: 'Masala Dosa' should stay as the same phrase written in Marathi script, not converted to a different-meaning phrase.",
    "- Keep numbers, quantity words, punctuation, and currency symbols unchanged when appropriate.",
    "- Do not add explanations.",
    "- Keep one translated output for each input index.",
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
            targetLang,
            texts,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `OpenAI translate batch failed (${response.status}): ${details.slice(0, 300)}`,
    );
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonSafely(rawContent);
  const rows = Array.isArray(parsed?.translations) ? parsed.translations : [];

  return rows.map((row) => {
    const index = Number(row?.index);
    const translated = normalizeText(row?.translated);
    return {
      index: Number.isFinite(index) ? index : -1,
      translated,
    };
  });
};

exports.translateMenuPageTexts = async (req, res) => {
  try {
    const targetLang = normalizeLang(req.body?.targetLang);
    const rawTexts = Array.isArray(req.body?.texts) ? req.body.texts : [];

    const dedupedTexts = [];
    const seen = new Set();
    rawTexts.forEach((entry) => {
      const text = normalizeText(entry);
      if (!text) return;
      if (text.length > MAX_TEXT_LENGTH) return;
      if (seen.has(text)) return;
      seen.add(text);
      dedupedTexts.push(text);
    });

    if (dedupedTexts.length > MAX_TEXTS) {
      return res.status(400).json({
        message: `Too many texts. Maximum supported is ${MAX_TEXTS}.`,
      });
    }

    if (targetLang === "en" || dedupedTexts.length === 0) {
      const identity = {};
      dedupedTexts.forEach((text) => {
        identity[text] = text;
      });
      return res.json({
        targetLang,
        translations: identity,
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        message: "OPENAI_API_KEY is not configured",
      });
    }

    pruneCache();

    const translations = {};
    const missingTexts = [];
    dedupedTexts.forEach((text) => {
      const cacheKey = toCacheKey(targetLang, text);
      const cached = translationCache.get(cacheKey);
      if (cached && normalizeText(cached.translated)) {
        translations[text] = normalizeText(cached.translated);
      } else {
        missingTexts.push(text);
      }
    });

    for (let i = 0; i < missingTexts.length; i += BATCH_SIZE) {
      const batch = missingTexts.slice(i, i + BATCH_SIZE);
      try {
        const batchResult = await callOpenAiTranslationBatch({
          targetLang,
          texts: batch,
        });

        batchResult.forEach(({ index, translated }) => {
          if (!Number.isFinite(index) || index < 0 || index >= batch.length) return;
          const sourceText = batch[index];
          const safeTranslated = translated || sourceText;
          translations[sourceText] = safeTranslated;
          translationCache.set(toCacheKey(targetLang, sourceText), {
            translated: safeTranslated,
            createdAt: Date.now(),
          });
        });

        // Fill any unresolved rows with source text to keep response complete.
        batch.forEach((sourceText) => {
          if (!translations[sourceText]) {
            translations[sourceText] = sourceText;
          }
        });
      } catch (error) {
        console.error("[TRANSLATION] OpenAI batch error:", error.message);
        batch.forEach((sourceText) => {
          translations[sourceText] = sourceText;
        });
      }
    }

    return res.json({
      targetLang,
      translations,
    });
  } catch (error) {
    console.error("[TRANSLATION] translateMenuPageTexts error:", error);
    return res.status(500).json({
      message: "Failed to translate menu texts",
    });
  }
};
