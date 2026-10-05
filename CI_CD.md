# TerraCart backend CI/CD

Repository: `AiAlly-second/TerraCart-BackendMain`. Plain JavaScript Node/Express 5, Mongoose/MongoDB, Redis/Socket.IO and S3. Node is pinned to **22.23.3**. The workspace is on `Tushar`; the repository default branch is `main`. No staging/develop branch/infrastructure was established.

Existing deployment evidence: EC2/PM2 SSH and SSM workflows; their hard-coded directory/process definitions disagree (`server` versus ecosystem `terracart-api`). An older `render.yaml` is also present. The active host, transport, exact PM2 process, live server Node version and current filesystem layout remain **unverified**. This implementation prepares guarded SSH artifact deployment using the existing EC2/PM2 approach and retires the unsafe SSM bypass. Do not adopt SSH if the active installation is SSM-only/Render: confirm transport and adapt the deployment helper first, without changing application logic or hosting provider.

Before: Node 20 CI used an install fallback and placeholder `npm test`; SSH did in-place git pull/npm install and `pm2 restart all`; SSM used another unverified process. Neither deploy had reliable provenance, readiness, protected approval, shared-state protection, or application rollback.

## Workflows and helpers

- `.github/workflows/terracart-cicd.yml`: PR/all branch push/manual CI. Syntax validation and reviewed syntax-only build; explicit allowlist of 10 native Node test files; dependency/secret/dangerous-script audit; runtime-only artifact after all gates pass.
- `.github/workflows/terracart-backend-deploy.yml`: manual protected production artifact deployment or retained-release rollback, main only, default dry run.
- `.github/workflows/terracart-backend-deploy-ssm.yml`: retired, manual fail-closed notice; no AWS command or server mutation.
- `ci/checks.py`, `ci/policy.json`, `ci/db-guard.cjs`: reviewed script/test isolation and security checks.
- `ci/artifact.py`, `ci/github.py`: immutable artifact/provenance/native-protection validation.
- `ci/deploy_backend.py`, `ci/remote.py`, `ci/remote_server.py`: strictly verified SSH/PM2 deployment and shared server lock.
- `ci/tests/test_safety.py`, `ci/tests/test_database.py`, `ci/tests/test_remote.py`: negative provenance/DB-target/archive tests and storage/rollback fixtures.
- `ci/.gitignore`: excludes only generated CI reports/artifacts/Python caches.

## Production secrets and variables (names only)

Protected **secrets**: `BACKEND_SSH_KEY`, `BACKEND_KNOWN_HOSTS`.

Protected **variables**: `BACKEND_HOST`, `BACKEND_SSH_USER`, `BACKEND_DEPLOY_ROOT`, `PRODUCTION_DEPLOYMENTS_ENABLED`.

Known repository-level legacy secret names: `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `EC2_HOST`, `EC2_USERNAME`. New workflows do not use them. An operator must remove/relocate obsolete production secrets before PR adoption; existing repository-level secrets are not protected merely because a new workflow avoids referencing them. No AWS credentials or Mongo URI are required by the new pipeline.

## Verified layout required before any deployment

CI will not create this structure, move live data, change PM2 ownership/topology, overwrite `.env`, or guess a directory. An operator must first verify an already prepared layout and review any necessary infrastructure conversion as a separate operation. Existing flat/in-place installations **fail closed**.

```text
<BACKEND_DEPLOY_ROOT>/
  .ci-deploy.json          # operator-controlled, not group/world writable
  current -> releases/<existing-commit>
  releases/<existing-commit>/
    server.js, package.json, package-lock.json, runtime source/data
    .env -> ../../shared/.env
    uploads -> ../../shared/uploads
    apk -> ../../shared/apk
    logs -> ../../shared/logs
    backups -> ../../shared/backups
    app-update.json -> ../../shared/app-update.json
  shared/                 # existing files/data; never replaced or deleted
    .env, app-update.json, uploads/, apk/, logs/, backups/
  .ci/production.lock     # pre-existing file, shared by backend and mobile CD
  .ci/incoming/           # unique CI application bundles, no automatic pruning
