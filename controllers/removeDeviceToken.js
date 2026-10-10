function createRemoveDeviceToken(DeviceToken, User) {
  return async function removeDeviceToken(req, res) {
    const token = req.body?.token;
    const registrationId = req.body?.registrationId;
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 ||
        typeof registrationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(registrationId)) {
      return res.status(400).json({ success: false, message: 'Valid device token required' });
    }
    try {
      // Delayed logout cannot remove a token subsequently assigned to another user.
      await DeviceToken.updateOne({ token: token.trim(), userId: req.user._id,
        'metadata.mobileRegistrationId': registrationId },
        { $set: { isActive: false } });
      await User.updateOne({ _id: req.user._id, fcmToken: token.trim(), fcmTokenRegistrationId: registrationId },
        { $set: { fcmToken: null, fcmTokenRegistrationId: null } });
      return res.json({ success: true });
    } catch (_) {
      return res.status(503).json({ success: false, message: 'Device token cleanup unavailable' });
    }
  };
}
module.exports = { createRemoveDeviceToken };
