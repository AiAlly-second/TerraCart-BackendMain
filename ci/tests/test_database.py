import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from checks import safe_environment


class DatabaseTargetGuard(unittest.TestCase):
    def test_live_remote_named_production_and_authenticated_targets_rejected(self):
        guard = str(Path(__file__).resolve().parents[1] / 'db-guard.cjs')
        code = "const {assertTarget}=require(process.argv[1]); for(const uri of process.argv.slice(2)){try{assertTarget(uri);process.exit(99);}catch(error){if(!String(error.message).startsWith('CI_'))throw error;}}"
        subprocess.run(['node', '-e', code, guard,
                        'mongodb://db.production.example/terracart_inventory_isolation_test',
                        'mongodb+srv://db.example/terracart_inventory_isolation_test',
                        'mongodb://127.0.0.1/production',
                        'mongodb://127.0.0.1/terracart_inventory_isolation_test?authSource=admin',
                        'mongodb://fixture:fixture@127.0.0.1/terracart_inventory_isolation_test'],
                       env=safe_environment(), check=True)
        # Import-time guard rejects accidentally inherited production environment.
        env = safe_environment()
        env['NODE_ENV'] = 'production'
        result = subprocess.run(['node', '-e', 'require(process.argv[1])', guard], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