```

Example marker (replace explicit path and verify the **actual** process; this is documentation, not an initialization script):

```json
{
  "schema": 1,
  "root": "/explicit/verified/terracart",
  "node": "22.23.3",
  "process": "terracart-api",
  "health_url": "http://127.0.0.1:5001/health",
  "public_api_origin": "https://api.terracart.in"
}
```

The root must be canonical, with physical releases/shared/control directories. The SSH account must be non-root and restricted to this service; Python 3, `fcntl`, npm/Node 22.23.3 and PM2 are required on the server. SSH host fingerprints must be verified independently and stored as complete known-host lines. No `StrictHostKeyChecking=no`, remote helper installation, `sudo`, git clean/reset, rsync/delete, seed or migration is used.

PM2 must already have exactly one configured process, with `pm_cwd=<root>/current`, `pm_exec_path=<root>/current/server.js`, `node_version=22.23.3` and `exec_mode=fork_mode`. Cluster/multi-instance or pinned old-release paths fail until separately verified/adapted. Set and verify the existing production runtime environment deliberately; CD retains it and does not rewrite server `.env`.

The backend artifact allowlist includes `server.js`, both npm manifest/lock files, `ecosystem.config.js`, `config/`, **`data/`**, `controllers/`, `logging/`, `middleware/`, `models/`, `routes/`, `services/`, `utils/`. Literal relative runtime imports are checked without executing modules. It excludes `.env`, uploads, APKs, backups, logs, `app-update.json`, tests and manual scripts. CI never starts the app.

Actual deployment extracts into a **new** commit-named release, links existing shared paths, runs only `npm ci --omit=dev --ignore-scripts` and `node --check`, atomically switches `current`, reloads the exact PM2 process, and polls existing loopback `/health` for `status=healthy`. Health failure restores the previous application symlink and reloads that same process. Old releases, failed release directories, incoming bundles and persistent state are retained; no automatic cleanup is implemented. Unfinished Android release locks/journals block backend deployment.

## Rollback

Dispatch `terracart-backend-deploy.yml` on main with the prior **successful main CI run ID**, `rollback=true`, and initially `dry_run=true`. Review the artifact and installed release; activate only after native approval and the enable flag. The prior installed release must still exist and pass provenance/file-hash/shared-path verification. Expired CI artifacts require an explicitly reviewed recovery path; no unchecked fallback exists. Database and persistent state are never restored/reverted by application rollback.

## Dangerous existing operations: audited, never executed

| Existing path/command family | Classification / reason |
| --- | --- |
| `scripts/reset-cart-operational-data.js`, `scripts/reset-cart-finances-data.js` | PRODUCTION DANGEROUS: confirmed deletion of scoped production collections; even default dry-run scripts are excluded |
| `scripts/seed-inventory-feature.js --apply`, `seedCosting.js`, `seedMenu.js`, `seed-restaurant-inventory.js`, `initDefaultMenu.js` | PRODUCTION DANGEROUS: seed/data writes |
| `scripts/sync-costing-v2-indexes.js`, `fix-table-database.js`, `fix-table-indexes.js`, `fix-inventory-cartid.js` | PRODUCTION DANGEROUS: schema/index repair or data mutation |
| `scripts/force-menu-sync.js`, `setup-atlas-admins.js`, `verify-and-create-admins.js`, `migrate-attendance-date-ist.js` | PRODUCTION DANGEROUS: account/menu/schedule mutation or migration |
| Root `restore_super_admin*.js`, `fix_ingredients*.js`, `make-ingredients-shared.js`, `promoteUser.js`, `createApiKey.js` | POTENTIALLY/PRODUCTION DANGEROUS: manual account/ingredient/security writes; not CI commands |
| `scripts/release-android.mjs` `main/publish/activate/recover` | PRODUCTION DANGEROUS for ordinary CI: writes release state and deletes obsolete APKs; these functions are never called by the new publisher |
| Allowlisted integration tests + `tests/helpers/isolatedMongo.js` | SAFE TEST-ONLY: disposable guarded loopback DB fixtures |
| Legacy `tests/mobile-app-integration.test.js`, `tests/costing/costingController.test.js` | Guarded/local legacy test fixtures; excluded because the current native runner does not provide their Jest setup |
| Controller/service delete operations | Normal existing business behavior; never invoked by deployment helpers; source unchanged |

The full location-only scanner output is retained as `dangerous-operations.json`; broad pattern matches are audit candidates, not proof every matched line executes destructively. No `dropDatabase`, seeder, reset, migration, restore, bulk cleanup, S3 delete or schema-sync command is permitted in any new deployment command path.

## Recorded baseline

117/117 selected backend application tests passed; **30 CI safety helper tests passed**. Syntax and runtime artifact builds passed. Current-source secret pattern scan passed. Dependency audit fails: **15 high, 2 critical** (52 total across severities). npm `test` remains the original placeholder; CI deliberately uses the reviewed real native suites. There is no backend ESLint/TypeScript project to claim as an existing lint/typecheck; syntax checks cover current JS modules. Production stays blocked until security and all other required checks pass.
## Safety and activation status

Implemented locally; **production activation is blocked**. No commit, push, GitHub settings change, hosting change, production deployment, migration, seed, reset, restore, or production database operation was performed. Existing application changes in this dirty workspace predate this task and were preserved.

**Application source modification required** to make the existing failing application checks green. Remediate those failures in a separately reviewed application change. This implementation does not weaken checks, change application code, change lockfiles, generate a signing key, or auto-increment a release version.

PRs and branch pushes run validation only, with `contents: read`. CI does not reference production/cloud/signing/Firebase secrets and does not use `pull_request_target`. Installs use the committed lockfile, ignore npm lifecycle hooks, and check lockfile retention. Reviewed npm script definitions must exactly match `ci/policy.json`; changed definitions fail closed.

Production is `workflow_dispatch` on `main` only, in the native `production` environment. `dry_run` defaults to true. Native required reviewers, selected-main-only deployment rules, and actual main protection requiring a reviewed PR and all four CI checks are checked again by the helper. Actual activation additionally requires protected environment variable `PRODUCTION_DEPLOYMENTS_ENABLED=true`. Keep it absent/false until every prerequisite and the first dry run pass. Production workflow concurrency never cancels an active deployment.

Only a successful, completed, same-repository **main-push CI** run from the specified CI workflow supplies an artifact. Failed runs, PR runs, feature branches, forks, expired/missing artifacts, foreign workflows, archive links/traversal, wrong environment/repository/commit/run ID, and checksum mismatches are rejected. Artifacts include repository, full commit SHA, run ID, environment, file hashes, and reviewed public configuration. The GitHub archive digest, inner tar checksum, and individual file hashes are checked. Ordinary CI reports retain 14 days; main build artifacts retain 30 days.

**No staging environment detected.** Historical Vercel Preview/Production labels do not establish an isolated staging API/database. No staging or preview deployment workflow was added. PR web builds use a loopback-only API origin; mobile debug CI uses a loopback `.env` asset and `USE_PROD_API=false`.

## Required GitHub controls

Create/configure a lowercase `production` environment with required human reviewers, prevent self-review and bypass where the plan supports it, and selected deployment **branch `main` only** (no tags/wildcards). If the repository plan cannot enforce native reviewers, production stays disabled; there is no replacement approval checkbox or custom pseudo-approval workflow.

Protect `main` with reviewed PRs, dismiss stale approvals, required checks `Checks (lint)`, `Checks (test)`, `Checks (security)`, and `Build`, require current branch status, prohibit force pushes/deletion, and review workflow/helper changes through trusted maintainers. Prefer a repository ruleset plus restricted bypass; status checks alone do not establish trusted deployment code. No repository settings were changed in this task.

Production secrets belong in the protected environment only. Keep workflow token permissions read-only; deployment artifact retrieval adds `actions: read`. Do not grant `contents: write`, `id-token: write`, production Mongo credentials, or general-purpose cloud administrator credentials to PR CI. Enable native secret scanning/push protection where available; the included scanner checks current source for selected high-confidence credential patterns and does **not** prove historical Git history is clean.

## First safe activation

1. Review only this task's workflow/CI/documentation/deployment-config diff; preserve all pre-existing dirty changes. Do not stage whole mixed application files.
2. Disable existing provider automation that could deploy outside these workflows before merging. Configure branch protections/native environment reviewers, and move production credentials out of repository-level secrets.
3. Open reviewed CI implementation PRs and run validation without production credentials. Keep failing PRs unmerged; deployment remains disabled and dry-run-only.
4. Fix the recorded application lint/test/format/analysis and dependency blockers through separately reviewed changes. Require all PR checks before merging the CI setup, then require a successful full main CI before any deployment. A successful build alone is insufficient.
5. Configure explicit reviewed production variables, least-privilege hosting access, verified SSH known hosts where used, and server/provider prerequisites. Do not initialize/migrate live storage as part of CI.
6. After a successful main-push CI run, dispatch production with that numeric CI run ID and `dry_run=true`. Complete native review. Verify artifact provenance, target identity, persistent-state protection, health, rollback, and the expected absence of writes.
7. Only after reviewing dry-run evidence, deliberately set `PRODUCTION_DEPLOYMENTS_ENABLED=true` and approve a separately dispatched activation with `dry_run=false`. The first CI run never deploys. Monitor read-only smoke checks and preserve the prior application artifact.

## Local validation and limits (2026-10-04)

Validation used separate source copies and checksum-verified Node 22.23.3. npm installs with `npm ci --ignore-scripts` passed. All existing application checks were run independently to expose the baseline even where production CI correctly stops before building. Results and sanitized reports are in `../TerraCart-AdminApp/build/work-ux-validation/cicd-2026-10-04/` in this multi-checkout workspace; they are local working-tree evidence (including preserved uncommitted changes), not a remote-main, GitHub Actions or production acceptance claim. No live production dry run, deploy, signing release, Firebase upload, live provider rollback, or device installation was performed.

Actionlint 1.7.12 validates all workflow syntax/expressions; bash command syntax is checked separately. ShellCheck/PyFlakes were unavailable and are not claimed. CI helper unit tests use temporary local fixtures and mocked hosting/PM2/Firebase operations. Current-source secret scans found no matching secrets in the isolated copies; this is limited pattern coverage. There is no Flutter dependency vulnerability feed integrated; Flutter security validation currently covers committed credential/signing-file detection and dangerous-operation reporting.

## Database boundary

**NO AUTOMATIC PRODUCTION DB MUTATION COMMANDS.** CI receives no production DB credentials. Backend tests use a disposable local Mongo replica set named `terracart_inventory_isolation_test`, with a preload guard rejecting remote hosts, other database names, credentials, URI overrides, and non-test environments. Tests may create/delete only their disposable fixtures. The backend server is never started by CI. Deployment helpers have no DB driver/URI, seed/reset/migration/restore command, or database rollback.

The SSH deployment account operates on a host that already has the application's production `.env`; it has indirect host access, so least-privilege account controls matter. Reloading the existing application retains its existing database permissions, business schedulers, and implicit Mongoose model/index initialization. This implementation does not claim the running application is read-only or that application startup can never write/create indexes. Strict zero writes across application startup would require separate database-permission/application changes; those are outside this source-preserving CI task. Verify runtime/IAM/index behavior before activation. No production DB credentials were read/copied into CI, and no live DB safety claim is inferred from local tests.
