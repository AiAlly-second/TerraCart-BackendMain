/**
 * Thin aliases for AI-specific tracing (voice parse, translation).
 */
const { logAi, logVoiceCache } = require("./logger");

module.exports = {
  aiVoiceParse: (fields) => logAi("voice_parse", fields),
  aiVoiceCache: (fields) => logVoiceCache("voice_parse_cache", fields),
  aiTranslateBatch: (fields) => logAi("translate_batch", fields),
};
