import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

const DEFAULT_WELCOME_URL = 'https://systemixai.co/';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(scriptDir, '../.dev.vars'),
  resolve(scriptDir, '../../.dev.vars'),
  resolve(scriptDir, '../../../.dev.vars'),
  resolve(scriptDir, '../../../.env'),
  resolve(scriptDir, '../../../../.dev.vars'),
  resolve(scriptDir, '../../../../.env'),
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

function requireEnvVar(name: string): string {
  const value = readEnvVar(name);
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

async function main() {
  const secretKey = requireEnvVar('STRIPE_SECRET_KEY');
  if (!secretKey.startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY must be a live Stripe secret key.');
  }

  const priceId = requireEnvVar('STRIPE_PRICE_ID');
  const businessNumber = requireEnvVar('BUSINESS_NUMBER');
  const ownerPhoneNumber = requireEnvVar('OWNER_PHONE_NUMBER');
  const displayName = requireEnvVar('DISPLAY_NAME');
  const welcomeUrl = readEnvVar('SYSTEMIX_WELCOME_URL') || DEFAULT_WELCOME_URL;

  const stripe = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const metadata = {
    business_number: businessNumber,
    owner_phone_number: ownerPhoneNumber,
    display_name: displayName,
  };

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    metadata,
    subscription_data: {
      metadata,
    },
    after_completion: {
      type: 'redirect',
      redirect: {
        url: welcomeUrl,
      },
    },
  });

  if (!paymentLink.url.startsWith('https://buy.stripe.com/')) {
    throw new Error(`Unexpected Stripe payment link URL: ${paymentLink.url}`);
  }

  console.log(
    JSON.stringify(
      {
        url: paymentLink.url,
        id: paymentLink.id,
        metadata: paymentLink.metadata,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error('[STRIPE] Failed to create live payment link');
  console.error(error);
  process.exit(1);
});
