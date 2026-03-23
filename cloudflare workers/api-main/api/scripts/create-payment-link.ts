import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

type ParsedArgs = {
  priceId: string;
  businessNumber: string;
  ownerPhoneNumber: string;
  displayName: string;
};

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

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    values.set(key, value.trim());
    index += 1;
  }

  const priceId = values.get('price-id') || '';
  const businessNumber = values.get('business-number') || '';
  const ownerPhoneNumber = values.get('owner-phone-number') || '';
  const displayName = values.get('display-name') || '';

  if (!priceId || !businessNumber || !ownerPhoneNumber || !displayName) {
    throw new Error(
      'Usage: npm run create-payment-link -- --price-id <price_id> --business-number <E164> --owner-phone-number <E164> --display-name "<name>"'
    );
  }

  return {
    priceId,
    businessNumber,
    ownerPhoneNumber,
    displayName,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secretKey = readEnvVar('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('Missing STRIPE_SECRET_KEY.');
  }

  if (!secretKey.startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY must be a live Stripe secret key.');
  }

  const stripe = new Stripe(secretKey);
  const metadata = {
    business_number: args.businessNumber,
    owner_phone_number: args.ownerPhoneNumber,
    display_name: args.displayName,
  };

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      {
        price: args.priceId,
        quantity: 1,
      },
    ],
    metadata,
    subscription_data: {
      metadata,
    },
  });

  if (!paymentLink.url.startsWith('https://buy.stripe.com/')) {
    throw new Error(`Unexpected Stripe payment link URL: ${paymentLink.url}`);
  }

  console.log(paymentLink.url);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to create payment link: ${message}`);
  process.exitCode = 1;
});
