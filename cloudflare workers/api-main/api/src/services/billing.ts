import { normalizePhone } from './smsCompliance.ts';

export type BillingMode = 'pilot' | 'live';

export type BillingBlockReasonCode =
  | 'internal_account'
  | 'billing_disabled'
  | 'business_not_found'
  | 'billing_mode_pilot';

export type BillingState = {
  businessNumber: string;
  displayName: string | null;
  ownerPhoneNumber: string | null;
  billingEnabled: boolean;
  billingMode: BillingMode;
  isInternal: boolean;
  isActive: boolean;
  liveBillingAllowed: boolean;
  reasonCode: BillingBlockReasonCode | null;
  reason: string | null;
  source: 'database' | 'default';
};

type BillingBusinessRow = {
  business_number?: string;
  display_name?: string | null;
  owner_phone_number?: string | null;
  billing_mode?: string | null;
  is_internal?: number | string | boolean | null;
  is_active?: number | string | boolean | null;
};

type BillingEnv = {
  BILLING_ENABLED?: string;
  SYSTEMIX_NUMBER?: string;
};

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('duplicate column name');
}

async function maybeAddColumn(db: D1Database, statement: string): Promise<void> {
  try {
    await db.prepare(statement).run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

function asBillingMode(value: unknown): BillingMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'live' ? 'live' : 'pilot';
}

function asBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }

  return false;
}

export function isBillingEnabled(env: Pick<BillingEnv, 'BILLING_ENABLED'>): boolean {
  return env.BILLING_ENABLED?.trim() === 'true';
}

export function normalizeBillingMode(value: unknown): BillingMode | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'pilot' || normalized === 'live') {
    return normalized;
  }

  return null;
}

export function normalizeInternalBillingFlag(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return null;
}

export async function ensureBillingSchema(db: D1Database): Promise<void> {
  await maybeAddColumn(db, "ALTER TABLE businesses ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'pilot'");
  await maybeAddColumn(db, 'ALTER TABLE businesses ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0');
}

function resolveBillingReason(state: {
  billingEnabled: boolean;
  businessExists: boolean;
  billingMode: BillingMode;
  isInternal: boolean;
}): { reasonCode: BillingBlockReasonCode | null; reason: string | null } {
  if (state.isInternal) {
    return {
      reasonCode: 'internal_account',
      reason: 'Internal and test accounts are permanently blocked from live billing.',
    };
  }

  if (!state.billingEnabled) {
    return {
      reasonCode: 'billing_disabled',
      reason: 'Live billing is globally disabled. Set BILLING_ENABLED=true to allow billing.',
    };
  }

  if (!state.businessExists) {
    return {
      reasonCode: 'business_not_found',
      reason:
        'Business billing state not found. Businesses default to pilot mode until explicitly marked live.',
    };
  }

  if (state.billingMode !== 'live') {
    return {
      reasonCode: 'billing_mode_pilot',
      reason: 'Business billing_mode is pilot. Only live businesses can use Stripe billing.',
    };
  }

  return {
    reasonCode: null,
    reason: null,
  };
}

export async function getBusinessBillingState(
  db: D1Database,
  env: BillingEnv,
  businessNumber: string
): Promise<BillingState> {
  await ensureBillingSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber) || businessNumber.trim();
  const row =
    (await db
      .prepare(
        `
        SELECT business_number, display_name, owner_phone_number, billing_mode, is_internal, is_active
        FROM businesses
        WHERE business_number = ?
        LIMIT 1
      `
      )
      .bind(normalizedBusinessNumber)
      .first<BillingBusinessRow>()) ?? null;

  const businessExists = Boolean(row?.business_number);
  const systemixNumber = normalizePhone(env.SYSTEMIX_NUMBER || '');
  const billingMode = asBillingMode(row?.billing_mode);
  const isInternal =
    asBooleanFlag(row?.is_internal) ||
    Boolean(systemixNumber && systemixNumber === normalizedBusinessNumber);
  const billingEnabled = isBillingEnabled(env);
  const isActive = businessExists ? !row || !('is_active' in row) || asBooleanFlag(row.is_active ?? 1) : false;
  const decision = resolveBillingReason({
    billingEnabled,
    businessExists,
    billingMode,
    isInternal,
  });

  return {
    businessNumber: normalizePhone(row?.business_number || '') || normalizedBusinessNumber,
    displayName: typeof row?.display_name === 'string' ? row.display_name.trim() || null : null,
    ownerPhoneNumber:
      normalizePhone(typeof row?.owner_phone_number === 'string' ? row.owner_phone_number : '') || null,
    billingEnabled,
    billingMode,
    isInternal,
    isActive,
    liveBillingAllowed: decision.reasonCode === null,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    source: businessExists ? 'database' : 'default',
  };
}
