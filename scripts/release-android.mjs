#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('yaml');
const semver = require('semver');
const dotenv = require('dotenv');
const { readMetadata, validateMetadata, resolveApk } = require('../utils/appUpdateMetadata');
const defaultBackend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = async file => fs.access(file).then(() => true, () => false);
async function writableParent(directory) {
  let current = directory;
  while (!await has(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Release output parent unavailable');
    current = parent;
  }
  await fs.access(current, constants.W_OK);
}

export function parseArgs(args) {
  const options = {};
  const flags = new Set(['dry-run', 'force-update', 'clean', 'skip-tests', 'skip-firebase',
    'no-distribute', 'allow-empty-notes', 'allow-version-override', 'allow-signing-change', 'obfuscate', 'help']);
  const values = new Set(['notes', 'notes-file', 'minimum-supported', 'app-dir', 'backend-dir', 'split-debug-info']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !values.has(key)) || options[key] != null) throw new Error('Unknown or duplicate release option');
    if (flags.has(key)) options[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = args[++i];
    }
  }
  if (options.notes != null && options['notes-file'] != null) throw new Error('Choose --notes or --notes-file');
  if ((options.obfuscate || options['split-debug-info']) && (options['skip-firebase'] || options['no-distribute'])) throw new Error('Obfuscated releases require Firebase symbol upload');
  return options;
}

export async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export function validateTargets(env, skip) {
  const csv = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);
  const testers = [...new Set(csv(env.FIREBASE_APP_DISTRIBUTION_TESTERS))];
  const groups = [...new Set(csv(env.FIREBASE_APP_DISTRIBUTION_GROUPS))];
  if (testers.some(x => !/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(x))) throw new Error('Invalid Firebase tester email configuration');
  if (groups.some(x => !/^[a-zA-Z0-9_-]+$/.test(x))) throw new Error('Firebase groups must use aliases');
  if (!skip && !testers.length && !groups.length) throw new Error('Configure Firebase testers/groups, or explicitly use --skip-firebase');
  return { testers, groups };
}

export function distributionArgs(apk, env, targets, notesFile) {
  const args = ['appdistribution:distribute', apk, '--app', env.FIREBASE_ANDROID_APP_ID,
    '--project', env.FIREBASE_PROJECT_ID, '--release-notes-file', notesFile, '--non-interactive'];
  if (targets.testers.length) args.push('--testers', targets.testers.join(','));
  if (targets.groups.length) args.push('--groups', targets.groups.join(','));
  return args;
}

export function analysisFindings(output, appDir) {
  // Line/column movement is harmless; rule, source file, message and counts are compared.
  const findings = output.split(/\r?\n/).filter(line => /^(ERROR|WARNING|INFO)\|/.test(line)).map(line => {
    const fields = line.split('|');
    return [fields[0], fields[2], path.relative(appDir, fields[3]), ...fields.slice(7)].join('|');
  });
  return findings.sort();
}
export function assertAnalysisBaseline(current, baseline) {
  const counts = new Map();
  for (const value of baseline) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of current) {
    if (value.startsWith('ERROR|') || !counts.get(value)) throw new Error('Flutter analysis has a new finding; fix it before releasing');
    counts.set(value, counts.get(value) - 1);
  }
}

