import json
import ast
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import artifact
import remote_server as server
import remote
import subprocess

SHA = 'a' * 40


class Readiness(unittest.TestCase):
    def test_only_explicitly_optional_redis_degradation_is_ready(self):
        import io
        optional = dict(status='degraded', mongo={'ready': True}, redis={'configured': True, 'required': False}, shuttingDown=False)
        with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(optional).encode())):
            server.health('http://127.0.0.1/health')
        for changes in [{'shuttingDown': True}, {'redis': {'configured': True, 'required': True}}, {'mongo': {'ready': False}}]:
            body = {**optional, **changes}
            with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(body).encode())), patch.object(server.time, 'monotonic', side_effect=[0, 0, 121]), patch.object(server.time, 'sleep'):
                with self.assertRaises(server.DeploymentRefusal):
                    server.health('http://127.0.0.1/health')


class PersistentDeployment(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / 'application'
        self.root.mkdir()
        for name in ['releases', 'shared', '.ci/incoming', 'shared/uploads', 'shared/apk', 'shared/logs', 'shared/backups']:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        (self.root / 'shared/.env').write_text('test-only fixture: never read by deployment')
        (self.root / '.ci/production.lock').touch()
        self.old = self.root / 'releases' / ('b' * 40)
        self.old.mkdir()
        (self.old / 'server.js').write_text('old application')
        artifact.write_manifest(self.old, kind='backend', repository=server.BACKEND_REPOSITORY,
                                commit='b' * 40, environment='production')
        for name in server.PERSISTENT:
            (self.old / name).symlink_to(self.root / 'shared' / name)
        (self.root / 'current').symlink_to(self.old)
        self.config = dict(schema=1, root=str(self.root), node='22.23.3', process='terracart-api',
                           health_url='http://127.0.0.1:5001/health', public_api_origin='https://api.example.com')
        (self.root / '.ci-deploy.json').write_text(json.dumps(self.config))
        old_apk = self.root / 'shared/apk/terracart_v1.0.16_b38.apk'
        old_apk.write_bytes(b'old signed apk fixture')
        self.metadata = dict(latestVersion='1.0.16', latestBuildNumber=38, apkFileName=old_apk.name,
                             sha256=artifact.digest(old_apk), fileSizeBytes=old_apk.stat().st_size)
        (self.root / 'shared/app-update.json').write_text(json.dumps(self.metadata))
        self.original_metadata = (self.root / 'shared/app-update.json').read_bytes()
        self.environment = (self.root / 'shared/.env').read_bytes()
        self.commands = []
        self.execute = patch.object(server, 'execute', side_effect=self.command)
        self.execute.start()
        self.health = patch.object(server, 'health')
        self.health_mock = self.health.start()

    def tearDown(self):
        self.execute.stop()
        self.health.stop()
        self.temporary.cleanup()  # Only fixture files created by this test.

    def command(self, args, **kwargs):
        self.commands.append(args)
        if args == ['node', '--version']:
            return 'v22.23.3\n'
        if args == ['pm2', 'jlist']:
            return json.dumps([{'name': 'terracart-api', 'pm2_env': {
                'node_version': '22.23.3', 'exec_mode': 'fork_mode',
                'pm_cwd': str(self.root / 'current'), 'pm_exec_path': str(self.root / 'current/server.js')}}])
        return ''

    def bundle(self, kind='backend', firebase=True, stale=False):
        payload = Path(tempfile.mkdtemp(dir=self.temporary.name))
        if kind == 'backend':
            (payload / 'server.js').write_text('new application')
        else:
            (payload / 'release.apk').write_bytes(b'new signed apk fixture')
            data = dict(self.metadata, latestVersion='1.0.17', latestBuildNumber=39,
                        apkUrl='https://api.example.com/api/app/apk/1.0.17',
                        apkFileName='terracart_v1.0.17_b39.apk', sha256=artifact.digest(payload / 'release.apk'),
                        fileSizeBytes=(payload / 'release.apk').stat().st_size)
            (payload / 'app-update.json').write_text(json.dumps(data))
            (payload / 'release-checks.json').write_text(json.dumps({
                'firebase_confirmed': firebase, 'previous_metadata_sha256': '0' * 64 if stale else artifact.digest(self.root / 'shared/app-update.json')}))
        artifact.write_manifest(payload, kind=kind, repository=server.BACKEND_REPOSITORY if kind == 'backend' else server.MOBILE_REPOSITORY,
                                commit=SHA, environment='production')
        bundle = self.root / '.ci/incoming' / (str(len(list((self.root / '.ci/incoming').iterdir()))) + '.tar.gz')
        artifact.archive(payload, bundle)
        return bundle

    def unchanged(self):
        self.assertEqual((self.root / 'shared/.env').read_bytes(), self.environment)
        self.assertEqual((self.root / 'shared/app-update.json').read_bytes(), self.original_metadata)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_dry_run_makes_no_server_writes(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        server.deploy_backend(self.root, None, SHA)
        self.unchanged()
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')))
        self.assertNotIn(['pm2', 'reload', 'terracart-api'], self.commands)

    def test_health_failure_restores_previous_application_only(self):
        self.health_mock.side_effect = [ValueError('fixture health failure'), None]
        with self.assertRaisesRegex(ValueError, 'previous application'):
            server.deploy_backend(self.root, self.bundle(), SHA, dry_run=False)
        self.unchanged()
        self.assertEqual(self.commands.count(['pm2', 'reload', 'terracart-api']), 2)
        self.assertFalse(any('all' in command for command in self.commands))

    def test_backend_switch_retains_every_shared_path(self):
        server.deploy_backend(self.root, self.bundle(), SHA, dry_run=False)
        active = (self.root / 'current').resolve()
        self.assertEqual(active.name, SHA)
        for name in server.PERSISTENT:
            self.assertEqual((active / name).resolve(), self.root / 'shared' / name)
        self.assertEqual((self.root / 'shared/.env').read_bytes(), self.environment)
        self.assertEqual((self.root / 'shared/app-update.json').read_bytes(), self.original_metadata)
        self.assertIn(['npm', 'ci', '--omit=dev', '--ignore-scripts'], self.commands)

    def test_missing_layout_or_persistent_path_refuses_without_replacement(self):
        (self.root / '.ci-deploy.json').unlink()
        with self.assertRaises(ValueError):
            server.deploy_backend(self.root, None, SHA)
        self.unchanged()

    def test_mobile_firebase_failure_or_stale_baseline_never_activates(self):
        for firebase, stale in [(False, False), (True, True)]:
            with self.assertRaises(ValueError):
                server.publish_mobile(self.root, self.bundle('mobile-release', firebase, stale), SHA)
            self.unchanged()
            self.assertFalse((self.root / 'shared/apk/terracart_v1.0.17_b39.apk').exists())

    def test_mobile_served_smoke_failure_restores_metadata_and_retains_apks(self):
        with patch.object(server, 'mobile_smoke', side_effect=ValueError('fixture smoke failure')):
            with self.assertRaises(ValueError):
                server.publish_mobile(self.root, self.bundle('mobile-release'), SHA)
        self.unchanged()
        self.assertTrue((self.root / 'shared/apk/terracart_v1.0.17_b39.apk').is_file())
        self.assertTrue((self.root / 'shared/apk' / self.metadata['apkFileName']).is_file())
        self.assertFalse((self.root / '.ci/mobile-recovery.json').exists())

    def test_mobile_activation_matches_exact_sha_and_preserves_old_apk(self):
        with patch.object(server, 'mobile_smoke') as smoke:
            server.publish_mobile(self.root, self.bundle('mobile-release'), SHA)
            smoke.assert_called_once()
        data = json.loads((self.root / 'shared/app-update.json').read_text())
        self.assertEqual(data['sha256'], artifact.digest(self.root / 'shared/apk' / data['apkFileName']))
        self.assertTrue((self.root / 'shared/apk' / self.metadata['apkFileName']).is_file())
        self.assertEqual((self.root / 'shared/.env').read_bytes(), self.environment)

    def test_recovery_refuses_unrelated_metadata_edit(self):
        journal = self.root / '.ci/mobile-recovery.json'
        journal.write_text(json.dumps({'previous_metadata': self.metadata, 'activated_metadata_sha256': '0' * 64}))
        (self.root / 'shared/app-update.json').write_text(json.dumps(dict(self.metadata, latestVersion='2.0.0')))
        with self.assertRaises(ValueError):
            server.recover_mobile(self.root, apply=True)
        self.assertTrue(journal.exists())

    def test_server_lock_prevents_second_deployment(self):
        with server.locked(self.root):
            with self.assertRaises(ValueError):
                with server.locked(self.root):
                    self.fail('Second transaction entered lock')

    def test_manual_rollback_restores_verified_retained_application(self):
        server.deploy_backend(self.root, self.bundle(), SHA, dry_run=False)
        server.deploy_backend(self.root, None, 'b' * 40, rollback=True)
        server.deploy_backend(self.root, self.bundle(), 'b' * 40, dry_run=False, rollback=True)
        self.unchanged()

    def test_missing_retained_release_fails_even_in_dry_run(self):
        with self.assertRaises(ValueError):
            server.deploy_backend(self.root, None, SHA, rollback=True)
        self.unchanged()

    def test_remote_stdin_program_is_valid_and_private_stderr_is_not_logged(self):
        connection = remote.Remote.__new__(remote.Remote)
        connection.root = str(self.root)
        connection.options = []
        connection.target = 'fixture@example.invalid'
        def transport(args, **kwargs):
            ast.parse(kwargs['input'])
            return subprocess.CompletedProcess(args, 1,
                stdout='CI_REMOTE_REFUSAL: {"reason":"Prepared server deployment lock required"}\n',
                stderr='fixture-private-runtime-output')
        with patch.object(remote.subprocess, 'run', side_effect=transport):
            with self.assertRaisesRegex(ValueError, 'Prepared server deployment lock required') as raised:
                connection.helper('backend', commit=SHA)
            self.assertNotIn('fixture-private-runtime-output', str(raised.exception))

    def test_snapshot_hash_belongs_to_exact_metadata_bytes_read(self):
        original_digest = server.digest
        expected = original_digest(self.root / 'shared/app-update.json')
        def during_apk_verification(path):
            if Path(path).suffix == '.apk':
                (self.root / 'shared/app-update.json').write_text(json.dumps(dict(self.metadata, latestBuildNumber=40)))
            return original_digest(path)
        with patch.object(server, 'digest', side_effect=during_apk_verification):
            value = server.snapshot(self.root)
        self.assertEqual(value['metadata_sha256'], expected)
        self.assertEqual(value['metadata']['latestBuildNumber'], 38)
        self.assertNotEqual(original_digest(self.root / 'shared/app-update.json'), expected)

    def test_wrong_pm2_runtime_or_cluster_mode_refuses_without_mutation(self):
        for field, value in [('node_version', '20.19.0'), ('exec_mode', 'cluster_mode')]:
            rows = json.loads(self.command(['pm2', 'jlist']))
            rows[0]['pm2_env'][field] = value
            def command(args, **kwargs):
                return json.dumps(rows) if args == ['pm2', 'jlist'] else self.command(args, **kwargs)
            with patch.object(server, 'execute', side_effect=command):
                with self.assertRaises(ValueError):
                    server.deploy_backend(self.root, None, SHA)
            self.unchanged()


if __name__ == '__main__':
    unittest.main()
