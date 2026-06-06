// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableLeadStore } from './lead-store.ts';
class ThrowingStatement { bind(){ return this; } async run(){ throw new Error('simulated D1 failure'); } async first(){ throw new Error('simulated D1 failure'); } async all(){ throw new Error('simulated D1 failure'); } }
class ThrowingD1 { prepare(){ return new ThrowingStatement(); } }
async function capture(fn){ const calls=[]; const orig=console.error; console.error=(...a)=>calls.push(a); try { await fn(); } finally { console.error=orig; } return JSON.stringify(calls); }
const APPROVAL = { id:'appr-1', approval_code:'SECRET12', lead_id:'lead-1', stage_index:0, proposal_hash:'h', subject:'s', body:'b', status:'pending', requested_at:'2026-01-01T00:00:00Z' };

test('FIX: createApproval logs neither the code nor any ref; keeps approvalId + leadId', async () => {
  const logged = await capture(() => new DurableLeadStore(new ThrowingD1()).createApproval(APPROVAL));
  assert.ok(!logged.includes('SECRET12'), 'full code must be gone');
  assert.ok(!logged.includes('SE***('), 'no derived ref of any kind');
  assert.ok(logged.includes('appr-1'), 'approvalId retained for correlation');
  assert.ok(logged.includes('lead-1'), 'leadId retained for correlation');
});
test('FIX: resolveApprovalByCode logs neither the code nor any ref', async () => {
  const logged = await capture(() => new DurableLeadStore(new ThrowingD1()).resolveApprovalByCode('SECRET34','approved','2026-01-01T00:00:00Z','+15550000000'));
  assert.ok(!logged.includes('SECRET34'), 'full code must be gone');
  assert.ok(!logged.includes('SE***('), 'no derived ref of any kind');
  assert.ok(logged.includes('resolveApprovalByCode'), 'operation name retained');
  assert.ok(logged.includes('approved'), 'status retained');
});
