import { normalizePhone } from '../services/smsCompliance.ts';
import { createLogger } from './logging.ts';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type InternalUserRole = 'owner' | 'operator';

export interface InternalAuthEnv {
  ALLOWED_ORIGIN?: string;
  DB?: D1Database;
  GTM_ADMIN_KEY?: string;
  INTERNAL_INBOX_PASSWORD?: string;
  SESSION_SECRET?: string;
  SYSTEMIX?: D1Database;
  SYSTEMIX_NUMBER?: string;
}

export interface InternalAuthUser {
  id: string;
  businessNumber: string;
  username: string;
  displayName: string;
  role: InternalUserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface InternalAuthUserRecord extends InternalAuthUser {
  passwordHash: string;
}

export interface InternalSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userId: string;
  role: InternalUserRole;
  businessNumber: string;
  user: InternalAuthUser;
}

interface StoredInternalSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userId: string | null;
  role: string | null;
  businessNumber: string | null;
}

export interface InternalSessionCookie {
  sessionId: string;
  signature: string;
  value: string;
}

export interface InternalCorsPolicy {
  headers: Record<string, string>;
  isAllowedOrigin: boolean;
  requestOrigin: string | null;
}

export interface InternalSessionStore {
  createSession(session: StoredInternalSession): Promise<Result<void>>;
  getSession(sessionId: string): Promise<Result<StoredInternalSession | null>>;
  deleteSession(sessionId: string): Promise<Result<void>>;
}

export interface InternalUserStore {
  countOwners(): Promise<Result<number>>;
  createUser(input: {
    businessNumber: string;
    username: string;
    displayName: string;
    role: InternalUserRole;
    passwordHash: string;
  }): Promise<Result<InternalAuthUser>>;
  getUserById(userId: string): Promise<Result<InternalAuthUser | null>>;
  getUserByUsername(username: string): Promise<Result<InternalAuthUser | null>>;
  getUserRecordByUsername(username: string): Promise<Result<InternalAuthUserRecord | null>>;
}

const authLog = createLogger('[ROUTER]', 'internal-auth');
const INTERNAL_SESSION_COOKIE_NAME = 'sessionId';
const INTERNAL_SESSION_TTL_SECONDS = 28_800;
const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256';
const PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const textEncoder = new TextEncoder();

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function resolveSessionDatabase(env: InternalAuthEnv): Result<D1Database> {
  if (env.DB) {
    return succeed(env.DB);
  }

  if (env.SYSTEMIX) {
    return succeed(env.SYSTEMIX);
  }

  return fail('Internal session store is not configured');
}

function parseInternalUserRole(value: unknown): Result<InternalUserRole> {
  if (value === 'owner' || value === 'operator') {
    return succeed(value);
  }

  return fail('Invalid internal user role');
}