export async function run(command, args, { cwd, env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', () => reject(new Error(`${path.basename(command)} is unavailable`)));
    child.on('close', code => {
      if (code !== 0 && !allowFailure) reject(new Error(`${path.basename(command)} failed (exit ${code}); production APK/metadata retained`));
      else resolve({ code, stdout, stderr });
    });
  });
}
export function distributionResult(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.trim().startsWith('{')) return cliJson(clean);
  const version = clean.match(/(?:uploaded|re-uploaded)[^\r\n]*?release (\S+) \((\d+)\) successfully/);
  if (!version) throw new Error('Firebase upload succeeded but release version/build could not be confirmed');
  return { displayVersion: version[1], buildVersion: version[2],
    firebaseConsoleUri: clean.match(/View this release in the Firebase console: (https:\/\/\S+)/)?.[1],
    testingUri: clean.match(/Share this release with testers who have access: (https:\/\/\S+)/)?.[1] };
}
function cliJson(output) {
  // Firebase can print a banner before its JSON result.
  const start = output.indexOf('{');
  const result = JSON.parse(output.slice(start));
  if (result.status !== 'success') throw new Error('Firebase authentication/project access failed');
  return result.result;
}
function parseSigning(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s=:]+)\s*[=:]\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2].replace(/\\([:=\\ ])/g, '$1');
  }
  for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) if (!result[key]) throw new Error('Android key.properties is incomplete');
  return result;
}
async function androidTools(appDir, env) {
  let sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk && await has(path.join(appDir, 'android/local.properties'))) {
    const match = (await fs.readFile(path.join(appDir, 'android/local.properties'), 'utf8')).match(/^sdk.dir=(.+)$/m);
    sdk = match?.[1].replace(/\\([:\\ ])/g, '$1');
  }
  if (!sdk) sdk = path.join(os.homedir(), 'Library/Android/sdk');
  const versions = (await fs.readdir(path.join(sdk, 'build-tools'))).filter(x => semver.valid(x)).sort(semver.rcompare);
  for (const version of versions) {
    const directory = path.join(sdk, 'build-tools', version);
    if (await has(path.join(directory, 'apksigner')) && await has(path.join(directory, 'aapt'))) return {
      apksigner: path.join(directory, 'apksigner'), aapt: path.join(directory, 'aapt') };
  }
  throw new Error('Android SDK apksigner/aapt unavailable');
}
export async function inspectApk(file, tools, runner = run) {
  const verified = await runner(tools.apksigner, ['verify', '--print-certs', file]);
  const certificates = [...verified.stdout.matchAll(/certificate SHA-256 digest: ([a-f0-9]{64})/gi)].map(x => x[1].toLowerCase());
  if (certificates.length !== 1) throw new Error('APK must have exactly one verified signer');
  const badging = await runner(tools.aapt, ['dump', 'badging', file]);
  const match = badging.stdout.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
  if (!match) throw new Error('APK package/version validation failed');
  return { package: match[1], build: Number(match[2]), version: match[3], certificate: certificates[0] };
}

export function futureMetadata(plan, artifact = {}) {
  const minimum = plan.options['minimum-supported'] || (plan.options['force-update'] ? plan.version : plan.current.minimumSupportedVersion);
  const force = Boolean(plan.options['force-update']);
  return { ...plan.current, latestVersion: plan.version, latestBuildNumber: plan.build,
    minimumSupportedVersion: minimum, forceUpdate: force, apkFileName: plan.filename,
    apkUrl: `${plan.publicBase}/api/app/apk/${encodeURIComponent(plan.version)}`,
    updateUrl: '', releaseNotes: plan.notes, sha256: artifact.sha256 || '<computed after build>',
    fileSizeBytes: artifact.size || '<computed after build>', publishedAt: artifact.publishedAt || '<activation time>',
    signingCertificateSha256: plan.signingCertificate,
    signingMigration: plan.signingChanged };
}

