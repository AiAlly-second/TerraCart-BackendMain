/**
 * One-time migration: backfill attendanceDateIST (YYYY-MM-DD in IST) for existing
 * EmployeeAttendance records. New records get it set on create/check-in.
 * Run: node scripts/migrate-attendance-date-ist.js (with MONGO_URI in env)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const EmployeeAttendance = require("../models/employeeAttendanceModel");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateString(utcDate) {
  const d = new Date(utcDate.getTime() + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI required");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const cursor = EmployeeAttendance.find({
    $or: [
      { attendanceDateIST: { $exists: false } },
      { attendanceDateIST: "" },
      { attendanceDateIST: null },
    ],
  })
    .select("_id date attendanceDateIST")
    .lean()
    .cursor();

  let updated = 0;
  for await (const doc of cursor) {
    const date = doc.date;
    if (!date) continue;
    const istKey = toISTDateString(new Date(date));
    await EmployeeAttendance.updateOne(
      { _id: doc._id },
      { $set: { attendanceDateIST: istKey } }
    );
    updated++;
    if (updated % 100 === 0) console.log("Updated", updated);
  }
  console.log("Done. Backfilled attendanceDateIST for", updated, "records.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
