const UNIT_WORD_MAP = Object.freeze({
  // Weight
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  kg: "kg",
  kgs: "kg",
  gram: "g",
  grams: "g",
  gm: "g",
  g: "g",

  // Volume
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  l: "l",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  ml: "ml",

  // Count
  piece: "pcs",
  pieces: "pcs",
  pc: "pcs",
  pcs: "pcs",
  "\u092a\u0940\u0938": "pcs",
  "\u092a\u0940\u0938\u0947\u0938": "pcs",
  "\u092a\u093f\u0938": "pcs",

  bottle: "bottle",
  bottles: "bottle",
  botal: "bottle",
  botel: "bottle",
  "\u092c\u094b\u0924\u0932": "bottle",
  "\u092c\u094b\u0924\u0932\u0947": "bottle",
  "\u092c\u093e\u091f\u0932\u0940": "bottle",
  "\u092c\u093e\u091f\u0932\u094d\u092f\u093e": "bottle",

  packet: "pack",
  packets: "pack",
  pack: "pack",
  packs: "pack",
  "\u092a\u0948\u0915\u0947\u091f": "pack",
  "\u092a\u0948\u0915\u0947\u091f\u094d\u0938": "pack",
  "\u092a\u0945\u0915\u0947\u091f": "pack",
  "\u092a\u0945\u0915\u0947\u091f\u094d\u0938": "pack",

  box: "box",
  boxes: "box",
  "\u0921\u092c\u094d\u092c\u093e": "box",
  "\u0921\u092c\u094d\u092c\u0947": "box",

  dozen: "dozen",
  "\u0926\u0930\u094d\u091c\u0928": "dozen",
});

const normalizeUnitWords = (value) => {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return "";

  const tokens = compact.split(" ").map((token) => {
    const direct = UNIT_WORD_MAP[token];
    if (direct) return direct;

    const lower = token.toLowerCase();
    const mapped = UNIT_WORD_MAP[lower];
    if (mapped) return mapped;

    return token;
  });

  return tokens.join(" ");
};

module.exports = {
  UNIT_WORD_MAP,
  normalizeUnitWords,
};
