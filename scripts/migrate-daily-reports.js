// Dry-run by default. Never loads .env or drops/rebuilds existing indexes.
const mongoose = require('mongoose');
const models = require('../models/dailyReportModel');
const { Payment } = require('../models/paymentModel');
async function migrate({ apply = false } = {}) {
  const plan = Object.values(models).map(model => ({ collection: model.collection.name, indexes: model.schema.indexes() }));
  plan.push({ collection: Payment.collection.name, indexes: [[{ status: 1, paidAt: 1, orderId: 1 }, {}]] });
  if (!apply) return { dryRun: true, plan };
  await Promise.all(Object.values(models).map(model => model.createIndexes()));
  // MongoDB unique multikey indexes do NOT reject repeated values within one document.
  // This collection validator enforces unique embedded recipient records at the DB boundary.
  await mongoose.connection.db.command({ collMod: models.Settings.collection.name,
    validator: { $expr: { $eq: [
      { $size: { $ifNull: ['$recipients', []] } },
      { $size: { $setUnion: [{ $map: { input: { $ifNull: ['$recipients', []] }, as: 'r',
        in: { $toLower: '$$r.email' } } }, []] } },
    ] } }, validationLevel: 'strict', validationAction: 'error' });
  await Payment.collection.createIndex({ status: 1, paidAt: 1, orderId: 1 });
  return { applied: true, collections: plan.map(row => row.collection) };
}
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    if (apply) {
      if (!process.env.MONGO_URI) throw new Error('Explicit MONGO_URI required for approved migration');
      await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    }
    try { console.log(JSON.stringify(await migrate({ apply }), null, 2)); }
    finally { if (apply) await mongoose.disconnect(); }
  })().catch(() => { console.error('Daily report migration failed; inspect index conflicts before retrying'); process.exitCode = 1; });
}
module.exports = { migrate };
