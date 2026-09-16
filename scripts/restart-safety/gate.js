#!/usr/bin/env node
'use strict';
/* gate.js — VERIFY ONLY. Never starts anything.
 *
 * It checks the declared identity and configuration and then exits:
 *   exit 0  = approved; the caller (bootstrap.sh) may exec the fixed target
 *   exit >0 = stop; the caller must not exec anything
 *
 * It deliberately does NOT spawn, exec or mark. Process replacement is the
 * bootstrap shell's job, so that no Node process remains as the target's parent
 * and so that nothing can be marked as started unless the target itself starts.
 *
 * There is no --root and no alternative revision source: verification always
 * covers the real absolute paths, and the runtime revision is required.
 *
 * LIMIT: protects the DECLARED content (nine files, the full migration set), the
 * expected revision, forbidden admin variable NAMES and the pause setting. It
 * does not protect against an administrator replacing this tool or its manifest
 * wholesale. It is an identity-and-configuration gate, not a sandbox.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = { OK: 0, MANIFEST: 10, REVISION: 11, FILE_HASH: 12, MIGRATIONS: 13,
            FORBIDDEN_ENV: 14, PAUSE: 15, TOOL: 16, USAGE: 17 };

const KNOWN_ARGS = new Set(['mode', 'manifest', 'manifest-sha256']);
const MODES = new Set(['migrator', 'app', 'selftest']);
const APP_MODES = new Set(['app']);
const MIGRATIONS_DIR = '/app/apps/api/prisma/migrations';

function fail(code, msg, detail) {
  process.stderr.write('GATE_FAIL ' + msg + '\n');
  if (detail) process.stderr.write('  detail: ' + detail + '\n');
  process.exit(code);
}
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function main(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(E.USAGE, 'bad_argument', a);
    const key = a.slice(2);
    if (!KNOWN_ARGS.has(key)) fail(E.USAGE, 'unknown_argument', '--' + key);
    if (i + 1 >= argv.length) fail(E.USAGE, 'missing_value_for_' + key);
    args[key] = argv[++i];
  }
  if (!MODES.has(args.mode)) fail(E.USAGE, 'unknown_mode', String(args.mode));
  if (!args.manifest || !args['manifest-sha256']) fail(E.USAGE, 'manifest_and_manifest_sha256_required');

  let blob;
  try { blob = fs.readFileSync(args.manifest); }
  catch (e) { fail(E.MANIFEST, 'manifest_unreadable', String(e.message)); }
  const got = crypto.createHash('sha256').update(blob).digest('hex');
  if (got !== args['manifest-sha256'])
    fail(E.MANIFEST, 'manifest_hash_mismatch', 'expected ' + args['manifest-sha256'] + ' got ' + got);
  let man;
  try {
    man = JSON.parse(blob.toString('utf8'));
    for (const k of ['expected_revision', 'declared_files', 'declared_migrations',
                     'forbidden_env_names', 'required_app_env'])
      if (!man[k]) throw new Error('missing key ' + k);
  } catch (e) { fail(E.MANIFEST, 'manifest_unparseable', String(e.message)); }

  // Runtime revision is REQUIRED. No fallback source.
  const rev = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!rev) fail(E.REVISION, 'revision_missing',
    'RAILWAY_GIT_COMMIT_SHA absent; an equivalent binding must be verified concretely before relaxing this');
  if (rev !== man.expected_revision)
    fail(E.REVISION, 'revision_mismatch', 'expected ' + man.expected_revision + ' got ' + rev);

  for (const p of Object.keys(man.declared_files).sort()) {
    if (!path.isAbsolute(p)) fail(E.TOOL, 'declared_path_not_absolute', p);
    let h;
    try { h = sha256(p); }
    catch (e) { fail(E.FILE_HASH, 'declared_file_unreadable', p + ': ' + e.message); }
    if (h !== man.declared_files[p]) fail(E.FILE_HASH, 'declared_file_hash_mismatch', p);
  }

  let present;
  try {
    present = fs.readdirSync(MIGRATIONS_DIR)
      .filter(d => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory());
  } catch (e) { fail(E.MIGRATIONS, 'migrations_dir_unreadable', String(e.message)); }
  const want = new Set(Object.keys(man.declared_migrations));
  const have = new Set(present);
  const extra = [...have].filter(x => !want.has(x)).sort();
  const missing = [...want].filter(x => !have.has(x)).sort();
  if (extra.length) fail(E.MIGRATIONS, 'unexpected_migration', extra.slice(0, 5).join(','));
  if (missing.length) fail(E.MIGRATIONS, 'missing_migration', missing.slice(0, 5).join(','));
  for (const name of [...want].sort()) {
    const f = path.join(MIGRATIONS_DIR, name, 'migration.sql');
    let h;
    try { h = sha256(f); }
    catch (e) { fail(E.MIGRATIONS, 'migration_unreadable', name + ': ' + e.message); }
    if (h !== man.declared_migrations[name]) fail(E.MIGRATIONS, 'migration_hash_mismatch', name);
  }

  const found = man.forbidden_env_names.filter(n => Object.prototype.hasOwnProperty.call(process.env, n));
  if (found.length) fail(E.FORBIDDEN_ENV, 'forbidden_admin_variable_present', 'names only: ' + found.sort().join(','));

  if (APP_MODES.has(args.mode)) {
    for (const k of Object.keys(man.required_app_env)) {
      const v = process.env[k];
      if (v === undefined) fail(E.PAUSE, 'pause_setting_missing', k);
      if (v !== man.required_app_env[k]) fail(E.PAUSE, 'pause_setting_wrong', k + ' must be ' + man.required_app_env[k]);
    }
  }

  process.stderr.write('GATE_OK mode=' + args.mode + ' revision=' + rev +
    ' files=' + Object.keys(man.declared_files).length +
    ' migrations=' + Object.keys(man.declared_migrations).length + '\n');
  process.exit(E.OK);          // verify only; the caller execs
}

try { main(process.argv); }
catch (e) {
  process.stderr.write('GATE_FAIL tool_internal_error\n  detail: ' +
    (e && e.stack ? e.stack.split('\n')[0] : String(e)) + '\n');
  process.exit(E.TOOL);
}
