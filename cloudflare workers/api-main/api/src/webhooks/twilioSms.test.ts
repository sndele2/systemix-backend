// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasRecentInboundMessageDuplicate,
  normalizeInboundMessageBodyForDedup,
  shouldSendOwnerLeadNotification,
} from './twilioSms.ts';

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

  async all() {
    return this.db.handleAll(this.sql, this.boundArgs);
  }

  async first() {
    return this.db.handleFirst(this.sql, this.boundArgs);
  }
}

class MockDatabase {
  constructor({ duplicateBodies = [], inboundCount = 0 } = {}) {
    this.duplicateBodies = duplicateBodies;
    this.inboundCount = inboundCount;
  }

  prepare(sql) {
    return new MockPreparedStatement(this, sql);
  }

  async handleAll(sql) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('select body from messages')) {
      return {
        results: this.duplicateBodies.map((body) => ({ body })),
      };
    }

    throw new Error(`Unhandled all() SQL: ${normalized}`);
  }

  async handleFirst(sql) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('select count(*) as inbound_count from messages')) {
      return {
        inbound_count: this.inboundCount,
      };
    }

    throw new Error(`Unhandled first() SQL: ${normalized}`);
  }
}

test('normalizeInboundMessageBodyForDedup trims, collapses whitespace, and lowercases', () => {
  assert.equal(
    normalizeInboundMessageBodyForDedup('  Need   HELP   ASAP  '),
    'need help asap'
  );
});

test('hasRecentInboundMessageDuplicate matches a normalized body within the window', async () => {
  const env = {
    SYSTEMIX: new MockDatabase({
      duplicateBodies: ['Need help ASAP'],
    }),
  };

  const isDuplicate = await hasRecentInboundMessageDuplicate(
    env,
    '+12175550123',
    '+18443217137',
    ' need   help asap '
  );

  assert.equal(isDuplicate, true);
});

test('shouldSendOwnerLeadNotification only fires for the first saved inbound customer message', async () => {
  const firstLeadEnv = {
    SYSTEMIX: new MockDatabase({
      inboundCount: 1,
    }),
  };
  const existingLeadEnv = {
    SYSTEMIX: new MockDatabase({
      inboundCount: 2,
    }),
  };

  assert.equal(
    await shouldSendOwnerLeadNotification(firstLeadEnv, '+18443217137', '+12175550123'),
    true
  );
  assert.equal(
    await shouldSendOwnerLeadNotification(existingLeadEnv, '+18443217137', '+12175550123'),
    false
  );
});
