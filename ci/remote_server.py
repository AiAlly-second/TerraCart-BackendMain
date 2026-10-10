#!/usr/bin/env python3
"""Server-side deployment guard. No database clients, migrations or cleanup."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import time
from urllib.parse import urlsplit
from urllib.request import urlopen
import uuid
from artifact import digest, extract, verify, assert_public_origin

PERSISTENT = ['.env', 'uploads', 'apk', 'logs', 'backups', 'app-update.json']
BACKEND_REPOSITORY = 'AiAlly-second/TerraCart-BackendMain'
MOBILE_REPOSITORY = 'AiAlly-second/TerraCart-AdminApp'
RUNTIME = {'server.js', 'package.json', 'package-lock.json', 'ecosystem.config.js',
           'config', 'data', 'controllers', 'logging', 'middleware', 'models', 'routes', 'services', 'utils'}


class DeploymentRefusal(ValueError):
    """Messages in this class contain only explicit guard reasons, never runtime output."""
    pass


def execute(args, *, cwd=None, install=False):
    env = None
    if install:
        env = {k: v for k, v in os.environ.items() if k in {'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'}}
        env['NODE_ENV'] = 'production'
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, check=False)
    if result.returncode:
        # PM2 output may contain production environment values; never print it.
        raise DeploymentRefusal(f'{args[0]} operation failed; inspect server logs privately')
    return result.stdout


def layout(root, allow_recovery=False):
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root or len(root.parts) < 4:
        raise DeploymentRefusal('Canonical explicit application root is required; no fallback path')
    marker = root / '.ci-deploy.json'
    if not marker.is_file() or marker.is_symlink() or marker.stat().st_mode & 0o022:
        raise DeploymentRefusal('Operator-owned deployment-layout marker is missing or writable by others')
    config = json.loads(marker.read_text())
    if config.get('schema') != 1 or config.get('root') != str(root) or config.get('node') != '22.23.3':
        raise DeploymentRefusal('Deployment layout/runtime marker mismatch')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', config.get('process', '')) or config['process'] == 'all':
        raise DeploymentRefusal('Exact TerraCart PM2 process is required')
    for name in ['releases', 'shared', '.ci', '.ci/incoming']:
        path = root / name
        if not path.is_dir() or path.is_symlink() or path.resolve() != path:
            raise DeploymentRefusal('Prepared deployment directories required; pipeline will not initialize/migrate them')
    for name in PERSISTENT:
        path = root / 'shared' / name
        expected_file = name in {'.env', 'app-update.json'}
        if path.is_symlink() or not (path.is_file() if expected_file else path.is_dir()):
            raise DeploymentRefusal(f'Existing shared {name} is required; storage is never replaced')
    lock = root / '.ci/production.lock'
    if not lock.is_file() or lock.is_symlink():
        raise DeploymentRefusal('Prepared server deployment lock required')
    if (root / 'shared/apk/.release-lock').exists():
        raise DeploymentRefusal('Existing Android release is active; deployment refused')
    if not allow_recovery and (root / '.ci/mobile-recovery.json').exists():
        raise DeploymentRefusal('Unfinished mobile activation journal requires operator recovery')
    current = root / 'current'
    target = current.resolve(strict=True)
    if not current.is_symlink() or target.parent != root / 'releases':
        raise DeploymentRefusal('Existing compatible current-release symlink is required')
    for name in PERSISTENT:
        path = target / name
        if not path.is_symlink() or path.resolve() != root / 'shared' / name:
            raise DeploymentRefusal('Active release must use the verified shared persistent paths')
    health = urlsplit(config.get('health_url', ''))
    if health.scheme != 'http' or health.hostname != '127.0.0.1' or health.path != '/health' or health.query or health.fragment or health.username:
        raise DeploymentRefusal('Existing loopback /health URL is required')
    if execute(['node', '--version']).strip() != 'v' + config['node']:
        raise DeploymentRefusal('Server Node runtime must match the tested artifact runtime')
    processes = json.loads(execute(['pm2', 'jlist']))
    rows = [item for item in processes if item.get('name') == config['process']]
    if len(rows) != 1:
        raise DeploymentRefusal('Expected exactly one configured TerraCart PM2 process; topology needs operator verification')
    environment = rows[0]['pm2_env']
    if environment.get('node_version') != config['node'] or environment.get('exec_mode') != 'fork_mode':
        raise DeploymentRefusal('Existing PM2 process must already use the pinned Node runtime and verified single-process fork topology')
    if (environment.get('pm_cwd') != str(current)
            or environment.get('pm_exec_path') != str(current / 'server.js')):
        raise DeploymentRefusal('PM2 must already follow current/server.js; pinned old/flat paths are incompatible')
    return config, target


@contextmanager
def locked(root):
    with (Path(root) / '.ci/production.lock').open('rb') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentRefusal('Another backend/mobile deployment holds the server lock')
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def health(url):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=4) as response:
                body = json.load(response)
            if body.get('status') == 'healthy' or (
                body.get('status') == 'degraded'
                and body.get('mongo', {}).get('ready') is True
                and body.get('redis', {}).get('configured') is True
                and body.get('redis', {}).get('required') is False
                and body.get('shuttingDown') is False
            ):
                return
        except Exception:
            pass
        time.sleep(2)
    raise DeploymentRefusal('Read-only readiness check failed')


def switch(root, destination):
    destination = Path(destination).resolve(strict=True)
    if destination.parent != Path(root) / 'releases':
        raise DeploymentRefusal('Release switch outside verified release directory is forbidden')
    temporary = Path(root) / '.ci' / ('current-' + uuid.uuid4().hex)
    temporary.symlink_to(destination)
    os.replace(temporary, Path(root) / 'current')


def retained_release(root, commit):
    release = Path(root) / 'releases' / commit
    if release.is_symlink() or release.resolve() != release or not release.is_dir():
        raise DeploymentRefusal('Rollback requires a retained physical release directory')
    manifest = json.loads((release / 'artifact-manifest.json').read_text())
    if manifest.get('repository') != BACKEND_REPOSITORY or manifest.get('commit') != commit or manifest.get('kind') != 'backend' or manifest.get('environment') != 'production':
        raise DeploymentRefusal('Previous installed release provenance mismatch')
    for name, checksum in manifest['files'].items():
        path = release / name
        if PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts or path.is_symlink() or digest(path) != checksum:
            raise DeploymentRefusal('Previous installed release integrity mismatch')
    for name in PERSISTENT:
        if not (release / name).is_symlink() or (release / name).resolve() != Path(root) / 'shared' / name:
            raise DeploymentRefusal('Rollback persistent mapping mismatch')
    return release


def deploy_backend(root, bundle, commit, dry_run=True, rollback=False):
    config, previous = layout(root)
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise DeploymentRefusal('Full artifact commit SHA is required')
    release = Path(root) / 'releases' / commit
    if rollback:
        retained_release(root, commit)
    elif release.exists():
        raise DeploymentRefusal('Release destination already exists; operator review required, no overwrite/cleanup')
    if dry_run:
        health(config['health_url'])
        print('DRY RUN: verified existing PM2/layout/health; no application, storage or DB writes')
        return
    bundle = Path(bundle)
    if bundle.parent != Path(root) / '.ci/incoming' or bundle.is_symlink():
        raise DeploymentRefusal('Bundle must be a regular file in the prepared incoming directory')
    with locked(root):
        # Repeat guards after locking so a concurrent deployment cannot change baseline.
        config, previous = layout(root)
        if rollback:
            retained_release(root, commit)
        else:
            if release.exists():
                raise DeploymentRefusal('Release destination already exists; operator review required, no overwrite/cleanup')
            extract(bundle, release)
            manifest = verify(release, BACKEND_REPOSITORY, commit, 'backend')
            if any(PurePosixPath(name).parts[0] not in RUNTIME for name in manifest['files']):
                raise DeploymentRefusal('Backend bundle contains disallowed state/scripts')
            for name in PERSISTENT:
                (release / name).symlink_to(Path(root) / 'shared' / name)
            execute(['npm', 'ci', '--omit=dev', '--ignore-scripts'], cwd=release, install=True)
            execute(['node', '--check', str(release / 'server.js')], cwd=release, install=True)
        switch(root, release)
        try:
            execute(['pm2', 'reload', config['process']])
            health(config['health_url'])
        except Exception:
            switch(root, previous)
            execute(['pm2', 'reload', config['process']])
            health(config['health_url'])
            raise DeploymentRefusal('Deployment failed; previous application release restored; database untouched')
    print('Application release verified; persistent state preserved; no database commands executed')


def snapshot(root):
    layout(root)
    path = Path(root) / 'shared/app-update.json'
    raw = path.read_bytes()
    data = json.loads(raw)
    name = data.get('apkFileName') or f'terracart_admin_v{data["latestVersion"]}.apk'
    if Path(name).name != name or not re.fullmatch(r'[a-zA-Z0-9_.-]+\.apk', name):
        raise DeploymentRefusal('Current APK filename invalid')
    apk = Path(root) / 'shared/apk' / name
    if not apk.is_file() or apk.is_symlink() or digest(apk) != data.get('sha256'):
        raise DeploymentRefusal('Existing APK/metadata consistency failed')
    return {'metadata': data, 'metadata_sha256': hashlib.sha256(raw).hexdigest(), 'apk_filename': name,
            'apk_sha256': digest(apk), 'apk_bytes': apk.stat().st_size}


def atomic_bytes(path, data):
    temporary = path.with_name(path.name + '.ci-' + uuid.uuid4().hex)
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    with open_directory(path.parent) as directory:
        os.fsync(directory)


@contextmanager
def open_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def mobile_smoke(origin, metadata):
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or parsed.username or parsed.query or parsed.path not in {'', '/'}:
        raise DeploymentRefusal('Configured public API origin is required for read-only release verification')
    origin = origin.rstrip('/')
    with urlopen(origin + '/api/app/update', timeout=20) as response:
        data = json.load(response)
    data = data.get('data', data)
    if data.get('sha256') != metadata['sha256'] or data.get('latestVersion') != metadata['latestVersion']:
        raise DeploymentRefusal('Served update metadata differs from activated artifact')
    value = hashlib.sha256()
    with urlopen(origin + '/api/app/apk/' + metadata['latestVersion'], timeout=60) as response:
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            value.update(chunk)
    if value.hexdigest() != metadata['sha256']:
        raise DeploymentRefusal('Served APK differs from the Firebase/activated artifact')


def publish_mobile(root, bundle, commit):
    if not re.fullmatch(r'[a-f0-9]{40}', commit or ''):
        raise DeploymentRefusal('Full mobile artifact commit SHA is required')
    config, _ = layout(root)
    bundle = Path(bundle)
    if bundle.parent != Path(root) / '.ci/incoming' or bundle.is_symlink():
        raise DeploymentRefusal('Mobile bundle outside prepared incoming directory')
    stage = Path(root) / '.ci' / ('mobile-' + uuid.uuid4().hex)
    with locked(root):
        layout(root)
        extract(bundle, stage)
        manifest = verify(stage, MOBILE_REPOSITORY, commit, 'mobile-release')
        if set(manifest['files']) != {'release.apk', 'app-update.json', 'release-checks.json'}:
            raise DeploymentRefusal('Unexpected mobile bundle contents')
        current = snapshot(root)
        checks = json.loads((stage / 'release-checks.json').read_text())
        if checks['previous_metadata_sha256'] != current['metadata_sha256'] or checks['firebase_confirmed'] is not True:
            raise DeploymentRefusal('Release baseline changed or Firebase distribution was not confirmed')
        metadata = json.loads((stage / 'app-update.json').read_text())
        origin = assert_public_origin(config.get('public_api_origin', ''))
        if metadata.get('apkUrl') != origin + '/api/app/apk/' + metadata['latestVersion']:
            raise DeploymentRefusal('Mobile release API origin differs from the verified server origin')
        name = metadata['apkFileName']
        if Path(name).name != name or not re.fullmatch(r'terracart_v[0-9A-Za-z_.-]+_b[1-9]\d*\.apk', name):
            raise DeploymentRefusal('New versioned APK filename invalid')
        if digest(stage / 'release.apk') != metadata['sha256'] or (stage / 'release.apk').stat().st_size != metadata['fileSizeBytes']:
            raise DeploymentRefusal('New APK/metadata integrity mismatch')
        if metadata['latestBuildNumber'] <= current['metadata'].get('latestBuildNumber', 0):
            raise DeploymentRefusal('Android build must advance')
        def version(value):
            if not re.fullmatch(r'\d+\.\d+\.\d+', value):
                raise DeploymentRefusal('Stable three-part release version required')
            return tuple(map(int, value.split('.')))
        if version(metadata['latestVersion']) <= version(current['metadata']['latestVersion']):
            raise DeploymentRefusal('Release version must deliberately advance')
        destination = Path(root) / 'shared/apk' / name
        metadata_path = Path(root) / 'shared/app-update.json'
        previous = metadata_path.read_bytes()
        journal = Path(root) / '.ci/mobile-recovery.json'
        with destination.open('xb') as output, (stage / 'release.apk').open('rb') as source:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
        if digest(destination) != metadata['sha256'] or digest(metadata_path) != current['metadata_sha256']:
            raise DeploymentRefusal('Concurrent metadata edit or APK copy failure; existing release retained')
        atomic_bytes(journal, json.dumps({'previous_metadata': current['metadata'],
                     'activated_metadata_sha256': digest(stage / 'app-update.json')}).encode())
        try:
            atomic_bytes(metadata_path, (stage / 'app-update.json').read_bytes())
            if digest(metadata_path) != digest(stage / 'app-update.json') or digest(destination) != metadata['sha256']:
                raise DeploymentRefusal('Activated release consistency check failed')
            mobile_smoke(config.get('public_api_origin', ''), metadata)
        except Exception:
            atomic_bytes(metadata_path, previous)
            journal.unlink()  # Only this transaction's control journal; APK history remains.
            raise
        journal.unlink()
    print('Exact Firebase APK activated; old APKs and all shared storage retained; no database access')


def recover_mobile(root, apply=False):
    layout(root, allow_recovery=True)
    with locked(root):
        path = Path(root) / 'shared/app-update.json'
        journal = Path(root) / '.ci/mobile-recovery.json'
        if not journal.is_file() or journal.is_symlink():
            raise DeploymentRefusal('No valid unfinished transaction journal exists')
        data = json.loads(journal.read_text())
        previous = data['previous_metadata']
        apk = Path(root) / 'shared/apk' / previous['apkFileName']
        if apk.parent != Path(root) / 'shared/apk' or apk.is_symlink() or digest(apk) != previous['sha256']:
            raise DeploymentRefusal('Retained previous APK cannot be verified')
        now = json.loads(path.read_text())
        if digest(path) != data['activated_metadata_sha256'] and now != previous:
            raise DeploymentRefusal('Metadata edited outside this transaction; recovery refused')
        if not apply:
            print('DRY RUN: journal and retained previous APK verified; no metadata changes')
            return
        atomic_bytes(path, (json.dumps(previous, indent=2) + '\n').encode())
        journal.unlink()  # Only the verified CI transaction journal; never APK data.
        print('Previous metadata restored; both APKs retained; no database access')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--mode', choices=['backend', 'snapshot', 'mobile', 'recover-mobile'], required=True)
    parser.add_argument('--bundle')
    parser.add_argument('--commit')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if args.mode == 'snapshot':
        print(json.dumps(snapshot(args.root)))
    elif args.mode == 'recover-mobile':
        recover_mobile(args.root, args.apply)
    elif args.mode == 'backend':
        deploy_backend(args.root, args.bundle, args.commit, not args.apply, args.rollback)
    elif not args.apply:
        layout(args.root)
        print('DRY RUN: mobile storage/layout verified; no release activation')
    else:
        publish_mobile(args.root, args.bundle, args.commit)
