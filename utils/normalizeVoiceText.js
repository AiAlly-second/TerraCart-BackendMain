const DEFAULT_FILLER_WORDS = new Set([
  "please",
  "add",
  "give",
  "inventory",
  "stock",
  "item",
  "the",
  "of",
]);

const stripPunctuation = (value) =>
  String(value || "").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ");

const normalizeWhitespace = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeVoiceText = (value, options = {}) => {
  const removeFillerWords = options.removeFillerWords !== false;
  const fillerWords = options.fillerWords || DEFAULT_FILLER_WORDS;

  const lowered = String(value || "").toLowerCase();
  const punctuationNormalized = stripPunctuation(lowered);
  const compactText = normalizeWhitespace(punctuationNormalized);
  if (!compactText) return "";
  if (!removeFillerWords) return compactText;

  const filteredTokens = compactText
    .split(" ")
    .filter((token) => token && !fillerWords.has(token));

  return normalizeWhitespace(filteredTokens.join(" "));
};

module.exports = {
  DEFAULT_FILLER_WORDS,
  normalizeVoiceText,
};
