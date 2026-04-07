import { createLogger } from './logging.ts';

export type TwilioSignatureMode = 'off' | 'log' | 'enforce';

type TwilioSignatureEnv = {
  TWILIO_AUTH_TOKEN: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
  WORKER_URL?: string;
};

const twilioLog = createLogger('[TWILIO]', 'checkTwilioSignature');

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const messageData = new TextEncoder().encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return toBase64(new Uint8Array(signature));
}

function resolveMode(env: TwilioSignatureEnv): TwilioSignatureMode {
  const configured = (env.TWILIO_SIGNATURE_MODE || '').toLowerCase();
  if (configured === 'off' || configured === 'log' || configured === 'enforce') {
    return configured;
  }
  return env.ENVIRONMENT === 'production' ? 'enforce' : 'off';
}

function resolveWorkerBaseUrl(env: Pick<TwilioSignatureEnv, 'WORKER_URL'>, requestUrl: string): URL {
  const configuredWorkerUrl = (env.WORKER_URL || '').trim();
  const baseUrl = new URL(configuredWorkerUrl || requestUrl);
  baseUrl.protocol = 'https:';
  baseUrl.username = '';
  baseUrl.password = '';
  baseUrl.pathname = '/';
  baseUrl.search = '';
  baseUrl.hash = '';
  return baseUrl;
}

export function buildTwilioValidationUrl(
  env: Pick<TwilioSignatureEnv, 'WORKER_URL'>,
  requestUrl: string
): string {
  const incomingUrl = new URL(requestUrl);
  const publicUrl = resolveWorkerBaseUrl(env, requestUrl);
  publicUrl.pathname = incomingUrl.pathname;
  publicUrl.search = incomingUrl.search;
  return publicUrl.toString();
}

export function buildWorkerCallbackUrl(
  env: Pick<TwilioSignatureEnv, 'WORKER_URL'>,
  requestUrl: string,
  pathname: string,
  params?: URLSearchParams
): string {
  const publicUrl = resolveWorkerBaseUrl(env, requestUrl);
  publicUrl.pathname = pathname;
  publicUrl.search = params && params.size > 0 ? `?${params.toString()}` : '';
  return publicUrl.toString();
}

export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string
): Promise<boolean> {
  if (!authToken || !signatureHeader) return false;

  const sortedNames = Object.keys(params).sort((a, b) => a.localeCompare(b));
  let payload = url;
  for (const name of sortedNames) {
    payload += `${name}${params[name]}`;
  }

  const expected = await hmacSha1Base64(authToken, payload);
  return timingSafeEqual(expected, signatureHeader);
}

export async function checkTwilioSignature(
  env: TwilioSignatureEnv,
  requestUrl: string,
  params: Record<string, string>,
  signatureHeader?: string
): Promise<{ ok: boolean; mode: TwilioSignatureMode; reason?: string }> {
  const mode = resolveMode(env);
  if (mode === 'off') return { ok: true, mode };

  const urlUsedForSignature = buildTwilioValidationUrl(env, requestUrl);
  twilioLog.log('Resolved Twilio signature validation URL', {
    data: {
      mode,
      urlUsedForSignature,
    },
  });

  if (!signatureHeader) {
    const reason = 'missing_signature';
    twilioLog.error('Twilio signature validation failed', {
      data: {
        mode,
        reason,
        urlUsedForSignature,
      },
    });
    return { ok: mode !== 'enforce', mode, reason };
  }

  const valid = await verifyTwilioSignature(
    env.TWILIO_AUTH_TOKEN,
    urlUsedForSignature,
    params,
    signatureHeader
  );

  if (valid) {
    twilioLog.log('Twilio signature validated', {
      data: {
        mode,
        urlUsedForSignature,
      },
    });
  } else {
    twilioLog.error('Twilio signature validation failed', {
      data: {
        mode,
        reason: 'invalid_signature',
        urlUsedForSignature,
      },
    });
  }

  return { ok: valid || mode === 'log', mode, reason: valid ? undefined : 'invalid_signature' };
}

export function formDataToParams(formData: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === 'string') params[key] = value;
  });
  return params;
}
