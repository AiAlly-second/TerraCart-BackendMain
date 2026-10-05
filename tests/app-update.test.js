const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { createAppUpdateController } = require('../controllers/appUpdateController');
const { validateMetadata } = require('../utils/appUpdateMetadata');
async function fixture(t, legacy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terracart-api-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'app-update.json');
  const filename = legacy ? 'terracart_admin_v1.0.15.apk' : 'terracart_v1.0.16_b36.apk';
  const bytes = Buffer.from('APK fixture bytes');
  const metadata = { latestVersion: legacy ? '1.0.15' : '1.0.16', minimumSupportedVersion: '1.0.12', forceUpdate: false,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), releaseNotes: 'Release', apkUrl: '', updateUrl: '',
    ...(!legacy ? { apkFileName: filename, latestBuildNumber: 36, fileSizeBytes: bytes.length, publishedAt: new Date().toISOString() } : {}) };
  await fs.writeFile(configPath, JSON.stringify(metadata)); await fs.writeFile(path.join(root, filename), bytes);
  const c = createAppUpdateController({ configPath, apkDirectory: root, env: { API_PUBLIC_BASE_URL: 'https://api.example.com', NODE_ENV: 'production' } });
  const app = express(); for (const prefix of ['/api/app', '/api/v1/app']) {
    app.get(`${prefix}/version`, c.getAppVersion); app.get(`${prefix}/update`, c.getAppVersion); app.get(`${prefix}/apk/:version`, c.downloadApkByVersion);
  }
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, configPath, metadata, filename, bytes, base: `http://127.0.0.1:${server.address().port}` };
}
for (const legacy of [false, true]) test(`metadata and APK API return identical hashed bytes (${legacy ? 'legacy' : 'new'})`, async t => {
  const f = await fixture(t, legacy);
  for (const prefix of ['/api/app', '/api/v1/app']) {
    const response = await fetch(f.base + prefix + '/update'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = (await response.json()).data; assert.equal(data.apkFileName, f.filename); assert.equal(data.fileSizeBytes, f.bytes.length);
    assert.equal(data.apkUrl, `https://api.example.com/api/app/apk/${f.metadata.latestVersion}`);
    const apk = await fetch(f.base + prefix + '/apk/' + f.metadata.latestVersion);
    assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(Number(apk.headers.get('content-length')), f.bytes.length);
    assert.ok(apk.headers.get('content-disposition').includes(f.filename));
    const bytes = Buffer.from(await apk.arrayBuffer()); assert.deepEqual(bytes, f.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), data.sha256);
  }
});
test('invalid version, traversal, older version cannot access arbitrary files', async t => {
  const f = await fixture(t);
  for (const version of ['..%2Fapp-update.json', '..', '1.0.15']) {
    const response = await fetch(f.base + '/api/app/apk/' + version); assert.ok([400, 404].includes(response.status));
  }
  for (const name of ['../secret.apk', '/etc/passwd', 'a.apk\r\nx-secret: yes']) assert.throws(() => validateMetadata({ ...f.metadata, apkFileName: name }));
});
test('invalid JSON returns safe 500 with no cached fabricated metadata', async t => {
  const f = await fixture(t); await fs.writeFile(f.configPath, '{bad');
  const response = await fetch(f.base + '/api/app/update'); assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).code, 'APP_UPDATE_CONFIG_INVALID');
});
test('symlink APK is rejected; configured size mismatch fails closed', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'real.apk'); await fs.rename(path.join(f.root, f.filename), target); await fs.symlink(target, path.join(f.root, f.filename));
  assert.equal((await fetch(f.base + '/api/app/apk/1.0.16')).status, 500);
  await fs.rm(path.join(f.root, f.filename)); await fs.rename(target, path.join(f.root, f.filename));
  await fs.writeFile(f.configPath, JSON.stringify({ ...f.metadata, fileSizeBytes: 999 }));
  assert.equal((await fetch(f.base + '/api/app/update')).status, 500);
});

test('metadata filename version/build must agree with release mapping', async t => {
  const f = await fixture(t);
  assert.throws(() => validateMetadata({ ...f.metadata, apkFileName: 'terracart_v1.0.15_b36.apk' }));
  assert.throws(() => validateMetadata({ ...f.metadata, apkFileName: 'terracart_v1.0.16_b35.apk' }));
});
