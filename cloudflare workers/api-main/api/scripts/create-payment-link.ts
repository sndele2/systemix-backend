import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

const PRICE_ID = 'price_1TAbXB6pK2eA6wDcXI1Rb1fU';

const METADATA = {
  business_number: '+18443217137',
  owner_phone_number: '+12179912895',
  display_name: 'Systemix Test Business',
} as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(scriptDir, '../.dev.vars'),
  resolve(scriptDir, '../../../../.dev.vars'),
];

function readEnvVar(name: string): string | undefined {
  const directValue = process.env[name]?.trim();
  if (directValue) {
    return directValue;
  }

  for (const envPath of envCandidates) {
    if (!existsSync(envPath)) {
      continue;
    }

    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      if (key !== name) {
        continue;
      }

      const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
      if (!rawValue) {
        continue;
      }

      if (
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        return rawValue.slice(1, -1);
      }

      return rawValue;
    }
  }

  return undefined;
}

async function main() {
  const secretKey = readEnvVar('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error(
      'Missing STRIPE_SECRET_KEY. Set it in the environment or in a local .dev.vars file.'
    );
  }

  const stripe = new Stripe(secretKey);

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      {
        price: PRICE_ID,
        quantity: 1,
      },
    ],
    metadata: METADATA,
    subscription_data: {
      metadata: METADATA,
    },
  });

  console.log(`Payment Link URL: ${paymentLink.url}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create payment link: ${message}`);
  process.exitCode = 1;
});
