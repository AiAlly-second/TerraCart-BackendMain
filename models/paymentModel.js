const mongoose = require("mongoose");

const PAYMENT_METHODS = ["ONLINE", "CASH"];
const PAYMENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "CASH_PENDING",
  "PAID",
  "CANCELLED",
  "FAILED",
];

const paymentSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    method: {
      type: String,
      enum: PAYMENT_METHODS,
      default: "ONLINE",
    },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "PENDING",
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
    providerReference: String,
    upiPayload: String,
    paymentUrl: String,
    expiresAt: Date,
    paidAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
  },
  {
    timestamps: true,
  }
);

module.exports = {
  Payment: mongoose.model("Payment", paymentSchema),
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
};