function parseInternalUserRow(
  row:
    | {
        id?: unknown;
        business_number?: unknown;
        username?: unknown;
        display_name?: unknown;
        role?: unknown;
        password_hash?: unknown;
        is_active?: unknown;
        created_at?: unknown;
        updated_at?: unknown;
      }
    | null
): Result<InternalAuthUserRecord | null> {
  if (!row) {
    return succeed(null);
  }

  const roleResult = parseInternalUserRole(row.role);
  if (!roleResult.ok) {
    return fail('Internal user store returned invalid user data');
  }

  if (
    typeof row.id !== 'string' ||
    typeof row.business_number !== 'string' ||
    typeof row.username !== 'string' ||
    typeof row.display_name !== 'string' ||
    typeof row.password_hash !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    return fail('Internal user store returned invalid user data');
  }

  const businessNumber = normalizePhone(row.business_number);
  if (!businessNumber) {
    return fail('Internal user store returned invalid user data');
  }

  const isActive = Number(row.is_active || 0);
  if (isActive !== 0 && isActive !== 1) {
    return fail('Internal user store returned invalid user data');
  }

  return succeed({
    id: row.id,
    businessNumber,
    username: row.username,
    displayName: row.display_name,
    role: roleResult.value,
    passwordHash: row.password_hash,
    isActive: isActive === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

class D1InternalSessionStore implements InternalSessionStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async createSession(session: StoredInternalSession): Promise<Result<void>> {
    try {
      await this.db
        .prepare(
          `
          INSERT INTO internal_sessions (
            id,
            created_at,
            expires_at,
            ip,
            user_id,
            role,
            business_number
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        )
        .bind(
          session.id,
          session.createdAt,
          session.expiresAt,
          session.ip,
          session.userId,
          session.role,
          session.businessNumber
        )
        .run();
      return succeed(undefined);
    } catch (error) {
      authLog.error('failed_to_create_internal_session', {
        error,
        data: {
          sessionId: session.id,
          expiresAt: session.expiresAt,
          userId: session.userId,
        },
      });
      return fail('Failed to create internal session');
    }
  }

  async getSession(sessionId: string): Promise<Result<StoredInternalSession | null>> {
    try {
      const row = await this.db
        .prepare(
          `
          SELECT id, created_at, expires_at, ip, user_id, role, business_number
          FROM internal_sessions
          WHERE id = ?
          LIMIT 1
        `
        )
        .bind(sessionId)
        .first<{
          id?: unknown;
          created_at?: unknown;
          expires_at?: unknown;
          ip?: unknown;
          user_id?: unknown;
          role?: unknown;
          business_number?: unknown;
        }>();

      if (!row) {
        return succeed(null);
      }

      if (
        typeof row.id !== 'string' ||
        typeof row.created_at !== 'string' ||
        typeof row.expires_at !== 'string'
      ) {
        return fail('Internal session store returned invalid session data');
      }

      return succeed({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        ip: typeof row.ip === 'string' ? row.ip : null,
        userId: typeof row.user_id === 'string' ? row.user_id : null,
        role: typeof row.role === 'string' ? row.role : null,
        businessNumber: typeof row.business_number === 'string' ? row.business_number : null,
      });
    } catch (error) {
      authLog.error('failed_to_read_internal_session', {
        error,
        data: {
          sessionId,
        },
      });
      return fail('Failed to read internal session');
    }
  }

  async deleteSession(sessionId: string): Promise<Result<void>> {
    try {
      await this.db.prepare('DELETE FROM internal_sessions WHERE id = ?').bind(sessionId).run();
      return succeed(undefined);
    } catch (error) {
      authLog.error('failed_to_delete_internal_session', {
        error,
        data: {
          sessionId,
        },
      });
      return fail('Failed to delete internal session');
    }
  }
}

class D1InternalUserStore implements InternalUserStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async countOwners(): Promise<Result<number>> {
    try {
      const row = await this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM internal_users
          WHERE role = 'owner'
            AND is_active = 1
        `
        )
        .first<{ count?: unknown }>();

      return succeed(Number(row?.count || 0));
    } catch (error) {
      authLog.error('failed_to_count_internal_owners', {
        error,
      });
      return fail('Failed to count internal owners');
    }
  }

  async createUser(input: {
    businessNumber: string;
    username: string;
    displayName: string;
    role: InternalUserRole;
    passwordHash: string;
  }): Promise<Result<InternalAuthUser>> {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    try {
      await this.db
        .prepare(
          `
          INSERT INTO internal_users (
            id,
            business_number,
            username,
            display_name,
            role,
            password_hash,
            is_active,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `
        )
        .bind(
          id,
          input.businessNumber,
          input.username,
          input.displayName,
          input.role,
          input.passwordHash,
          timestamp,
          timestamp
        )
        .run();

      return succeed({
        id,
        businessNumber: input.businessNumber,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      authLog.error('failed_to_create_internal_user', {
        error,
        data: {
          username: input.username,
          role: input.role,
          businessNumber: input.businessNumber,
        },
      });

      if (message.includes('unique') || message.includes('constraint')) {
        return fail('Username already exists');
      }

      return fail('Failed to create internal user');
    }
  }

  async getUserById(userId: string): Promise<Result<InternalAuthUser | null>> {
    try {
      const rowResult = await this.getUserRow(
        `
        SELECT
          id,
          business_number,
          username,
          display_name,
          role,
          password_hash,
          is_active,
          created_at,
          updated_at
        FROM internal_users
        WHERE id = ?
        LIMIT 1
      `,
        userId
      );

      if (!rowResult.ok) {
        return rowResult;
      }

      if (rowResult.value === null) {
        return succeed(null);
      }

      return succeed(stripPasswordHash(rowResult.value));
    } catch (error) {
      authLog.error('failed_to_read_internal_user', {
        error,
        data: {
          userId,
        },
      });
      return fail('Failed to read internal user');
    }
  }

  async getUserByUsername(username: string): Promise<Result<InternalAuthUser | null>> {
    const recordResult = await this.getUserRecordByUsername(username);
    if (!recordResult.ok) {
      return recordResult;
    }

    if (recordResult.value === null) {
      return succeed(null);
    }

    return succeed(stripPasswordHash(recordResult.value));
  }

  async getUserRecordByUsername(username: string): Promise<Result<InternalAuthUserRecord | null>> {
    try {
      return this.getUserRow(
        `
        SELECT
          id,
          business_number,
          username,
          display_name,
          role,
          password_hash,
          is_active,
          created_at,
          updated_at
        FROM internal_users
        WHERE username = ?
        LIMIT 1
      `,
        username
      );
    } catch (error) {
      authLog.error('failed_to_read_internal_user', {
        error,
        data: {
          username,
        },
      });
      return fail('Failed to read internal user');
    }
  }

  private async getUserRow(query: string, value: string): Promise<Result<InternalAuthUserRecord | null>> {
    const row = await this.db
      .prepare(query)
      .bind(value)
      .first<{
        id?: unknown;
        business_number?: unknown;
        username?: unknown;
        display_name?: unknown;
        role?: unknown;
        password_hash?: unknown;
        is_active?: unknown;
        created_at?: unknown;
        updated_at?: unknown;
      }>();

    return parseInternalUserRow(row);
  }
}

function stripPasswordHash(user: InternalAuthUserRecord): InternalAuthUser {
  return {
    id: user.id,
    businessNumber: user.businessNumber,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function createInternalSessionStore(env: InternalAuthEnv): Result<InternalSessionStore> {
  const dbResult = resolveSessionDatabase(env);
  if (!dbResult.ok) {
    return dbResult;
  }

  return succeed(new D1InternalSessionStore(dbResult.value));
}

export function createInternalUserStore(env: InternalAuthEnv): Result<InternalUserStore> {
  const dbResult = resolveSessionDatabase(env);
  if (!dbResult.ok) {
    return fail('Internal user store is not configured');
  }

  return succeed(new D1InternalUserStore(dbResult.value));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
}

function extractCookieValue(request: Request, cookieName: string): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) {
    return null;
  }

  for (const cookiePart of cookieHeader.split(';')) {
    const trimmedPart = cookiePart.trim();
    const separatorIndex = trimmedPart.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmedPart.slice(0, separatorIndex).trim();
    if (name !== cookieName) {
      continue;
    }

    return trimmedPart.slice(separatorIndex + 1).trim();
  }

  return null;
}

function parseSessionCookie(request: Request): Result<InternalSessionCookie> {
  const rawCookieValue = extractCookieValue(request, INTERNAL_SESSION_COOKIE_NAME);
  if (!rawCookieValue) {
    return fail('Missing session cookie');
  }

  const separatorIndex = rawCookieValue.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex >= rawCookieValue.length - 1) {
    return fail('Invalid session cookie');
  }

  const sessionId = rawCookieValue.slice(0, separatorIndex).trim();
  const signature = rawCookieValue.slice(separatorIndex + 1).trim();

  if (sessionId.length === 0 || signature.length === 0) {
    return fail('Invalid session cookie');
  }

  return succeed({
    sessionId,
    signature,
    value: rawCookieValue,
  });
}

async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', input.slice().buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function decodeBase64(value: string): Result<Uint8Array> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return succeed(bytes);
  } catch {
    return fail('Invalid internal password hash');
  }
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

export async function timingSafeEqualText(left: string, right: string): Promise<boolean> {
  const leftDigest = await sha256(textEncoder.encode(left));
  const rightDigest = await sha256(textEncoder.encode(right));
  return timingSafeEqualBytes(leftDigest, rightDigest);
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const normalizedSalt = Uint8Array.from(salt);
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: normalizedSalt,
      iterations,
    },
    key,
    PASSWORD_HASH_BYTES * 8
  );

  return new Uint8Array(bits);
}

