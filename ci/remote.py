#!/usr/bin/env python3
"""Strict SSH transport. Dry runs send helpers over stdin and never install them."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import uuid
from artifact import digest


class Remote:
    def __init__(self):
        self.root = os.environ.get('BACKEND_DEPLOY_ROOT', '')
        self.host = os.environ.get('BACKEND_HOST', '')
        self.user = os.environ.get('BACKEND_SSH_USER', '')
        if not re.fullmatch(r'[a-zA-Z0-9.-]+', self.host) or self.host.startswith('-'):
            raise ValueError('Explicit SSH host required')
        if not re.fullmatch(r'[a-z_][a-z0-9_-]*', self.user) or self.user == 'root':
            raise ValueError('Dedicated non-root SSH deployment user required')
        if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', self.root) or '..' in Path(self.root).parts:
            raise ValueError('Canonical explicit deployment root required')
        directory = Path(tempfile.mkdtemp(prefix='terracart-ssh-', dir=os.environ.get('RUNNER_TEMP')))
        key = directory / 'key'
        hosts = directory / 'known_hosts'
        for path, value in [(key, os.environ.get('BACKEND_SSH_KEY', '')),
                            (hosts, os.environ.get('BACKEND_KNOWN_HOSTS', ''))]:
            if not value.strip():
                raise ValueError('Protected SSH key and independently verified known-host entries required')
            path.write_text(value + '\n')
            path.chmod(0o600)
        self.options = ['-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                        '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={hosts}',
                        '-o', 'ConnectTimeout=15']
        self.target = self.user + '@' + self.host

    def helper(self, mode, *, bundle=None, commit=None, apply=False, rollback=False):
        directory = Path(__file__).parent
        artifact = (directory / 'artifact.py').read_text()
        server = (directory / 'remote_server.py').read_text()
        # Quoted Python literals avoid shell interpolation or remote helper files.
        program = ('import sys, types\nm=types.ModuleType("artifact")\n'
                   + 'exec(' + repr(artifact) + ', m.__dict__)\nsys.modules["artifact"]=m\n'
                   + 'namespace={"__name__":"__main__"}\ntry:\n exec(' + repr(server) + ', namespace)\n'
                   + 'except Exception as error:\n'
                   + ' import json\n kind=namespace.get("DeploymentRefusal")\n'
                   + ' reason=str(error) if kind and isinstance(error,kind) else "Remote artifact/runtime validation failed"\n'
                   + ' print("CI_REMOTE_REFUSAL: "+json.dumps({"reason":reason}))\n sys.exit(1)\n')
        arguments = ['python3', '-', '--root', self.root, '--mode', mode]
        if bundle:
            arguments += ['--bundle', bundle]
        if commit:
            arguments += ['--commit', commit]
        if apply:
            arguments += ['--apply']
        if rollback:
            arguments += ['--rollback']
        result = subprocess.run(['ssh', *self.options, self.target, shlex.join(arguments)],
                                input=program, text=True, capture_output=True, check=False)
        if result.returncode:
            for line in result.stdout.splitlines():
                if line.startswith('CI_REMOTE_REFUSAL: '):
                    reason = json.loads(line.removeprefix('CI_REMOTE_REFUSAL: '))['reason']
                    raise ValueError('Remote deployment refused: ' + reason)
            raise ValueError('Remote safety/deployment check failed; inspect protected server diagnostics')
        return result.stdout

    def upload(self, bundle):
        # Probe existing state before even copying into the explicit control directory.
        self.helper('mobile')
        destination = self.root + '/.ci/incoming/' + uuid.uuid4().hex + '.tar.gz'
        result = subprocess.run(['scp', *self.options, str(bundle), self.target + ':' + destination],
                                capture_output=True, check=False)
        if result.returncode:
            raise ValueError('Application bundle transfer failed; no release activation attempted')
        return destination

    def snapshot(self, destination):
        data = json.loads(self.helper('snapshot'))
        name = data['apk_filename']
        if Path(name).name != name or not re.fullmatch(r'[a-zA-Z0-9_.-]+\.apk', name):
            raise ValueError('Remote APK snapshot filename invalid')
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        metadata = destination / 'snapshot.json'
        metadata.write_text(json.dumps(data, indent=2) + '\n')
        apk = destination / name
        result = subprocess.run(['scp', *self.options, self.target + ':' + self.root + '/shared/apk/' + name, str(apk)],
                                capture_output=True, check=False)
        if result.returncode or digest(apk) != data['apk_sha256'] or apk.stat().st_size != data['apk_bytes']:
            raise ValueError('Read-only existing APK snapshot failed integrity verification')
        return data
