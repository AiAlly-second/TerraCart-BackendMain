const { parseVoiceCommandIntent } = require("../services/voiceCommandService");

exports.detectVoiceCommandIntent = async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({
        success: false,
        message: "text is required",
      });
    }

    const role =
      String(req.user?.role || req.body?.role || "manager")
        .trim()
        .toLowerCase() || "manager";

    const result = await parseVoiceCommandIntent({
      text,
      role,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to parse voice command intent",
    });
  }
};
