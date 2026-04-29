import { readFileSync } from 'node:fs';

import { exportGtmResearchLeadsToCsv } from '../src/gtm/csv.ts';

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node --experimental-strip-types scripts/gtm-research-csv.ts researched-leads.json');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
const leads = Array.isArray(parsed) ? parsed : parsed.leads;

if (!Array.isArray(leads)) {
  console.error('Input JSON must be an array or an object with a leads array.');
  process.exit(1);
}

const csvResult = exportGtmResearchLeadsToCsv(leads);
if (!csvResult.ok) {
  console.error(csvResult.error);
  process.exit(1);
}

process.stdout.write(csvResult.value);
