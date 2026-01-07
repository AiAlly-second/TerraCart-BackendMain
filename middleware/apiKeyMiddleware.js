const User = require("../models/userModel");

const protectWithApiKey = async (req, res, next) => {
  // 1. Check for API key header
  const apiKey = req.headers["x-api-key"];

  if (!apiKey) {
    // If no API Key, proceed to standard Bearer Token check (next middleware)
    // OR return error if this is a strict API-Key-only route
    return next();
  }

  try {
    // 2. Find user with this API Key
    const user = await User.findOne({ "apiKeys.key": apiKey });

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid API Key" });
    }

    // 3. Update last used date (optional, non-blocking)
    const keyIndex = user.apiKeys.findIndex((k) => k.key === apiKey);
    if (keyIndex > -1) {
      user.apiKeys[keyIndex].lastUsed = new Date();
      await user.save({ validateBeforeSave: false }); // Skip validation for speed
    }

    // 4. Attach user to request
    req.user = user;
    
    // 5. Bypass standard JWT auth (flag it as authenticated)
    req.isApiKeyAuth = true; 
    
    next();
  } catch (error) {
    console.error("API Key Auth Error:", error);
    res.status(500).json({ success: false, message: "Server error during API Key auth" });
  }
};

module.exports = { protectWithApiKey };