function validateSubmittedPassword(password: string): Result<string> {
  if (password.length < 8) {
    return fail('Password must be at least 8 characters');
  }

  return succeed(password);
}

export function normalizeInternalUsername(username: string): Result<string> {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) {
    return fail('Username must be 3-64 characters and use letters, numbers, dots, underscores, or dashes');
  }

  return succeed(normalized);
}

export function normalizeInternalDisplayName(displayName: string): Result<string> {
  const normalized = displayName.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    return fail('Display name must be between 1 and 80 characters');
  }

  return succeed(normalized);
}

export function normalizeInternalBusinessNumber(businessNumber: string): Result<string> {
  const normalized = normalizePhone(businessNumber);
  if (!normalized) {
    return fail('businessNumber must be a valid phone number');
  }

  return succeed(normalized);
}

export async function hashInternalPassword(password: string): Promise<Result<string>> {
  const passwordResult = validateSubmittedPassword(password);
  if (!passwordResult.ok) {
    return passwordResult;
  }

  const salt = generateSalt();
  const derivedHash = await derivePasswordHash(passwordResult.value, salt, PASSWORD_HASH_ITERATIONS);

  return succeed(
    [
      PASSWORD_HASH_SCHEME,
      String(PASSWORD_HASH_ITERATIONS),
      encodeBase64(salt),
      encodeBase64(derivedHash),
    ].join('$')
  );
}

