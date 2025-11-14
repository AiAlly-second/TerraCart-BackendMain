// models/counterModel.js
const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // YYYYMMDD
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model("Counter", counterSchema);