export async function preflight(options, runner = run) {
  const backendDir = await fs.realpath(path.resolve(options['backend-dir'] || defaultBackend));
  const appDir = await fs.realpath(path.resolve(options['app-dir'] || path.join(backendDir, '..', 'TerraCart-AdminApp')));
  const dotenvPath = path.join(backendDir, '.env');
  const env = { ...dotenv.parse(await fs.readFile(dotenvPath)), ...process.env };
  const skip = Boolean(options['skip-firebase'] || options['no-distribute']);
  const targets = validateTargets(env, skip);
  const pubspec = YAML.parse(await fs.readFile(path.join(appDir, 'pubspec.yaml'), 'utf8'));
  const versionMatch = String(pubspec.version || '').match(/^(.+)\+([1-9]\d*)$/);
  if (!versionMatch || !semver.valid(versionMatch[1]) || versionMatch[1].includes('+')) throw new Error('pubspec requires semantic version+positive build');
  const version = versionMatch[1], build = Number(versionMatch[2]);
  if (!Number.isSafeInteger(build) || build > 2100000000) throw new Error('Android build number invalid');
  const metadataPath = path.join(backendDir, 'app-update.json');
  const apkDir = path.join(backendDir, 'apk');
  const current = readMetadata(metadataPath);
  const currentApk = resolveApk(apkDir, current);
  if (await hashFile(currentApk) !== current.sha256) throw new Error('Current backend APK checksum differs from metadata');
  await fs.access(backendDir, constants.W_OK); await fs.access(apkDir, constants.W_OK);
  await fs.access(metadataPath, constants.R_OK | constants.W_OK); await fs.access(appDir, constants.W_OK);
  await writableParent(path.join(appDir, 'build/app/outputs/flutter-apk'));
  await writableParent(path.join(apkDir, '.staging'));
  const publicBase = String(env.API_PUBLIC_BASE_URL || env.APP_API_BASE_URL || env.API_BASE_URL || '').replace(/\/+$/, '');
  const origin = new URL(publicBase);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('API_PUBLIC_BASE_URL requires a public HTTPS origin');
  const prefix = env.APP_UPDATE_APK_PREFIX || 'terracart';
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('APK prefix invalid');
  const filename = `${prefix}_v${version}_b${build}.apk`;
  const destination = path.join(apkDir, filename);
  if (await has(destination)) throw new Error('Release filename already exists; increase version/build');
  const notes = (options.notes ?? (options['notes-file'] ? await fs.readFile(path.resolve(options['notes-file']), 'utf8') : '')).replace(/\\n/g, '\n');
  if (!notes.trim() && !options['allow-empty-notes']) throw new Error('Release notes are required (--notes or --notes-file)');
  const minimum = options['minimum-supported'] || (options['force-update'] ? version : current.minimumSupportedVersion);
  if (!semver.valid(minimum) || semver.gt(minimum, version)) throw new Error('Minimum supported version must not exceed latest');
  if (options['force-update'] && minimum !== version) throw new Error('--force-update requires minimum supported = latest for older clients');
  const tools = await androidTools(appDir, env);
  const published = await inspectApk(currentApk, tools, runner);
  if (published.version !== current.latestVersion || (current.latestBuildNumber != null && published.build !== current.latestBuildNumber)) throw new Error('Current backend APK version/build disagrees with metadata');
  if (!options['allow-version-override'] && (semver.lt(version, current.latestVersion) || build <= published.build || (semver.eq(version, current.latestVersion) && build <= published.build))) {
    throw new Error('Release must advance version or same-version build, and always advance Android build');
  }
  const google = JSON.parse(await fs.readFile(path.join(appDir, 'android/app/google-services.json'), 'utf8'));
  const gradle = await fs.readFile(path.join(appDir, 'android/app/build.gradle'), 'utf8');
  const packageName = gradle.match(/applicationId\s*(?:=\s*)?["']([^"']+)["']/)?.[1];
  const client = google.client?.find(x => x.client_info.android_client_info?.package_name === packageName);
  if (!client || published.package !== packageName) throw new Error('Android/Firebase/published APK package mismatch');
  if (env.FIREBASE_ANDROID_APP_ID !== client.client_info.mobilesdk_app_id || env.FIREBASE_PROJECT_ID !== google.project_info.project_id) throw new Error('Firebase Android App ID/project mismatch');
  const signing = parseSigning(await fs.readFile(path.join(appDir, 'android/key.properties'), 'utf8').catch(() => { throw new Error('Missing android/key.properties: configure existing release signing material'); }));
  const storeFile = path.resolve(appDir, 'android', signing.storeFile);
  await fs.access(storeFile, constants.R_OK);
  const signingOutput = await runner('keytool', ['-list', '-rfc', '-keystore', storeFile, '-alias', signing.keyAlias,
    '-storepass:env', 'TERRACART_SIGNING_PASSWORD'], { env: { ...env, TERRACART_SIGNING_PASSWORD: signing.storePassword } });
  const pem = signingOutput.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!pem) throw new Error('Signing certificate unavailable');
  const signingCertificate = new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  const signingChanged = signingCertificate !== published.certificate;
  if (signingChanged && !options['allow-signing-change']) throw new Error('Signing certificate differs from installed release. Recover original key or explicitly use --allow-signing-change for an uninstall/reinstall migration');
  for (const [command, args] of [['node', ['--version']], ['flutter', ['--version']], ['dart', ['--version']], ['firebase', ['--version']]]) await runner(command, args, { env });
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (!path.isAbsolute(env.GOOGLE_APPLICATION_CREDENTIALS)) throw new Error('GOOGLE_APPLICATION_CREDENTIALS must be an absolute path outside repositories');
    const credentials = await fs.realpath(env.GOOGLE_APPLICATION_CREDENTIALS);
    for (const repo of [appDir, backendDir]) if (credentials === repo || credentials.startsWith(repo + path.sep)) throw new Error('Service-account JSON must be outside repositories');
    env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
  }
  if (!skip) {
    const apps = cliJson((await runner('firebase', ['apps:list', 'android', '--project', env.FIREBASE_PROJECT_ID, '--json', '--non-interactive'], { cwd: backendDir, env })).stdout);
    if (!Array.isArray(apps) || !apps.some(x => x.appId === env.FIREBASE_ANDROID_APP_ID)) throw new Error('Firebase Android app access not verified');
    if (targets.groups.length) {
      const data = cliJson((await runner('firebase', ['appdistribution:groups:list', '--project', env.FIREBASE_PROJECT_ID, '--json', '--non-interactive'], { cwd: backendDir, env })).stdout);
      const groups = Array.isArray(data) ? data : data?.groups || [];
      const aliases = new Set(groups.map(x => x.name?.split('/').at(-1)));
      if (targets.groups.some(x => !aliases.has(x))) throw new Error('Configured Firebase group alias does not exist in the project');
    }
  }
  return { options, appDir, backendDir, env, targets, skip, version, build, current, currentApk,
    metadataPath, apkDir, filename, destination, publicBase, notes, tools, packageName,
    signingCertificate, signingChanged, sourceApk: path.join(appDir, 'build/app/outputs/flutter-apk/app-release.apk') };
}

