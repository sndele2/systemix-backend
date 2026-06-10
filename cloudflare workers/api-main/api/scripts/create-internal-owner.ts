/**
 * App-faithful internal owner/operator creation.
 *
 * WHY THIS EXISTS
 *   The two supported owner-creation paths are:
 *     (a) POST /v1/internal/auth/bootstrap — first owner only (gated to ZERO active owners)
 *     (b) POST /v1/internal/auth/users     — owner-creates-owner (needs an existing owner session)
 *   When neither is usable (e.g. the only owner's password is lost), there is NO supported way
 *   to add a second owner. This script closes that gap by creating the internal_users row
 *   EXACTLY the way the application does: the same pbkdf2 hashing (hashInternalPassword) and the
 *   same column shape as D1InternalUserStore.createUser. No bespoke hashing, no schema drift.
 *
 * SAFETY MODEL
 *   - DEFAULT run = PREVIEW (no production write). It generates the password (-> 0600 cred file),
 *     derives the pbkdf2 hash, writes the exact INSERT to a 0600 .sql file, and prints that INSERT
 *     with the password_hash REDACTED. Neither the plaintext password nor the real hash is printed.
 *   - It writes to prod ONLY with --execute, which runs:
 *       wrangler d1 execute <db> --remote --file <sql>
 *     against the named D1 database, after a guard SELECT that aborts if the username already exists.
 *   - --execute replays the SQL written during PREVIEW, so the hash/password reviewed == the one written.
 *
 * USAGE
 *   node --experimental-strip-types scripts/create-internal-owner.ts \
 *     --username sndele --display-name "Sean Ndele" --role owner \
 *     [--business-number +18443217137] [--db systemix] \
 *     [--cred-file <path>] [--sql-file <path>] [--execute]
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

import {
  hashInternalPassword,
  normalizeInternalUsername,
  normalizeInternalDisplayName,
  normalizeInternalBusinessNumber,
} from '../src/core/internal-auth.ts';

type Role = 'owner' | 'operator';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 28-char alphanumeric (~166 bits). The only backend policy is length >= 8. */
function generatePassword(): string {
  let pw = '';
  while (pw.length < 28) pw += randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return pw.slice(0, 28);
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const COLUMNS =
  '(id, business_number, username, display_name, role, password_hash, is_active, created_at, updated_at)';

async function main(): Promise<void> {
  const usernameRaw = arg('username');
  const displayNameRaw = arg('display-name');
  const roleRaw = arg('role', 'owner') as Role;
  const businessNumberRaw = arg('business-number', '+18443217137')!;
  const db = arg('db', 'systemix')!;
  const credFile = arg('cred-file', '/Users/seanndele/Desktop/Systemix/.sndele-owner-credential.txt')!;
  const sqlFile = arg('sql-file', '/tmp/create-internal-owner.sql')!;
  const execute = flag('execute');

  if (!usernameRaw || !displayNameRaw) {
    console.error('ERROR: --username and --display-name are required.');
    process.exit(2);
  }
  if (roleRaw !== 'owner' && roleRaw !== 'operator') {
    console.error('ERROR: --role must be "owner" or "operator".');
    process.exit(2);
  }

  // Validate/normalize with the repo's OWN functions so the row is byte-faithful to the app.
  const u = normalizeInternalUsername(usernameRaw);
  if (!u.ok) return void (console.error('ERROR username:', u.error), process.exit(2));
  const d = normalizeInternalDisplayName(displayNameRaw);
  if (!d.ok) return void (console.error('ERROR display-name:', d.error), process.exit(2));
  const b = normalizeInternalBusinessNumber(businessNumberRaw);
  if (!b.ok) return void (console.error('ERROR business-number:', b.error), process.exit(2));

  if (execute) {
    // Guard: never silently clobber / duplicate an existing username.
    const check = execFileSync(
      'wrangler',
      ['d1', 'execute', db, '--remote', '--json', '--command',
        `SELECT username FROM internal_users WHERE username = ${sqlQuote(u.value)};`],
      { encoding: 'utf8' },
    );
    if (/"username"\s*:/.test(check)) {
      console.error(`ERROR: user '${u.value}' already exists in ${db} — aborting, no write performed.`);
      process.exit(1);
    }
    const sql = readFileSync(sqlFile, 'utf8');
    if (!/INSERT INTO internal_users/.test(sql)) {
      console.error(`ERROR: ${sqlFile} does not contain the expected INSERT — run PREVIEW first.`);
      process.exit(1);
    }
    console.error(`Executing prod write against D1 "${db}" (remote) from ${sqlFile} ...`);
    const out = execFileSync('wrangler', ['d1', 'execute', db, '--remote', '--file', sqlFile], { encoding: 'utf8' });
    console.log(out);
    return;
  }

  // ---- PREVIEW (default): no production write ----
  const password = generatePassword();
  const hashed = await hashInternalPassword(password);
  if (!hashed.ok) return void (console.error('ERROR hashing password:', hashed.error), process.exit(1));

  const id = randomUUID();
  const now = new Date().toISOString();
  const values = [
    sqlQuote(id), sqlQuote(b.value), sqlQuote(u.value), sqlQuote(d.value),
    sqlQuote(roleRaw), sqlQuote(hashed.value), '1', sqlQuote(now), sqlQuote(now),
  ].join(', ');
  const realInsert = `INSERT INTO internal_users ${COLUMNS} VALUES (${values});\n`;

  // Persist the executable SQL (real hash) and the credential (plaintext) — both 0600, neither printed.
  writeFileSync(sqlFile, realInsert, { mode: 0o600 });
  writeFileSync(
    credFile,
    `# Systemix internal owner credentials (0600) — created by scripts/create-internal-owner.ts\n` +
      `# ${now}. Rotate as needed.\n${u.value}: ${password}\n`,
    { mode: 0o600 },
  );

  const redactedHash = `pbkdf2_sha256$100000$<16-byte-salt>$<32-byte-key>  [REDACTED, ${hashed.value.length} chars]`;
  const redactedValues = [
    sqlQuote(id), sqlQuote(b.value), sqlQuote(u.value), sqlQuote(d.value),
    sqlQuote(roleRaw), `'${redactedHash}'`, '1', sqlQuote(now), sqlQuote(now),
  ].join(', ');

  console.log('PREVIEW — no production write performed.');
  console.log(`Target D1 database: "${db}" (remote)`);
  console.log(`Credential file:    ${credFile} (0600)`);
  console.log(`Executable SQL:     ${sqlFile} (0600)`);
  console.log('\n--- exact INSERT that --execute will run (password_hash REDACTED) ---');
  console.log(`INSERT INTO internal_users ${COLUMNS}\nVALUES (${redactedValues});`);
  console.log('\n--- column values ---');
  console.log('  id              =', id);
  console.log('  business_number =', b.value);
  console.log('  username        =', u.value);
  console.log('  display_name    =', d.value);
  console.log('  role            =', roleRaw);
  console.log('  is_active       = 1');
  console.log('  created_at      =', now);
  console.log('  updated_at      =', now);
  console.log('  password_hash   = <pbkdf2_sha256, 100000 iters; real value only in the 0600 .sql file>');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