export async function verifyInternalUserPassword(
  submittedPassword: string,
  storedPasswordHash: string
): Promise<Result<boolean>> {
  const parts = storedPasswordHash.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_SCHEME) {
    return fail('Invalid internal password hash');
  }

  const iterations = Number.parseInt(parts[1] || '', 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return fail('Invalid internal password hash');
  }

  const saltResult = decodeBase64(parts[2] || '');
  if (!saltResult.ok) {
    return saltResult;
  }

  const hashResult = decodeBase64(parts[3] || '');
  if (!hashResult.ok) {
    return hashResult;
  }

  const derivedHash = await derivePasswordHash(submittedPassword, saltResult.value, iterations);
  return succeed(timingSafeEqualBytes(derivedHash, hashResult.value));
}

export async function authenticateInternalUser(
  userStore: InternalUserStore,
  input: {
    username: string;
    password: string;
  }
): Promise<Result<InternalAuthUser>> {
  const usernameResult = normalizeInternalUsername(input.username);
  if (!usernameResult.ok) {
    return fail('Invalid credentials');
  }

  const passwordResult = validateSubmittedPassword(input.password);
  if (!passwordResult.ok) {
    return fail('Invalid credentials');
  }

  const userResult = await userStore.getUserRecordByUsername(usernameResult.value);
  if (!userResult.ok) {
    return fail(userResult.error);
  }

  if (userResult.value === null) {
    return fail('Invalid credentials');
  }

  if (!userResult.value.isActive) {
    return fail('User inactive');
  }

  const passwordMatchesResult = await verifyInternalUserPassword(
    passwordResult.value,
    userResult.value.passwordHash
  );
  if (!passwordMatchesResult.ok) {
    return passwordMatchesResult;
  }

  if (!passwordMatchesResult.value) {
    return fail('Invalid credentials');
  }

  return succeed(stripPasswordHash(userResult.value));
}

