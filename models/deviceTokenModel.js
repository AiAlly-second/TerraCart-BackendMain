const mongoose = require("mongoose");

const deviceTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["android", "ios", "web", "unknown"],
      default: "unknown",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
      sparse: true,
    },
    anonymousSessionId: {
      type: String,
      trim: true,
      default: null,
      index: true,
      sparse: true,
    },
    cartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
      sparse: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    source: {
      type: String,
      enum: ["app", "web", "unknown"],
      default: "unknown",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ userId: 1, isActive: 1, updatedAt: -1 });
deviceTokenSchema.index({ anonymousSessionId: 1, isActive: 1, updatedAt: -1 });

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
