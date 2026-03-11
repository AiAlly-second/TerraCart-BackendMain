const UNICODE_DIGIT_MAP = Object.freeze({
  // Devanagari
  "०": "0",
  "१": "1",
  "२": "2",
  "३": "3",
  "४": "4",
  "५": "5",
  "६": "6",
  "७": "7",
  "८": "8",
  "९": "9",
  // Gujarati
  "૦": "0",
  "૧": "1",
  "૨": "2",
  "૩": "3",
  "૪": "4",
  "૫": "5",
  "૬": "6",
  "૭": "7",
  "૮": "8",
  "૯": "9",
});

const NUMBER_WORD_MAP = Object.freeze({
  // English
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",

  // Hindi (Romanized)
  ek: "1",
  do: "2",
  teen: "3",
  char: "4",
  chaar: "4",
  paanch: "5",
  panch: "5",
  chhe: "6",
  che: "6",
  saat: "7",
  sat: "7",
  aath: "8",
  ath: "8",
  nau: "9",
  das: "10",

  // Marathi (Romanized + overlaps)
  don: "2",
  saha: "6",
  daha: "10",

  // Hindi (Devanagari)
  "एक": "1",
  "दो": "2",
  "तीन": "3",
  "चार": "4",
  "पांच": "5",
  "पाँच": "5",
  "छह": "6",
  "सात": "7",
  "आठ": "8",
  "नौ": "9",
  "दस": "10",

  // Marathi (Devanagari)
  "दोन": "2",
  "पाच": "5",
  "सहा": "6",
  "नऊ": "9",
  "दहा": "10",
});

const AMBIGUOUS_NUMBER_WORD_MAP = Object.freeze({
  // STT homophone fixes; applied contextually to avoid command corruption.
  to: "2",
  too: "2",
  for: "4",
  ate: "8",
});

const AMBIGUOUS_NEIGHBOR_BLOCKLIST = new Set([
  "add",
  "deduct",
  "deduce",
  "subtract",
  "reduce",
  "remove",
  "consume",
  "set",
  "update",
  "open",
  "show",
  "go",
  "back",
  "inventory",
  "stock",
  "order",
  "orders",
  "cart",
  "page",
  "screen",
  "to",
  "for",
  "of",
]);

const shouldConvertAmbiguousWord = (tokens, index) => {
  const token = tokens[index];
  if (!AMBIGUOUS_NUMBER_WORD_MAP[token]) return false;

  const prev = index > 0 ? tokens[index - 1] : "";
  const next = index + 1 < tokens.length ? tokens[index + 1] : "";

  // Avoid corrupting intent phrases: "want to deduct", "go to inventory".
  if (AMBIGUOUS_NEIGHBOR_BLOCKLIST.has(prev)) return false;
  if (AMBIGUOUS_NEIGHBOR_BLOCKLIST.has(next)) return false;

  // Convert when it clearly appears in a quantity slot.
  if (!prev || prev === "and" || prev === ",") return true;

  // If ambiguous, keep as-is for parser fallback.
  return false;
};

const normalizeUnicodeDigits = (value) => {
  let output = String(value || "");
  Object.entries(UNICODE_DIGIT_MAP).forEach(([unicodeDigit, asciiDigit]) => {
    output = output.replaceAll(unicodeDigit, asciiDigit);
  });
  return output;
};

const normalizeNumberWords = (value) => {
  const digitNormalized = normalizeUnicodeDigits(value);
  const compact = String(digitNormalized || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!compact) return "";

  const rawTokens = compact.split(" ").map((token) => token.trim());
  const tokens = rawTokens.map((token, index) => {
    const mapped = NUMBER_WORD_MAP[token];
    if (mapped) return mapped;

    if (shouldConvertAmbiguousWord(rawTokens, index)) {
      return AMBIGUOUS_NUMBER_WORD_MAP[token];
    }

    return token;
  });

  return tokens.join(" ");
};

module.exports = {
  NUMBER_WORD_MAP,
  normalizeUnicodeDigits,
  normalizeNumberWords,
};
