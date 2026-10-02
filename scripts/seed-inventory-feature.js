const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { seedExistingInventoryFeatures } = require("../services/featureService");
const PlatformFeature = require("../models/platformFeatureModel");
const FranchiseFeature = require("../models/franchiseFeatureModel");
const FeatureChangeAudit = require("../models/featureChangeAuditModel");
const InventoryReconciliationCount = require("../models/inventoryReconciliationCountModel");

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) {
  console.error("Usage: node scripts/seed-inventory-feature.js [--apply]");
  process.exitCode = 2;
} else {
  (async () => {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required; no database fallback is allowed");
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    if (args.includes("--apply")) {
      await Promise.all([PlatformFeature.createIndexes(), FranchiseFeature.createIndexes(),
        FeatureChangeAudit.createIndexes(), InventoryReconciliationCount.createIndexes()]);
    }
    const result = await seedExistingInventoryFeatures({ apply: args.includes("--apply") });
    console.log(JSON.stringify({ mode: result.dryRun ? "DRY_RUN" : "APPLIED", ...result }, null, 2));
  })().catch(error => {
    console.error("Inventory feature seed failed:", error.message);
    process.exitCode = 1;
  }).finally(async () => {
    await mongoose.disconnect();
  });
}