async function atomicJson(file, value) {
  return atomicBytes(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}
async function atomicBytes(file, bytes) {
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function activate(plan, staged, metadata, { hook = async () => {} } = {}) {
  // Old artifact remains present while JSON is atomically replaced. Recovery state
  // is durable so the next release can roll back an interrupted activation.
  const previous = await fs.readFile(plan.metadataPath);
  const journal = path.join(plan.apkDir, '.staging/recovery.json');
  await atomicJson(journal, { previous: previous.toString('base64'), destination: plan.filename });
  let added = false;
  try {
    await fs.copyFile(staged, plan.destination, constants.COPYFILE_EXCL);
    added = true;
    await hook('copy');
    if (await hashFile(plan.destination) !== metadata.sha256) throw new Error('Activated APK checksum mismatch');
    await atomicJson(plan.metadataPath, validateMetadata(metadata));
    await hook('metadata');
    const actual = readMetadata(plan.metadataPath);
    if (actual.latestVersion !== plan.version || actual.latestBuildNumber !== plan.build || actual.apkFileName !== plan.filename ||
        await hashFile(resolveApk(plan.apkDir, actual)) !== actual.sha256 || (await fs.stat(plan.destination)).size !== actual.fileSizeBytes) throw new Error('Final release consistency check failed');
    await hook('consistency');
    await fs.rm(journal); // Commit marker. Cleanup never changes the active release.
  } catch (error) {
    const onDisk = await fs.readFile(plan.metadataPath).catch(() => null);
    // A failed atomic write often leaves the original JSON untouched. Avoid a
    // second write that could fail for the same disk/permission reason.
    if (!onDisk || !onDisk.equals(previous)) await atomicBytes(plan.metadataPath, previous);
    if (added) await fs.rm(plan.destination, { force: true });
    await fs.rm(journal, { force: true });
    throw error;
  }
}
export async function recover(plan) {
  const journal = path.join(plan.apkDir, '.staging/recovery.json');
  if (!await has(journal)) return;
  const data = JSON.parse(await fs.readFile(journal, 'utf8'));
  if (typeof data.destination !== 'string' || path.basename(data.destination) !== data.destination) throw new Error('Recovery journal invalid; active files retained');
  const previous = validateMetadata(JSON.parse(Buffer.from(data.previous, 'base64').toString().replace(/^\uFEFF/, '')));
  if (await hashFile(resolveApk(plan.apkDir, previous)) !== previous.sha256) throw new Error('Recovery APK unavailable; files retained');
  if (previous.apkFileName === data.destination) throw new Error('Recovery journal targets original release');
  await atomicBytes(plan.metadataPath, Buffer.from(data.previous, 'base64'));
  await fs.rm(path.join(plan.apkDir, data.destination), { force: true });
  await fs.rm(journal);
}

export async function publish(plan, { runner = run, buildArtifact, beforeStage = async () => {}, activationHook } = {}) {
  const stageDir = await fs.mkdtemp(path.join(plan.apkDir, '.staging/release-'));
  let firebaseResult = null;
  try {
    const source = await buildArtifact(stageDir);
    const artifact = await inspectApk(source, plan.tools, runner);
    if (artifact.package !== plan.packageName || artifact.version !== plan.version || artifact.build !== plan.build || artifact.certificate !== plan.signingCertificate) throw new Error('Built APK package/version/build/signature mismatch');
    const size = (await fs.stat(source)).size;
    if (!size) throw new Error('APK is empty');
    const sha256 = await hashFile(source);
    const staged = path.join(stageDir, plan.filename);
    await beforeStage();
    await fs.copyFile(source, staged, constants.COPYFILE_EXCL);
    if (await hashFile(staged) !== sha256) throw new Error('Staged APK checksum mismatch');
    const notesFile = path.join(stageDir, 'release-notes.txt');
    await fs.writeFile(notesFile, plan.notes);
    if (!plan.skip) {
      console.log('Distributing the validated APK to Firebase...');
      firebaseResult = distributionResult((await runner('firebase', distributionArgs(staged, plan.env, plan.targets, notesFile), { cwd: plan.backendDir, env: plan.env })).stdout);
      const release = firebaseResult?.release || firebaseResult;
      if (release?.displayVersion !== plan.version || Number(release?.buildVersion) !== plan.build) throw new Error('Firebase release version/build not verified');
      if (plan.options.obfuscate || plan.options['split-debug-info']) {
        const symbols = path.join(stageDir, 'symbols');
        const entries = await fs.readdir(symbols);
        if (!entries.some(x => x.endsWith('.symbols'))) throw new Error('Fresh Flutter symbols missing');
        await runner('firebase', ['crashlytics:symbols:upload', '--app', plan.env.FIREBASE_ANDROID_APP_ID, symbols, '--non-interactive'], { env: plan.env });
      }
    } else if (plan.options['split-debug-info']) throw new Error('Split debug info requires symbol upload; Firebase cannot be skipped');
    if (await hashFile(staged) !== sha256 || await hashFile(source) !== sha256) throw new Error('Artifact changed after Firebase distribution');
    // Detect a metadata edit during a long build/upload; never overwrite it.
    const now = readMetadata(plan.metadataPath);
    if (JSON.stringify(now) !== JSON.stringify(plan.current)) throw new Error('Backend metadata changed during release; active files retained');
    // Keep a restorable local snapshot outside the served APK directory.
    const rollbackRoot = path.join(plan.apkDir, '.staging/rollback');
    await fs.mkdir(rollbackRoot, { recursive: true });
    const rollbackDir = await fs.mkdtemp(path.join(rollbackRoot, 'release-'));
    await fs.copyFile(plan.currentApk, path.join(rollbackDir, plan.current.apkFileName));
    await fs.copyFile(plan.metadataPath, path.join(rollbackDir, 'app-update.json'));
    if (await hashFile(path.join(rollbackDir, plan.current.apkFileName)) !== plan.current.sha256) {
      throw new Error('Rollback APK checksum validation failed');
    }
    const metadata = validateMetadata(futureMetadata(plan, { sha256, size, publishedAt: new Date().toISOString() }));
    await activate(plan, staged, metadata, { hook: activationHook });
    // Delete only obsolete files belonging to TerraCart, after commit. Failures warn.
    const escapedPrefix = (plan.env.APP_UPDATE_APK_PREFIX || 'terracart').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const obsoletePattern = new RegExp(`^(?:${escapedPrefix}|terracart_admin)_v\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?(?:_b\\d+)?\\.apk$`);
    for (const entry of await fs.readdir(plan.apkDir, { withFileTypes: true })) {
      if (entry.isFile() && obsoletePattern.test(entry.name) && entry.name !== plan.filename) {
        try { await fs.rm(path.join(plan.apkDir, entry.name)); } catch (_) { console.warn('Obsolete TerraCart APK cleanup deferred; active release is valid.'); }
      }
    }
    const release = firebaseResult?.release || firebaseResult;
    console.log(JSON.stringify({ status: 'TERRACART ANDROID RELEASE SUCCESSFUL', version: plan.version, build: plan.build,
      apk: plan.filename, bytes: size, sha256, minimumSupportedVersion: metadata.minimumSupportedVersion, forceUpdate: metadata.forceUpdate,
      backendApk: plan.destination, metadata: plan.metadataPath, firebaseAppId: plan.env.FIREBASE_ANDROID_APP_ID,
      testerCount: plan.targets.testers.length, groups: plan.targets.groups,
      firebaseDistribution: plan.skip ? 'EXPLICITLY SKIPPED' : 'SUCCESS',
      firebaseConsoleUrl: release?.firebaseConsoleUri, testerUrl: release?.testingUri,
      crashlyticsSymbols: plan.options.obfuscate || plan.options['split-debug-info'] ? 'SUCCESS' : 'NOT REQUIRED',
      signingMigration: plan.signingChanged, backendValidation: 'SUCCESS' }, null, 2));
    return { metadata, firebaseResult };
  } catch (error) {
    if (firebaseResult) console.warn('Firebase may retain the uploaded release; local activation failed or rolled back.');
    throw error;
  } finally {
    try { await fs.rm(stageDir, { recursive: true, force: true }); }
    catch (_) { console.warn('Release staging cleanup deferred; active files retained.'); }
  }
}

async function build(plan, stageDir) {
  const invoke = async (command, args, allowFailure = false) => run(command, args, { cwd: plan.appDir, env: plan.env, allowFailure });
  if (plan.options.clean) { console.log('Cleaning Flutter output (explicit --clean)...'); await invoke('flutter', ['clean']); }
  console.log('Resolving Flutter dependencies...'); await invoke('flutter', ['pub', 'get']);
  console.log('Checking Flutter analysis baseline...');
  await invoke('flutter', ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings']);
  // Machine output retains exact messages without Flutter's appended fix suggestions.
  const analysis = await invoke('dart', ['analyze', '--format=machine'], true);
  const findings = analysisFindings(analysis.stdout + analysis.stderr, plan.appDir);
  const baseline = JSON.parse(await fs.readFile(path.join(plan.appDir, 'tool/android-release-analysis-baseline.json'), 'utf8'));
  if (analysis.code && !findings.length) throw new Error('Flutter analysis failed without usable diagnostics');
  assertAnalysisBaseline(findings, baseline);
  console.log(`Flutter analysis: ${findings.length} existing findings; no new findings or errors.`);
  if (!plan.options['skip-tests']) {
    console.log('Running Flutter tests...');
    const tests = await invoke('flutter', ['test']);
    const cleanOutput = tests.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const passed = [...cleanOutput.matchAll(/\+(\d+)[^\r\n]*All tests passed!/g)].at(-1)?.[1];
    console.log(`Flutter tests: ${passed ? `${passed} passed` : 'passed'}.`);
  }
  else console.warn('Flutter tests explicitly skipped (--skip-tests).');
  // Remove only canonical build output to eliminate accidental reuse after a failed build.
  await fs.rm(plan.sourceApk, { force: true });
  const args = ['build', 'apk', '--release', '--dart-define=USE_PROD_API=true'];
  if (plan.options.obfuscate || plan.options['split-debug-info']) {
    // Caller can request symbols, but every release uses a new empty staging directory.
    args.push(`--split-debug-info=${path.join(stageDir, 'symbols')}`);
    if (plan.options.obfuscate) args.push('--obfuscate');
  }
  console.log('Building one signed release APK...'); await invoke('flutter', args);
  if (!await has(plan.sourceApk)) throw new Error('Flutter did not produce the canonical release APK');
  return plan.sourceApk;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('TerraCart: release-android.sh --notes "Release notes" [--dry-run] [--force-update] [--minimum-supported VERSION] [--clean] [--skip-tests] [--skip-firebase] [--obfuscate] [--split-debug-info auto] [--allow-signing-change] [--allow-version-override] [--app-dir PATH] [--backend-dir PATH]'); return;
  }
  console.log('Checking release prerequisites...');
  if (options['dry-run']) {
    const plan = await preflight(options);
    console.log(JSON.stringify({ dryRun: true, version: plan.version, build: plan.build,
      sourceApk: plan.sourceApk, backendDestination: plan.destination, currentMetadata: plan.current,
      futureMetadata: futureMetadata(plan), firebaseAppId: plan.env.FIREBASE_ANDROID_APP_ID,
      testerCount: plan.targets.testers.length, groups: plan.targets.groups,
      notesSource: options['notes-file'] ? path.resolve(options['notes-file']) : options.notes != null ? 'inline' : 'explicitly empty',
      signingMigration: plan.signingChanged, firebaseDistribution: plan.skip ? 'EXPLICITLY SKIPPED' : 'PLANNED' }, null, 2)); return;
  }
  const backendDir = path.resolve(options['backend-dir'] || defaultBackend);
  const apkDir = path.join(backendDir, 'apk');
  const lockPath = path.join(apkDir, '.release-lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (_) { throw new Error('Release lock exists. Check for a running process; see recovery instructions before removing a stale lock'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await fs.mkdir(path.join(apkDir, '.staging'), { recursive: true });
    await recover({ apkDir, metadataPath: path.join(backendDir, 'app-update.json') });
    const plan = await preflight(options);
    await publish(plan, { buildArtifact: stageDir => build(plan, stageDir) });
  } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`RELEASE FAILED: ${error.message}`); process.exitCode = 1; });
}
