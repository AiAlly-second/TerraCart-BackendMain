const SUPPORTED_LANGUAGES = Object.freeze(["en", "hi", "mr"]);

const DEVANAGARI_REGEX = /[\u0900-\u097F]/u;

const MARATHI_DEVANAGARI_KEYWORDS = new Set([
  "चहा",
  "कांदा",
  "बटाटा",
  "पाहिजे",
  "कार्टमध्ये",
  "मध्ये",
  "जोडा",
  "जोडले",
  "काढा",
  "काढले",
  "वाढवा",
  "कमी",
  "नको",
  "साठा",
  "इन्व्हेंटरी",
]);

const MARATHI_ROMAN_KEYWORDS = new Set([
  "chaha",
  "kanda",
  "batata",
  "pahije",
  "madhe",
  "joda",
  "kadh",
  "vadhva",
  "satha",
]);

const HINDI_DEVANAGARI_KEYWORDS = new Set([
  "चाय",
  "प्याज",
  "आलू",
  "चाहिए",
  "कार्ट",
  "में",
  "जोड़",
  "जोड़ो",
  "हटाओ",
  "कम",
  "घटा",
  "स्टॉक",
  "इन्वेंटरी",
]);

const normalizeSupportedLanguage = (value, fallback = "en") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (SUPPORTED_LANGUAGES.includes(normalized)) {
    return normalized;
  }
  return fallback;
};

const languageFromLocale = (value) => {
  const locale = String(value || "")
    .trim()
    .toLowerCase();
  if (!locale) return "";
  if (locale.startsWith("mr")) return "mr";
  if (locale.startsWith("hi")) return "hi";
  if (locale.startsWith("en")) return "en";
  return "";
};

const tokenize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

const keywordHits = (tokens, dictionary) =>
  tokens.reduce((count, token) => (dictionary.has(token) ? count + 1 : count), 0);

const detectVoiceLanguage = (value, options = {}) => {
  const text = String(value || "").trim();
  if (!text) {
    return normalizeSupportedLanguage(
      options.fallbackLanguage || options.hintLanguage,
      "en",
    );
  }

  const explicitHint = normalizeSupportedLanguage(options.hintLanguage, "");
  if (explicitHint) return explicitHint;

  const localeHint = languageFromLocale(options.locale);
  const tokens = tokenize(text);
  const marathiScore =
    keywordHits(tokens, MARATHI_DEVANAGARI_KEYWORDS) +
    keywordHits(tokens, MARATHI_ROMAN_KEYWORDS);
  const hindiScore = keywordHits(tokens, HINDI_DEVANAGARI_KEYWORDS);
  const hasDevanagari = DEVANAGARI_REGEX.test(text);

  if (marathiScore > 0 && marathiScore >= hindiScore) return "mr";
  if (hasDevanagari) return "hi";
  if (localeHint) return localeHint;
  return "en";
};

module.exports = {
  SUPPORTED_LANGUAGES,
  normalizeSupportedLanguage,
  languageFromLocale,
  detectVoiceLanguage,
};
