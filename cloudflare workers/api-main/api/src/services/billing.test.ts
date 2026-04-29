import assert from 'node:assert/strict';
import test from 'node:test';
import { getBusinessBillingState } from './billing.ts';

class FakeStatement {
  readonly db: FakeBillingDatabase;
  readonly sql: string;
  boundValues: unknown[] = [];

  constructor(db: FakeBillingDatabase, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async first<T>() {
    return this.db.first<T>(this.boundValues);
  }

  async run() {
    return this.db.run(this.sql);
  }
}

class FakeBillingDatabase {
  readonly businesses = new Map<
    string,
    {
      business_number: string;
      display_name?: string | null;
      owner_phone_number?: string | null;
      billing_mode?: string | null;
      is_internal?: number;
      is_active?: number;
    }
  >();

  constructor(
    businesses: Array<{
      business_number: string;
      display_name?: string | null;
      owner_phone_number?: string | null;
      billing_mode?: string | null;
      is_internal?: number;
      is_active?: number;
    }> = []
  ) {
    for (const business of businesses) {
      this.businesses.set(business.business_number, business);
    }
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  private normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async first<T>(boundValues: unknown[]) {
    const businessNumber = String(boundValues[0] ?? '');
    return (this.businesses.get(businessNumber) ?? null) as T | null;
  }

  async run(sql: string) {
    const normalizedSql = this.normalizeSql(sql);
    if (normalizedSql.startsWith('alter table businesses add column')) {
      return { meta: { changes: 0 } };
    }

    throw new Error(`Unexpected SQL in billing test: ${sql}`);
  }
}

test('billing blocks live billing globally when BILLING_ENABLED is false', async () => {
  const db = new FakeBillingDatabase([
    {
      business_number: '+18005550100',
      display_name: 'Pilot Shop',
      owner_phone_number: '+13125550100',
      billing_mode: 'live',
      is_internal: 0,
      is_active: 1,
    },
  ]);

  const state = await getBusinessBillingState(
    db as unknown as D1Database,
    { BILLING_ENABLED: 'false' },
    '+18005550100'
  );

  assert.equal(state.liveBillingAllowed, false);
  assert.equal(state.reasonCode, 'billing_disabled');
});

test('billing blocks pilot businesses even when BILLING_ENABLED is true', async () => {
  const db = new FakeBillingDatabase([
    {
      business_number: '+18005550101',
      display_name: 'Pilot Shop',
      owner_phone_number: '+13125550101',
      billing_mode: 'pilot',
      is_internal: 0,
      is_active: 1,
    },
  ]);

  const state = await getBusinessBillingState(
    db as unknown as D1Database,
    { BILLING_ENABLED: 'true' },
    '+18005550101'
  );

  assert.equal(state.liveBillingAllowed, false);
  assert.equal(state.reasonCode, 'billing_mode_pilot');
});

test('billing allows only live businesses when BILLING_ENABLED is true', async () => {
  const db = new FakeBillingDatabase([
    {
      business_number: '+18005550102',
      display_name: 'Live Shop',
      owner_phone_number: '+13125550102',
      billing_mode: 'live',
      is_internal: 0,
      is_active: 1,
    },
  ]);

  const state = await getBusinessBillingState(
    db as unknown as D1Database,
    { BILLING_ENABLED: 'true' },
    '+18005550102'
  );

  assert.equal(state.liveBillingAllowed, true);
  assert.equal(state.reasonCode, null);
});

test('billing always blocks internal businesses', async () => {
  const db = new FakeBillingDatabase([
    {
      business_number: '+18005550103',
      display_name: 'Internal Test',
      owner_phone_number: '+13125550103',
      billing_mode: 'live',
      is_internal: 1,
      is_active: 1,
    },
  ]);

  const state = await getBusinessBillingState(
    db as unknown as D1Database,
    { BILLING_ENABLED: 'true' },
    '+18005550103'
  );

  assert.equal(state.liveBillingAllowed, false);
  assert.equal(state.reasonCode, 'internal_account');
});
