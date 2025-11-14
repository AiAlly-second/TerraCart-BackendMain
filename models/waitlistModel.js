const mongoose = require("mongoose");

const waitlistSchema = new mongoose.Schema(
  {
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },
    tableNumber: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    name: { type: String },
    partySize: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ["WAITING", "NOTIFIED", "SEATED", "CANCELLED"],
      default: "WAITING",
    },
    notifiedAt: Date,
    seatedAt: Date,
    sessionToken: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

waitlistSchema.index({ table: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model("Waitlist", waitlistSchema);

