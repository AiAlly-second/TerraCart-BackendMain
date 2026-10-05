#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import os
import tempfile
from github import environment_guard, download, activation_guard
from remote import Remote


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    activation_guard(args.apply)
    policy = json.loads((Path(__file__).parent / 'policy.json').read_text())
    environment_guard(policy['repository'])
    directory = Path(tempfile.mkdtemp(prefix='terracart-backend-', dir=os.environ.get('RUNNER_TEMP')))
    commit = download(policy, args.run_id, directory)
    remote = Remote()
    if not args.apply:
        print(remote.helper('backend', commit=commit, rollback=args.rollback).strip())
        return
    bundle = remote.upload(directory / 'artifact.tar.gz')
    print(remote.helper('backend', bundle=bundle, commit=commit, apply=True, rollback=args.rollback).strip())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'DEPLOYMENT REFUSED: {error}')
