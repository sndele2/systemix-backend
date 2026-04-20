// @ts-nocheck
/**
 * Exercises the GTM sequence engine and prompt rendering without requiring the full worker runtime.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGtmHandler, createGtmInternalRepliesHandler } from './handler.ts';
import { renderTemplate } from './prompts.ts';
import { SequenceEngine } from './sequence-engine.ts';

const sampleLead = {
  id: 'lead_123',
  name: 'Jordan',
  email: 'jordan@example.com',
  phone: '+13125550199',
  createdAt: '2026-04-09T00:00:00.000Z',
};

describe('SequenceEngine', () => {
  it('returns the first send decision for a pending lead', () => {
    const engine = new SequenceEngine({ maxTouches: 3 });

    assert.deepEqual(engine.next(0, 'pending'), {
      action: 'send',
      stage: {
        stageIndex: 0,
        delayHours: 1,
        templateKey: 'missed-call-touch-1',
      },
      delayHours: 1,
    });
  });

  it('stops immediately when the lead has replied', () => {
    const engine = new SequenceEngine({ maxTouches: 3 });

    assert.deepEqual(engine.next(1, 'replied'), {
      action: 'stop',
      reason: 'replied',
    });
  });

  it('stops with exhaustion once all touches have been sent', () => {
    const engine = new SequenceEngine({ maxTouches: 3 });

    assert.deepEqual(engine.next(3, 'active'), {
      action: 'stop',
      reason: 'exhausted',
    });
  });

  it('enforces the maxTouches ceiling by slicing the default sequence', () => {
    const engine = new SequenceEngine({ maxTouches: 1 });

    assert.deepEqual(engine.next(1, 'active'), {
      action: 'stop',
      reason: 'exhausted',
    });
  });
});

describe('renderTemplate', () => {
  it('includes the lead name in the subject', () => {
    const rendered = renderTemplate('missed-call-touch-1', sampleLead);

    assert.match(rendered.subject, /Jordan/);
  });

  it('throws on an unknown template key', () => {
    assert.throws(() => renderTemplate('unknown-template', sampleLead), /Unknown template key/);
  });
});

describe('GTMService integration', () => {
  it.todo('startSequence persists lead state before any email dispatch');
  it.todo('advanceSequence persists the next touch before sending');
  it.todo('stopSequence prevents any future touches once persisted');
});

function createHandlerServiceStub() {
  const calls = {
    getLeadsReadyForNextAction: 0,
    prepareNextAction: [],
    advanceLeadSequence: [],
  };

  const readyLeads = [
    {
      id: 'lead-ready-1',
      name: 'Jordan',
      email: 'jordan@example.com',
      createdAt: '2026-04-10T00:00:00.000Z',
      status: 'active',
      touches_sent: 0,
    },
    {
      id: 'lead-ready-2',
      name: 'Taylor',
      email: 'taylor@example.com',
      createdAt: '2026-04-11T00:00:00.000Z',
      status: 'active',
      touches_sent: 2,
      last_stage_index: 1,
      last_sent_at: '2026-04-12T00:00:00.000Z',
    },
  ];

  return {
    calls,
    service: {
      async createLead() {
        return { ok: true, value: undefined };
      },
      async startSequence() {
        return { ok: true, value: undefined };
      },
      async prepareNextAction(leadId) {
        calls.prepareNextAction.push(leadId);

        if (leadId === 'lead-ready-1') {
          return {
            ok: true,
            value: {
              action: 'send',
              stage: {
                stageIndex: 0,
                delayHours: 1,
                templateKey: 'missed-call-touch-1',
              },
              subject: 'Jordan, wanted to follow up on your call',
              body: 'Hi Jordan,\n\nChecking in.',
            },
          };
        }

        return {
          ok: true,
          value: {
            action: 'stop',
            reason: 'exhausted',
          },
        };
      },
      async advanceLeadSequence(leadId) {
        calls.advanceLeadSequence.push(leadId);

        if (leadId === 'lead-ready-1') {
          return {
            ok: true,
            value: {
              action: 'skipped',
              leadId,
              reason: 'dry_run',
            },
          };
        }

        return {
          ok: false,
          error: 'failed to persist touchpoint',
        };
      },
      async getLeadsReadyForNextAction() {
        calls.getLeadsReadyForNextAction += 1;
        return {
          ok: true,
          value: readyLeads,
        };
      },
      async recordReply() {
        return { ok: true, value: undefined };
      },
    },
  };
}

function createReplyInboxServiceStub() {
  const calls = {
    syncAndListReplies: [],
    listRepliesForLead: [],
  };

  return {
    calls,
    service: {
      async syncAndListReplies(limit, matchedOnly) {
        calls.syncAndListReplies.push({ limit, matchedOnly });
        return {
          ok: true,
          value: {
            synced_at: '2026-04-16T12:05:00.000Z',
            new_replies_found: 2,
            replies: [
              {
                id: 'reply-1',
                lead_id: 'lead-ready-1',
                from_email: 'jordan@example.com',
                subject: 'Re: missed call',
                body_snippet: 'Please call me back.',
                received_at: '2026-04-16T12:00:00.000Z',
                conversation_id: 'conversation-1',
                classification: 'reply_detected',
                sequence_stopped: true,
                raw_provider_id: 'reply-1',
                created_at: '2026-04-16T12:00:01.000Z',
              },
            ],
          },
        };
      },
      async listRepliesForLead(leadId) {
        calls.listRepliesForLead.push(leadId);

        if (leadId === 'missing-lead') {
          return {
            ok: false,
            error: 'Lead not found',
          };
        }

        return {
          ok: true,
          value: {
            synced_at: '2026-04-16T12:05:00.000Z',
            new_replies_found: 0,
            replies: [
              {
                id: 'reply-1',
                lead_id: leadId,
                from_email: 'jordan@example.com',
                subject: 'Re: missed call',
                body_snippet: 'Please call me back.',
                received_at: '2026-04-16T12:00:00.000Z',
                conversation_id: 'conversation-1',
                classification: 'reply_detected',
                sequence_stopped: true,
                raw_provider_id: 'reply-1',
                created_at: '2026-04-16T12:00:01.000Z',
              },
            ],
          },
        };
      },
    },
  };
}

describe('createGtmHandler manual trigger routes', () => {
  it('rejects manual preview without internal auth', async () => {
    const { service } = createHandlerServiceStub();
    const app = createGtmHandler(service);

    const response = await app.request('http://example.com/gtm/internal/manual/preview', {
      method: 'POST',
    }, {
      INTERNAL_AUTH_KEY: 'secret',
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  });

  it('returns preview results for eligible leads and explains skipped requested leads', async () => {
    const { service, calls } = createHandlerServiceStub();
    const app = createGtmHandler(service);

    const response = await app.request(
      'http://example.com/gtm/internal/manual/preview',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leadIds: ['lead-ready-1', 'lead-missing'],
        }),
      },
      {
        INTERNAL_AUTH_KEY: 'secret',
      }
    );

    assert.equal(response.status, 200);

    const json = await response.json();
    assert.equal(json.eligibleCount, 1);
    assert.deepEqual(json.requestedLeadIds, ['lead-ready-1', 'lead-missing']);
    assert.deepEqual(json.results, [
      {
        leadId: 'lead-ready-1',
        status: 'active',
        touchesSent: 0,
        action: 'send',
        reason: 'ready_for_next_action',
        stageIndex: 0,
        subject: 'Jordan, wanted to follow up on your call',
        body: 'Hi Jordan,\n\nChecking in.',
      },
      {
        leadId: 'lead-missing',
        status: 'unknown',
        touchesSent: 0,
        action: 'skipped',
        reason: 'not_ready_for_next_action',
      },
    ]);
    assert.equal(calls.getLeadsReadyForNextAction, 1);
    assert.deepEqual(calls.prepareNextAction, ['lead-ready-1']);
  });

  it('advances only eligible leads and returns per-lead results', async () => {
    const { service, calls } = createHandlerServiceStub();
    const app = createGtmHandler(service);

    const response = await app.request(
      'http://example.com/gtm/internal/manual/advance',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leadIds: ['lead-ready-1', 'lead-ready-2', 'lead-not-due'],
        }),
      },
      {
        INTERNAL_AUTH_KEY: 'secret',
      }
    );

    assert.equal(response.status, 202);

    const json = await response.json();
    assert.equal(json.eligibleCount, 2);
    assert.deepEqual(json.results, [
      {
        leadId: 'lead-ready-1',
        action: 'skipped',
        reason: 'dry_run',
      },
      {
        leadId: 'lead-ready-2',
        action: 'error',
        reason: 'failed to persist touchpoint',
      },
      {
        leadId: 'lead-not-due',
        action: 'skipped',
        reason: 'not_ready_for_next_action',
      },
    ]);
    assert.equal(calls.getLeadsReadyForNextAction, 1);
    assert.deepEqual(calls.advanceLeadSequence, ['lead-ready-1', 'lead-ready-2']);
  });
});

describe('createGtmInternalRepliesHandler', () => {
  it('syncs and returns replies after middleware auth has already passed', async () => {
    const { service, calls } = createReplyInboxServiceStub();
    const app = createGtmInternalRepliesHandler(() => service);

    const response = await app.request('http://example.com/v1/internal/gtm/replies?limit=250&matched_only=true', {}, {
      GTM_DB: {},
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls.syncAndListReplies, [{ limit: 200, matchedOnly: true }]);
    assert.deepEqual(await response.json(), {
      synced_at: '2026-04-16T12:05:00.000Z',
      new_replies_found: 2,
      replies: [
        {
          id: 'reply-1',
          lead_id: 'lead-ready-1',
          from_email: 'jordan@example.com',
          subject: 'Re: missed call',
          body_snippet: 'Please call me back.',
          received_at: '2026-04-16T12:00:00.000Z',
          conversation_id: 'conversation-1',
          classification: 'reply_detected',
          sequence_stopped: true,
          raw_provider_id: 'reply-1',
          created_at: '2026-04-16T12:00:01.000Z',
        },
      ],
    });
  });

  it('returns 404 when the lead reply route targets a missing lead', async () => {
    const { service, calls } = createReplyInboxServiceStub();
    const app = createGtmInternalRepliesHandler(() => service);

    const response = await app.request('http://example.com/v1/internal/gtm/replies/missing-lead', {}, {
      GTM_DB: {},
    });

    assert.equal(response.status, 404);
    assert.deepEqual(calls.listRepliesForLead, ['missing-lead']);
    assert.deepEqual(await response.json(), {
      error: 'Lead not found',
    });
  });
});
