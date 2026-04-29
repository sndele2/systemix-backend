import assert from 'node:assert/strict';
import test from 'node:test';

import { exportGtmResearchLeadsToCsv, parseGtmResearchCsv } from './csv.ts';

test('exports and parses reviewed GTM research leads as CSV', () => {
  const exported = exportGtmResearchLeadsToCsv([
    {
      businessName: 'Jordan Detail',
      contactName: 'Jordan',
      niche: 'mobile detailing',
      city: 'Chicago',
      state: 'IL',
      website: 'https://jordandetail.example.com',
      email: 'jordan@detail.example.com',
      phone: '+13125550111',
      sourceUrl: 'https://source.example.com/jordan',
      sourceType: 'website',
      evidence: 'Site lists mobile detailing and contact email.',
      confidence: 0.86,
      researchNotes: 'Owner-operator mobile detailing.',
      outreachAngle: 'missed_call_recovery',
      approvalStatus: 'approved',
      importStatus: 'approved',
    },
  ]);

  assert.equal(exported.ok, true);
  assert.match(exported.value, /businessName,contactName,niche/);
  assert.match(exported.value, /Jordan Detail/);

  const parsed = parseGtmResearchCsv(exported.value);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.length, 1);
  assert.equal(parsed.value[0].businessName, 'Jordan Detail');
  assert.equal(parsed.value[0].sourceUrl, 'https://source.example.com/jordan');
  assert.equal(parsed.value[0].evidence, 'Site lists mobile detailing and contact email.');
});

test('CSV export rejects researched leads without source evidence', () => {
  const exported = exportGtmResearchLeadsToCsv([
    {
      businessName: 'No Source',
      email: 'owner@nosource.example',
      sourceUrl: '',
      evidence: '',
    },
  ]);

  assert.deepEqual(exported, {
    ok: false,
    error: 'sourceUrl must be a valid URL',
  });
});
