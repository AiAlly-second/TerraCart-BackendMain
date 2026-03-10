const voiceResponses = require("../data/voiceResponses.json");
const itemTranslations = require("../data/itemTranslations.json");
const {
  detectVoiceLanguage,
  normalizeSupportedLanguage,
  languageFromLocale,
} = require("../utils/languageDetector");

const fallbackTemplate = (action) =>
  String(action || "")
    .replace(/[_-]+/g, " ")
    .trim();

const toSafeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(numeric * 1000) / 1000;
};

const resolveResponseLanguage = ({
  language,
  text,
  locale,
  fallbackLanguage = "en",
} = {}) => {
  const direct = normalizeSupportedLanguage(language, "");
  if (direct) return direct;

  const localeLanguage = languageFromLocale(locale);
  const detected = detectVoiceLanguage(text, {
    locale: localeLanguage,
    fallbackLanguage,
  });
  return normalizeSupportedLanguage(detected, fallbackLanguage);
};

const translateItemName = ({ item, language }) => {
  const resolvedLanguage = normalizeSupportedLanguage(language, "en");
  const canonicalItem = String(item || "").trim();
  if (!canonicalItem) return "";

  const entry = itemTranslations[canonicalItem];
  if (entry && typeof entry === "object") {
    const localized =
      String(entry[resolvedLanguage] || entry.en || canonicalItem).trim();
    if (localized) return localized;
  }

  return resolvedLanguage === "en"
    ? canonicalItem.toLowerCase()
    : canonicalItem;
};

const renderTemplate = (template, variables = {}) =>
  String(template || "").replace(/\{(\w+)\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return "";
    const value = variables[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });

const resolveTemplate = ({ action, language }) => {
  const actionKey = String(action || "").trim();
  if (!actionKey) return "";

  const bucket = voiceResponses[actionKey];
  if (!bucket || typeof bucket !== "object") {
    return fallbackTemplate(actionKey);
  }

  return (
    bucket[language] ||
    bucket.en ||
    bucket.hi ||
    bucket.mr ||
    fallbackTemplate(actionKey)
  );
};

const getTtsLocaleForLanguage = (value) => {
  const language = normalizeSupportedLanguage(value, "en");
  if (language === "hi") return "hi-IN";
  if (language === "mr") return "mr-IN";
  return "en-IN";
};

const generateVoiceResponse = ({
  action,
  language,
  text,
  locale,
  qty,
  count,
  item,
  target,
} = {}) => {
  const resolvedLanguage = resolveResponseLanguage({
    language,
    text,
    locale,
  });
  const localizedItem = translateItemName({
    item,
    language: resolvedLanguage,
  });
  const quantity = toSafeNumber(qty, 0);
  const numericCount = toSafeNumber(count, 0);
  const template = resolveTemplate({
    action,
    language: resolvedLanguage,
  });

  const responseText = renderTemplate(template, {
    qty: quantity || numericCount || 1,
    count: numericCount || quantity || 1,
    item: localizedItem || "",
    target: String(target || "").trim(),
  })
    .replace(/\s+/g, " ")
    .trim();

  return {
    action: String(action || "").trim(),
    language: resolvedLanguage,
    ttsLocale: getTtsLocaleForLanguage(resolvedLanguage),
    item: localizedItem || String(item || "").trim(),
    text: responseText,
  };
};

const combineVoiceResponses = ({
  responses,
  language,
  separator = " ",
  maxParts = 2,
} = {}) => {
  const parts = (Array.isArray(responses) ? responses : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, maxParts);

  const joined = parts.join(separator).trim();
  return {
    language: normalizeSupportedLanguage(language, "en"),
    text: joined,
  };
};

module.exports = {
  resolveResponseLanguage,
  translateItemName,
  getTtsLocaleForLanguage,
  generateVoiceResponse,
  combineVoiceResponses,
};
