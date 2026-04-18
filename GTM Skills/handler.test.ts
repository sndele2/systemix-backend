/**
 * handler.test.ts
 *
 * Tests for GTM HTTP handlers and core service behaviour.
 *
 * Testing strategy:
 *   - Unit tests for SequenceEngine (pure logic, no I/O)
 *   - Unit tests for renderTemplate (prompts.ts)
 *   - Integration tests for GTMService with a stubbed LeadStore + EmailClient
 *   - Handler tests with mocked service
 *
 * Do NOT write tests that hit real email providers or real databases.
 * Use dependency injection (pass stubs into constructors) to keep tests fast.
 *
 * Run with: npx jest gtm/handler.test.ts (or your project's test command)
 */

import { SequenceEngine } from './sequence-engine';
import { renderTemplate, TEMPLATE_KEYS } from './prompts';
import type { GTMConfig, Lead } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testConfig: GTMConfig = {
  fromEmail: 'test@example.com',
  fromName: 'Test Business',
  maxTouches: 3,
  dryRun: true,
  storeConnectionString: 'memory://',
};

const testLead: Lead = {
  id: 'lead-001',
  name: 'Alex Smith',
  email: 'alex@example.com',
  createdAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// SequenceEngine
// ---------------------------------------------------------------------------

describe('SequenceEngine', () => {
  const engine = new SequenceEngine(testConfig);

  it('returns a send decision for touch 0 on a fresh lead', () => {
    const decision = engine.next(0, 'active');
    expect(decision.action).toBe('send');
    if (decision.action === 'send') {
      expect(decision.stage.stageIndex).toBe(0);
    }
  });

  it('returns exhausted after all touches sent', () => {
    const decision = engine.next(3, 'active');
    expect(decision.action).toBe('stop');
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('exhausted');
    }
  });

  it('stops immediately when lead has replied', () => {
    const decision = engine.next(1, 'replied');
    expect(decision.action).toBe('stop');
    if (decision.action === 'stop') {
      expect(decision.reason).toBe('replied');
    }
  });

  it('respects maxTouches ceiling from config', () => {
    const limitedEngine = new SequenceEngine({ ...testConfig, maxTouches: 1 });
    expect(limitedEngine.getSequence().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderTemplate (prompts.ts)
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
  const ctx = {
    lead: testLead,
    businessName: 'Test Business',
    replyContact: 'test@example.com',
  };

  it('renders touch 1 with lead name in subject', () => {
    const result = renderTemplate(TEMPLATE_KEYS.MISSED_CALL_TOUCH_1, ctx);
    expect(result.subject).toContain(testLead.name);
    expect(result.body).toContain(testLead.name);
  });

  it('renders touch 3 as a closing message', () => {
    const result = renderTemplate(TEMPLATE_KEYS.MISSED_CALL_TOUCH_3, ctx);
    expect(result.subject.toLowerCase()).toContain('closing');
  });

  it('throws on unknown template key', () => {
    expect(() =>
      renderTemplate('nonexistent-key' as never, ctx),
    ).toThrow('unknown template key');
  });
});

// ---------------------------------------------------------------------------
// GTMService (integration — TODO: implement when service.ts is built out)
// ---------------------------------------------------------------------------

describe('GTMService', () => {
  it.todo('startSequence persists lead before scheduling');
  it.todo('advanceSequence is a no-op when lead status is replied');
  it.todo('advanceSequence does not send when dryRun is true');
  it.todo('stopSequence updates status to the provided reason');
  it.todo('startSequence throws if lead is already active');
});