export async function createInternalUserAccount(
  userStore: InternalUserStore,
  input: {
    businessNumber: string;
    username: string;
    displayName: string;
    role: InternalUserRole;
    password: string;
  }
): Promise<Result<InternalAuthUser>> {
  const businessNumberResult = normalizeInternalBusinessNumber(input.businessNumber);
  if (!businessNumberResult.ok) {
    return businessNumberResult;
  }

  const usernameResult = normalizeInternalUsername(input.username);
  if (!usernameResult.ok) {
    return usernameResult;
  }

  const displayNameResult = normalizeInternalDisplayName(input.displayName);
  if (!displayNameResult.ok) {
    return displayNameResult;
  }

  const passwordHashResult = await hashInternalPassword(input.password);
  if (!passwordHashResult.ok) {
    return passwordHashResult;
  }

  return userStore.createUser({
    businessNumber: businessNumberResult.value,
    username: usernameResult.value,
    displayName: displayNameResult.value,
    role: input.role,
    passwordHash: passwordHashResult.value,
  });
}

export function resolveBootstrapOwnerPassword(env: InternalAuthEnv): Result<string> {
  const password = env.INTERNAL_INBOX_PASSWORD ?? '';
  if (password.length < 8) {
    return fail('INTERNAL_INBOX_PASSWORD must be configured with at least 8 characters for owner bootstrap');
  }

  return succeed(password);
}

function resolveBootstrapBusinessNumber(env: InternalAuthEnv): Result<string> {
  const businessNumber = env.SYSTEMIX_NUMBER ?? '';
  const businessNumberResult = normalizeInternalBusinessNumber(businessNumber);
  if (!businessNumberResult.ok) {
    return fail('SYSTEMIX_NUMBER must be configured for owner bootstrap');
  }

  return businessNumberResult;
}

export async function createBootstrapOwner(
  userStore: InternalUserStore,
  env: InternalAuthEnv,
  overrides: {
    username?: string;
    displayName?: string;
    businessNumber?: string;
  } = {}
): Promise<Result<InternalAuthUser>> {
  const ownerCountResult = await userStore.countOwners();
  if (!ownerCountResult.ok) {
    return ownerCountResult;
  }

  if (ownerCountResult.value > 0) {
    return fail('Owner already exists');
  }

  const passwordResult = resolveBootstrapOwnerPassword(env);
  if (!passwordResult.ok) {
    return passwordResult;
  }

  const businessNumberResult = overrides.businessNumber
    ? normalizeInternalBusinessNumber(overrides.businessNumber)
    : resolveBootstrapBusinessNumber(env);
  if (!businessNumberResult.ok) {
    return businessNumberResult;
  }

  return createInternalUserAccount(userStore, {
    businessNumber: businessNumberResult.value,
    username: overrides.username ?? 'owner',
    displayName: overrides.displayName ?? 'Owner',
    role: 'owner',
    password: passwordResult.value,
  });
}

