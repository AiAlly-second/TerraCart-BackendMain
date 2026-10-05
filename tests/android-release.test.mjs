import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { parseArgs, hashFile, validateTargets, distributionArgs, preflight, publish, recover,
  analysisFindings, assertAnalysisBaseline, futureMetadata, distributionResult } from '../scripts/release-android.mjs';
const certificate = new X509Certificate(rootCertificates[0]).fingerprint256.replaceAll(':', '').toLowerCase();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terracart-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backendDir = path.join(root, 'backend'), appDir = path.join(root, 'app'), apkDir = path.join(backendDir, 'apk');
  await fs.mkdir(path.join(apkDir, '.staging'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'android/app'), { recursive: true });
  const currentApk = path.join(apkDir, 'terracart_admin_v1.0.15.apk');
  await fs.writeFile(currentApk, 'old APK fixture');
  const current = { latestVersion: '1.0.15', minimumSupportedVersion: '1.0.12',
    forceUpdate: false, sha256: await hashFile(currentApk), releaseNotes: 'old', apkUrl: '', updateUrl: '', apkFileName: path.basename(currentApk) };
  const metadataPath = path.join(backendDir, 'app-update.json');
  await fs.writeFile(metadataPath, JSON.stringify(current));
  const env = { ...process.env, FIREBASE_PROJECT_ID: 'test-project', FIREBASE_ANDROID_APP_ID: '1:123:android:abc',
    FIREBASE_APP_DISTRIBUTION_GROUPS: 'qa', FIREBASE_APP_DISTRIBUTION_TESTERS: '',
    API_PUBLIC_BASE_URL: 'https://api.example.com', APP_UPDATE_APK_PREFIX: 'terracart', GOOGLE_APPLICATION_CREDENTIALS: '' };
  await fs.writeFile(path.join(backendDir, '.env'), Object.entries(env).filter(([k]) => k.startsWith('FIREBASE') || k.startsWith('APP_UPDATE') || k === 'API_PUBLIC_BASE_URL' || k === 'GOOGLE_APPLICATION_CREDENTIALS').map(([k, v]) => `${k}=${v}`).join('\n'));
  await fs.writeFile(path.join(appDir, 'pubspec.yaml'), 'version: 1.0.16+36\n');
  await fs.writeFile(path.join(appDir, 'android/app/build.gradle'), 'applicationId = "com.example.terra_admin_app"');
  await fs.writeFile(path.join(appDir, 'android/app/google-services.json'), JSON.stringify({ project_info: { project_id: 'test-project' }, client: [{ client_info: { mobilesdk_app_id: env.FIREBASE_ANDROID_APP_ID, android_client_info: { package_name: 'com.example.terra_admin_app' } } }] }));
  const sdk = path.join(root, 'sdk'), toolsDir = path.join(sdk, 'build-tools/36.1.0');
  await fs.mkdir(toolsDir, { recursive: true });
  for (const command of ['apksigner', 'aapt']) await fs.writeFile(path.join(toolsDir, command), 'test fixture');
  await fs.writeFile(path.join(appDir, 'android/local.properties'), `sdk.dir=${sdk}`);
  await fs.writeFile(path.join(appDir, 'android/key.properties'), 'storeFile=fixture.jks\nstorePassword=test-only\nkeyAlias=test\nkeyPassword=test-only\n');
  await fs.writeFile(path.join(appDir, 'android/fixture.jks'), 'test-only fake keystore');
  const filename = 'terracart_v1.0.16_b36.apk';
  const source = path.join(root, 'built.apk'); await fs.writeFile(source, 'new APK fixture');
  const plan = { appDir, backendDir, apkDir, metadataPath, currentApk, current, env, version: '1.0.16', build: 36,
    filename, destination: path.join(apkDir, filename), packageName: 'com.example.terra_admin_app',
    signingCertificate: certificate, signingChanged: false, publicBase: 'https://api.example.com',
    notes: 'Safe release notes', targets: { testers: [], groups: ['qa'] }, skip: false, options: {},
    tools: { apksigner: path.join(toolsDir, 'apksigner'), aapt: path.join(toolsDir, 'aapt') } };
  let distributed = null;
  const runner = async (command, args) => {
    const name = path.basename(command);
    let stdout = '';
    if (name === 'apksigner') stdout = `Signer #1 certificate SHA-256 digest: ${certificate}`;
    if (name === 'aapt') stdout = `package: name='com.example.terra_admin_app' versionCode='${path.basename(args.at(-1)) === path.basename(currentApk) ? 15 : 36}' versionName='${path.basename(args.at(-1)) === path.basename(currentApk) ? '1.0.15' : '1.0.16'}'`;
    if (name === 'keytool') stdout = rootCertificates[0];
    if (name === 'firebase' && args[0] === 'apps:list') stdout = JSON.stringify({ status: 'success', result: [{ appId: env.FIREBASE_ANDROID_APP_ID }] });
    if (name === 'firebase' && args[0] === 'appdistribution:groups:list') stdout = JSON.stringify({ status: 'success', result: { groups: [{ name: 'projects/123/groups/qa' }] } });
    if (name === 'firebase' && args[0] === 'appdistribution:distribute') {
      distributed = await fs.readFile(args[1]);
      stdout = JSON.stringify({ status: 'success', result: { release: { displayVersion: '1.0.16', buildVersion: '36' } } });
    }
    return { code: 0, stdout, stderr: '' };
  };
  const options = { 'app-dir': appDir, 'backend-dir': backendDir, notes: plan.notes };
  return { root, plan, source, runner, options, distributed: () => distributed,
    original: await fs.readFile(metadataPath),
    assertOld: async () => { assert.deepEqual(await fs.readFile(metadataPath), Buffer.from(JSON.stringify(current))); assert.equal(await fs.readFile(currentApk, 'utf8'), 'old APK fixture'); assert.equal(await fs.access(plan.destination).then(() => true, () => false), false); } };
}

