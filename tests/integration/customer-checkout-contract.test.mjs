// Explicit paired-checkout local test; not part of single-repository CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { startIsolatedMongo } from '../helpers/isolatedMongo.js';
import { createCustomerSessionRouter } from '../../routes/customerSessionRoutes.js';
import Cart from '../../models/cartModel.js';
import { createCheckoutLocationClient } from '../../../TerraCart-Frontend/src/services/checkoutLocation.js';

test('actual frontend client and backend HTTP/Mongo share selection, refresh, removal and revocation contract', async t => {
  const db = await startIsolatedMongo();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const cart = await Cart.create({ name: 'Isolated test store', franchiseId: new mongoose.Types.ObjectId(), cartAdminId: new mongoose.Types.ObjectId() });
  const origin = 'https://customer.example.invalid';
  const app = express(); app.use(express.json());
  app.use('/api/customer/session', createCustomerSessionRouter({ origins: [origin], secure: false }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let cookie;
  const fetcher = async (url, options) => {
    const response = await fetch(url, { ...options, headers: { ...options.headers, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const client = () => createCheckoutLocationClient({ apiOrigin: () => `http://127.0.0.1:${server.address().port}`, fetcher, storage: () => ({ getItem: () => null, removeItem: () => {} }) });
  const location = { latitude: 18.52, longitude: 73.85, address: 'मराठी हिंदी Test address' };
  const selected = await client().save(location, String(cart._id));
  assert.match(selected.locationReference, /^[a-f\d]{32}$/);
  assert.deepEqual(await client().restore(String(cart._id)), selected);
  await client().save({ ...location, latitude: 19 }, String(cart._id));
  assert.deepEqual(await client().restore(String(cart._id), selected.locationReference), selected);
  await client().clear(); assert.equal(await client().restore(String(cart._id)), null);
  await client().revoke();
});
