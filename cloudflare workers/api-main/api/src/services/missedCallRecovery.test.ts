// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMissedCallRecoveryStats,
  RECOVERED_OPPORTUNITY_DEFINITION,
} from './missedCallRecovery.ts';

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

class MockPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.boundArgs = [];
  }

  bind(...args) {
    this.boundArgs = args;
    return this;
  }

  async first() {
    return this.db.handleFirst(this.sql, this.boundArgs);
  }

  async run() {
    return this.db.handleRun(this.sql, this.boundArgs);
  }
}

class MockDatabase {
  constructor(statsRow) {
    this.statsRow = statsRow;
  }

  prepare(sql) {
    return new MockPreparedStatement(this, sql);
  }

  async handleFirst(sql) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('select business_number, display_name, intake_question from businesses')) {
      return null;
    }

    if (normalized.includes('select count(*) as total_missed_calls')) {
      return this.statsRow;
    }

    throw new Error(`Unhandled first() SQL: ${normalized}`);
  }

  async handleRun() {
    return {
      meta: {
        changes: 0,
      },
    };
  }
}

test('getMissedCallRecoveryStats maps aggregate counts from the backend source of truth', async () => {
  const db = new MockDatabase({
    total_missed_calls: '12',
    total_customer_replies: '5',
    total_recovered_opportunities: '4',
  });

  const stats = await getMissedCallRecoveryStats(db);

  assert.deepEqual(stats, {
    totalMissedCalls: 12,
    totalCustomerReplies: 5,
    totalRecoveredOpportunities: 4,
  });
});

test('recovered opportunity definition stays aligned with the reporting endpoint', () => {
  assert.equal(
    RECOVERED_OPPORTUNITY_DEFINITION,
    'missed call + customer replied after the first auto-text'
  );
});