test('arguments are strict; unsafe shell notes remain one argument', () => {
  assert.throws(() => parseArgs(['--unknown'])); assert.throws(() => parseArgs(['--notes']));
  assert.throws(() => parseArgs(['--notes', 'a', '--notes-file', 'b']));
  assert.throws(() => parseArgs(['--obfuscate', '--skip-firebase']));
  const args = distributionArgs('/a path/app.apk', { FIREBASE_ANDROID_APP_ID: 'app', FIREBASE_PROJECT_ID: 'p' }, { testers: [], groups: ['qa'] }, '/notes path.txt');
  assert.equal(args[1], '/a path/app.apk'); assert.ok(!args.includes('--testers')); assert.ok(args.includes('--groups'));
});
test('targets reject empty/invalid config, support combined CSV and explicit skip', () => {
  assert.throws(() => validateTargets({}, false));
  assert.throws(() => validateTargets({ FIREBASE_APP_DISTRIBUTION_TESTERS: 'bad' }, false));
  assert.throws(() => validateTargets({ FIREBASE_APP_DISTRIBUTION_GROUPS: '../bad' }, false));
  assert.deepEqual(validateTargets({}, true), { testers: [], groups: [] });
  assert.deepEqual(validateTargets({ FIREBASE_APP_DISTRIBUTION_TESTERS: 'a@example.com,b@example.com', FIREBASE_APP_DISTRIBUTION_GROUPS: 'qa,internal' }, false), { testers: ['a@example.com', 'b@example.com'], groups: ['qa', 'internal'] });
});
test('analysis baseline ignores line movement but blocks errors/new counts', () => {
  const a = analysisFindings('INFO|LINT|RULE|/app/lib/a.dart|2|4|1|message', '/app');
  assertAnalysisBaseline(analysisFindings('INFO|LINT|RULE|/app/lib/a.dart|20|4|1|message', '/app'), a);
  assert.throws(() => assertAnalysisBaseline([...a, ...a], a));
  assert.throws(() => assertAnalysisBaseline(['ERROR|RULE|a|broken'], []));
});
test('preflight and dry-run plan read without changing artifacts', async t => {
  const f = await fixture(t); const p = await preflight(f.options, f.runner);
  assert.equal(p.version, '1.0.16'); assert.equal(p.build, 36);
  assert.equal(futureMetadata(p).minimumSupportedVersion, '1.0.12');
  assert.equal(futureMetadata(p).forceUpdate, false); await f.assertOld();
});
for (const failure of ['auth', 'invalid-target', 'invalid-json', 'version-regression', 'signing-mismatch', 'missing-group']) {
  test(`preflight ${failure} preserves current release`, async t => {
    const f = await fixture(t);
    let runner = f.runner;
    if (failure === 'auth') runner = async (command, args) => { if (command === 'firebase' && args[0] === 'apps:list') throw new Error('Authentication failed'); return f.runner(command, args); };
    if (failure === 'invalid-target') await fs.appendFile(path.join(f.plan.backendDir, '.env'), '\nFIREBASE_APP_DISTRIBUTION_GROUPS=bad group');
    if (failure === 'invalid-json') await fs.writeFile(f.plan.metadataPath, '{broken');
    if (failure === 'version-regression') await fs.writeFile(path.join(f.plan.appDir, 'pubspec.yaml'), 'version: 1.0.14+14');
    if (failure === 'signing-mismatch') runner = async (command, args) => { if (path.basename(command) === 'apksigner') return { stdout: `certificate SHA-256 digest: ${'b'.repeat(64)}` }; return f.runner(command, args); };
    if (failure === 'missing-group') runner = async (command, args) => { if (command === 'firebase' && args[0] === 'appdistribution:groups:list') return { stdout: '{"status":"success","result":{"groups":[]}}' }; return f.runner(command, args); };
    await assert.rejects(preflight(f.options, runner));
    if (failure !== 'invalid-json') await f.assertOld(); else assert.equal(await fs.readFile(f.plan.metadataPath, 'utf8'), '{broken');
  });
}
for (const failure of ['build', 'distribution', 'copy', 'hash', 'symbol', 'json', 'activation-copy', 'activation-json', 'consistency']) {
  test(`${failure} failure leaves previous metadata/APK intact`, async t => {
    const f = await fixture(t);
    let runner = f.runner;
    let buildArtifact = async () => f.source;
    let beforeStage = async () => {};
    let activationHook;
    if (failure === 'build') buildArtifact = async () => { throw new Error('Build failed'); };
    if (failure === 'distribution') runner = async (command, args) => { if (args[0] === 'appdistribution:distribute') throw new Error('Distribution failed'); return f.runner(command, args); };
    if (failure === 'copy') beforeStage = async () => { await fs.rm(f.source); };
    if (failure === 'hash') runner = async (command, args) => { const result = await f.runner(command, args); if (args[0] === 'appdistribution:distribute') await fs.writeFile(args[1], 'corrupted'); return result; };
    if (failure === 'symbol') {
      f.plan.options.obfuscate = true;
      buildArtifact = async dir => { await fs.mkdir(path.join(dir, 'symbols')); await fs.writeFile(path.join(dir, 'symbols/app.android-arm64.symbols'), 'fresh fixture'); return f.source; };
      runner = async (command, args) => { if (args[0] === 'crashlytics:symbols:upload') throw new Error('Symbols failed'); return f.runner(command, args); };
    }
    if (failure === 'json') f.plan.options['minimum-supported'] = '9.0.0';
    if (failure.startsWith('activation-') || failure === 'consistency') activationHook = async phase => {
      if (phase === (failure === 'activation-copy' ? 'copy' : failure === 'activation-json' ? 'metadata' : 'consistency')) throw new Error('Activation failed');
    };
    await assert.rejects(publish(f.plan, { runner, buildArtifact, beforeStage, activationHook }));
    await f.assertOld();
  });
}
test('successful Firebase artifact equals backend bytes; deletes only matching obsolete APK', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.plan.apkDir, 'other_app.apk'), 'retain unrelated');
  const result = await publish(f.plan, { runner: f.runner, buildArtifact: async () => f.source });
  assert.deepEqual(await fs.readFile(f.plan.destination), f.distributed());
  assert.equal(await hashFile(f.plan.destination), result.metadata.sha256);
  assert.equal(result.metadata.fileSizeBytes, (await fs.stat(f.plan.destination)).size);
  assert.equal(result.metadata.latestBuildNumber, 36);
  assert.equal(await fs.access(f.plan.currentApk).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(f.plan.apkDir, 'other_app.apk'), 'utf8'), 'retain unrelated');
});
test('force metadata boundary equals latest; optional preserves current minimum', async t => {
  const f = await fixture(t);
  assert.equal(futureMetadata(f.plan).minimumSupportedVersion, '1.0.12');
  f.plan.options['force-update'] = true;
  assert.equal(futureMetadata(f.plan).minimumSupportedVersion, '1.0.16');
  assert.equal(futureMetadata(f.plan).forceUpdate, true);
});
test('durable recovery rolls back interrupted activation even after JSON switch', async t => {
  const f = await fixture(t);
  await fs.copyFile(f.source, f.plan.destination);
  await fs.writeFile(f.plan.metadataPath, JSON.stringify(futureMetadata(f.plan, { sha256: await hashFile(f.source), size: (await fs.stat(f.source)).size, publishedAt: new Date().toISOString() })));
  await fs.writeFile(path.join(f.plan.apkDir, '.staging/recovery.json'), JSON.stringify({ previous: f.original.toString('base64'), destination: f.plan.filename }));
  await recover(f.plan); await f.assertOld();
});

test('Firebase CLI text release output confirms version/build and safe links', () => {
 const output = '✔ uploaded new release 1.0.16 (36) successfully!\n✔ View this release in the Firebase console: https://console.firebase.google.com/project/test/releases/id\n✔ Share this release with testers who have access: https://appdistribution.firebase.google.com/release/id\nDownload the release binary (link expires in 1 hour): https://temporary.example.com/secret';
 const result = distributionResult(output);
 assert.equal(result.displayVersion, '1.0.16'); assert.equal(result.buildVersion, '36');
 assert.ok(result.testingUri.includes('appdistribution')); assert.ok(!JSON.stringify(result).includes('temporary'));
 assert.throws(() => distributionResult('unexpected output'));
});

test('metadata directory permission failure removes new APK and preserves original bytes', async t => {
  const f = await fixture(t);
  try {
    await assert.rejects(publish(f.plan, {runner:f.runner,buildArtifact:async()=>f.source,
      activationHook:async phase=>{if(phase==='copy')await fs.chmod(f.plan.backendDir,0o555);}}));
  } finally {await fs.chmod(f.plan.backendDir,0o755);}
  await f.assertOld();
});
