/**
 * Top-K menu name retrieval + lightweight deterministic tap-to-order parsing
 * to reduce GPT prompt size (VOICE_RETRIEVAL_V2).
 */

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u0c7f\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value) =>
  normalizeText(value)
    .split(/\s+/)
    .filter((t) => t.length > 0);

const CLEAR_PHRASES = [
  "clear cart",
  "empty cart",
  "reset cart",
  "remove all",
  "cart clear",
  "delete cart",
];

const SHOW_PHRASES = [
  "show cart",
  "open cart",
  "go to cart",
  "view cart",
  "see cart",
  "cart kholo",
];

/** Multi-token or unambiguous checkout phrases only — never bare "confirm". */
const PLACE_PHRASES = [
  "place order",
  "confirm order",
  "checkout",
  "submit order",
  "pay now",
  "order now",
  "complete order",
  "finish order",
  "finalize order",
];

const containsPhraseFromList = (normalizedTranscript, phrases) =>
  phrases.some((p) => normalizedTranscript.includes(p));

/**
 * Score how well a menu item matches the transcript (token overlap + substring).
 */
const scoreMenuMatch = (normalizedTranscript, menuNameNorm) => {
  if (!menuNameNorm) return 0;
  if (normalizedTranscript.includes(menuNameNorm)) return 100 + menuNameNorm.length;
  const tt = tokenize(normalizedTranscript);
  const mn = tokenize(menuNameNorm);
  if (!mn.length) return 0;
  const setT = new Set(tt);
  let overlap = 0;
  mn.forEach((w) => {
    if (setT.has(w)) overlap += 1;
  });
  const jaccard = overlap / (new Set([...tt, ...mn]).size || 1);
  return jaccard * 50 + overlap * 10;
};

/**
 * @param {string} transcript
 * @param {string[]} menuItems - canonical menu names
 * @param {number} k
 * @returns {{ names: string[], scores: Map<string, number> }}
 */
function retrieveTopKMenuNames(transcript, menuItems, k = 40) {
  const kt = Math.max(10, Math.min(120, Number(k) || 40));
  const normalizedTranscript = normalizeText(transcript);
  const scored = menuItems
    .map((name) => {
      const nn = normalizeText(name);
      return { name, score: scoreMenuMatch(normalizedTranscript, nn) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const names = [];
  for (const row of scored) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    names.push(row.name);
    if (names.length >= kt) break;
  }

  // Ensure at least a minimal pool: append unscored names until kt or exhausted
  if (names.length < Math.min(kt, menuItems.length)) {
    for (const name of menuItems) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= kt) break;
    }
  }

  const scores = new Map(scored.map((r) => [r.name, r.score]));
  return { names, scores };
}

/**
 * Fast path without GPT for obvious navigation intents.
 * @returns {null | { action: string }}
 */
function tryDeterministicNonAddIntent(normalizedTranscript) {
  if (containsPhraseFromList(normalizedTranscript, CLEAR_PHRASES)) {
    return { action: "CLEAR_CART" };
  }
  if (containsPhraseFromList(normalizedTranscript, SHOW_PHRASES)) {
    return { action: "SHOW_CART" };
  }
  if (containsPhraseFromList(normalizedTranscript, PLACE_PHRASES)) {
    return { action: "PLACE_ORDER" };
  }
  return null;
}

module.exports = {
  normalizeText,
  retrieveTopKMenuNames,
  tryDeterministicNonAddIntent,
  CLEAR_PHRASES,
  SHOW_PHRASES,
  PLACE_PHRASES,
};
