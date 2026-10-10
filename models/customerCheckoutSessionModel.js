const mongoose = require('mongoose');

// Separate, bounded checkout recovery; never import client identity as ownership.
const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  csrfToken: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  location: {
    reference: String,
    cartId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cart' },
    latitude: Number,
    longitude: Number,
    address: String,
    expiresAt: Date,
  },
  // At most eight location versions, for interrupted payment draft recovery.
  // All versions expire/revoke with this one-hour session.
  locationVersions: [{ reference: String, cartId: mongoose.Schema.Types.ObjectId, latitude: Number, longitude: Number, address: String, expiresAt: Date }],
}, { timestamps: true });

module.exports = mongoose.model('CustomerCheckoutSession', schema);