async function importSessionSecret(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

async function signSessionId(sessionId: string, secret: string): Promise<string> {
  const secretKey = await importSessionSecret(secret);
  const signature = await crypto.subtle.sign('HMAC', secretKey, textEncoder.encode(sessionId));
  return toHex(signature);
}

function resolveSessionSecret(env: InternalAuthEnv): Result<string> {
  const sessionSecret = env.SESSION_SECRET?.trim();
  if (!sessionSecret || sessionSecret.length < 32) {
    return fail('SESSION_SECRET must be configured with at least 32 characters');
  }

  return succeed(sessionSecret);
}

function buildSessionCookieValue(sessionId: string, signature: string): string {
  return `${sessionId}.${signature}`;
}

export function buildSessionCookieHeader(cookieValue: string, maxAgeSeconds: number): string {
  return [
    `${INTERNAL_SESSION_COOKIE_NAME}=${cookieValue}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function buildClearedSessionCookieHeader(): string {
  return [
    `${INTERNAL_SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

function resolveRequestIp(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfIp) {
    return cfIp;
  }

  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (!forwardedFor) {
    return null;
  }

  const firstIp = forwardedFor
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  return firstIp ?? null;
}

export async function createInternalSession(
  request: Request,
  env: InternalAuthEnv,
  sessionStore: InternalSessionStore,
  principal: {
    userId: string;
    role: InternalUserRole;
    businessNumber: string;
  }
): Promise<Result<{ cookieHeader: string; expiresAt: string; sessionId: string }>> {
  const sessionSecretResult = resolveSessionSecret(env);
  if (!sessionSecretResult.ok) {
    return sessionSecretResult;
  }

  const sessionId = generateSessionId();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + INTERNAL_SESSION_TTL_SECONDS * 1000).toISOString();
  const sessionResult = await sessionStore.createSession({
    id: sessionId,
    createdAt,
    expiresAt,
    ip: resolveRequestIp(request),
    userId: principal.userId,
    role: principal.role,
    businessNumber: principal.businessNumber,
  });

  if (!sessionResult.ok) {
    return sessionResult;
  }

  const signature = await signSessionId(sessionId, sessionSecretResult.value);
  const cookieHeader = buildSessionCookieHeader(
    buildSessionCookieValue(sessionId, signature),
    INTERNAL_SESSION_TTL_SECONDS
  );

  return succeed({
    cookieHeader,
    expiresAt,
    sessionId,
  });
}

export async function getInternalSessionWithStore(
  request: Request,
  env: InternalAuthEnv,
  sessionStore: InternalSessionStore,
  userStore: InternalUserStore
): Promise<Result<InternalSession>> {
  const sessionSecretResult = resolveSessionSecret(env);
  if (!sessionSecretResult.ok) {
    return sessionSecretResult;
  }

  const cookieResult = parseSessionCookie(request);
  if (!cookieResult.ok) {
    return cookieResult;
  }

  const expectedSignature = await signSessionId(cookieResult.value.sessionId, sessionSecretResult.value);
  const signatureMatches = await timingSafeEqualText(cookieResult.value.signature, expectedSignature);

  if (!signatureMatches) {
    return fail('Invalid session cookie');
  }

  const storedSessionResult = await sessionStore.getSession(cookieResult.value.sessionId);
  if (!storedSessionResult.ok) {
    return storedSessionResult;
  }

  if (storedSessionResult.value === null) {
    return fail('Session not found');
  }

  const expiresAtMs = Date.parse(storedSessionResult.value.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    await sessionStore.deleteSession(cookieResult.value.sessionId);
    return fail('Session expired');
  }

  const roleResult = parseInternalUserRole(storedSessionResult.value.role);
  const businessNumber = normalizePhone(storedSessionResult.value.businessNumber || '');
  if (!roleResult.ok || !storedSessionResult.value.userId || !businessNumber) {
    await sessionStore.deleteSession(cookieResult.value.sessionId);
    return fail('Session invalid');
  }

  const userResult = await userStore.getUserById(storedSessionResult.value.userId);
  if (!userResult.ok) {
    return fail(userResult.error);
  }

  if (userResult.value === null || !userResult.value.isActive) {
    await sessionStore.deleteSession(cookieResult.value.sessionId);
    return fail('Session invalid');
  }

  if (
    userResult.value.role !== roleResult.value ||
    userResult.value.businessNumber !== businessNumber
  ) {
    await sessionStore.deleteSession(cookieResult.value.sessionId);
    return fail('Session invalid');
  }

  return succeed({
    id: storedSessionResult.value.id,
    createdAt: storedSessionResult.value.createdAt,
    expiresAt: storedSessionResult.value.expiresAt,
    ip: storedSessionResult.value.ip,
    userId: storedSessionResult.value.userId,
    role: roleResult.value,
    businessNumber,
    user: userResult.value,
  });
}

export async function validateInternalSession(request: Request, env: InternalAuthEnv): Promise<Result<void>> {
  const sessionStoreResult = createInternalSessionStore(env);
  if (!sessionStoreResult.ok) {
    return sessionStoreResult;
  }

  const userStoreResult = createInternalUserStore(env);
  if (!userStoreResult.ok) {
    return userStoreResult;
  }

  const sessionResult = await getInternalSessionWithStore(
    request,
    env,
    sessionStoreResult.value,
    userStoreResult.value
  );
  if (!sessionResult.ok) {
    return fail(sessionResult.error);
  }

  return succeed(undefined);
}

export async function clearInternalSession(
  request: Request,
  env: InternalAuthEnv,
  sessionStore: InternalSessionStore
): Promise<Result<string>> {
  const sessionSecretResult = resolveSessionSecret(env);
  if (!sessionSecretResult.ok) {
    return sessionSecretResult;
  }

  const cookieResult = parseSessionCookie(request);
  if (!cookieResult.ok) {
    return cookieResult;
  }

  const expectedSignature = await signSessionId(cookieResult.value.sessionId, sessionSecretResult.value);
  const signatureMatches = await timingSafeEqualText(cookieResult.value.signature, expectedSignature);
  if (!signatureMatches) {
    return fail('Invalid session cookie');
  }

  const deleteResult = await sessionStore.deleteSession(cookieResult.value.sessionId);
  if (!deleteResult.ok) {
    return deleteResult;
  }

  return succeed(buildClearedSessionCookieHeader());
}

function resolveAllowedOrigin(env: InternalAuthEnv): Result<string> {
  const allowedOrigin = env.ALLOWED_ORIGIN?.trim();
  if (!allowedOrigin) {
    return fail('ALLOWED_ORIGIN must be configured');
  }

  if (allowedOrigin === '*') {
    return fail('ALLOWED_ORIGIN must not be "*"');
  }

  return succeed(allowedOrigin);
}

export function resolveInternalCorsPolicy(
  request: Request,
  env: InternalAuthEnv
): Result<InternalCorsPolicy> {
  const allowedOriginResult = resolveAllowedOrigin(env);
  if (!allowedOriginResult.ok) {
    return allowedOriginResult;
  }

  const requestOrigin = request.headers.get('Origin')?.trim() ?? null;
  const isAllowedOrigin =
    requestOrigin !== null && requestOrigin.length > 0 && requestOrigin === allowedOriginResult.value;

  return succeed({
    headers: {
      'Access-Control-Allow-Origin': allowedOriginResult.value,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-GTM-Admin-Key',
      Vary: 'Origin',
    },
    isAllowedOrigin,
    requestOrigin,
  });
}

export function resolveInternalCorsHeaders(
  request: Request,
  env: InternalAuthEnv
): Result<Record<string, string> | null> {
  const corsPolicyResult = resolveInternalCorsPolicy(request, env);
  if (!corsPolicyResult.ok) {
    return corsPolicyResult;
  }

  if (!corsPolicyResult.value.isAllowedOrigin) {
    return succeed(null);
  }

  return succeed({
    'Access-Control-Allow-Origin': corsPolicyResult.value.headers['Access-Control-Allow-Origin'],
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-GTM-Admin-Key',
    Vary: 'Origin',
  });
}

export function isLegacyGtmAdminAuthorized(request: Request, env: InternalAuthEnv): boolean {
  const configuredAdminKey = env.GTM_ADMIN_KEY?.trim();
  if (!configuredAdminKey) {
    return false;
  }

  const requestAdminKey = request.headers.get('X-GTM-Admin-Key')?.trim();
  return requestAdminKey === configuredAdminKey;
}

export function isInternalRoute(pathname: string): boolean {
  return pathname.startsWith('/v1/internal/');
}

export function getInternalSessionTtlSeconds(): number {
  return INTERNAL_SESSION_TTL_SECONDS;
}
