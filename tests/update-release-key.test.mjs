import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { updateSigningPublicKey } from '../scripts/release-android.mjs';

test('release requires a real RSA public key and exports native-compatible SPKI', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terracart-public-key-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(updateSigningPublicKey({}), /Configure APP_UPDATE_METADATA_PUBLIC_KEY_FILE/);
  const file = path.join(dir, 'public.pem');
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await fs.writeFile(file, publicKey.export({ format: 'pem', type: 'spki' }));
  assert.equal(await updateSigningPublicKey({ APP_UPDATE_METADATA_PUBLIC_KEY_FILE: file }),
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  await fs.writeFile(file, ec.export({ format: 'pem', type: 'spki' }));
  await assert.rejects(updateSigningPublicKey({ APP_UPDATE_METADATA_PUBLIC_KEY_FILE: file }), /RSA/);
});
