export type LogPrefix =
  | '[STRIPE]'
  | '[D1]'
  | '[HUBSPOT]'
  | '[TWILIO]'
  | '[VOICE]'
  | '[CLASSIFY]'
  | '[ONBOARD]'
  | '[ROUTER]';

type StructuredLogLevel = 'log' | 'error' | 'warn';

export type StructuredLogContext = {
  callSid?: string | null;
  messageSid?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  handler?: string | null;
};

type StructuredLogOptions = {
  context?: StructuredLogContext;
  data?: Record<string, unknown>;
  error?: unknown;
};

type NormalizedError = {
  error: string | null;
  stack: string | null;
};

function normalizeError(error: unknown): NormalizedError {
  if (error === null || error === undefined) {
    return { error: null, stack: null };
  }

  if (error instanceof Error) {
    return {
      error: error.message,
      stack: error.stack ?? null,
    };
  }

  if (typeof error === 'string') {
    return {
      error,
      stack: null,
    };
  }

  try {
    return {
      error: JSON.stringify(error),
      stack: null,
    };
  } catch {
    return {
      error: String(error),
      stack: null,
    };
  }
}

function normalizeContext(handler: string, context?: StructuredLogContext): Record<string, string> {
  const normalized: Record<string, string> = {
    handler,
  };

  const handlerOverride = context?.handler?.trim();
  if (handlerOverride) {
    normalized.handler = handlerOverride;
  }

  const callSid = context?.callSid?.trim();
  if (callSid) {
    normalized.callSid = callSid;
  }

  const messageSid = context?.messageSid?.trim();
  if (messageSid) {
    normalized.messageSid = messageSid;
  }

  const fromNumber = context?.fromNumber?.trim();
  if (fromNumber) {
    normalized.fromNumber = fromNumber;
  }

  const toNumber = context?.toNumber?.trim();
  if (toNumber) {
    normalized.toNumber = toNumber;
  }

  return normalized;
}

function removeUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function consoleMethod(level: StructuredLogLevel): (message?: unknown, ...optionalParams: unknown[]) => void {
  switch (level) {
    case 'error':
      return console.error.bind(console);
    case 'warn':
      return console.warn.bind(console);
    case 'log':
    default:
      return console.log.bind(console);
  }
}

function emitStructuredLog(
  level: StructuredLogLevel,
  prefix: LogPrefix,
  handler: string,
  message: string,
  options: StructuredLogOptions
): void {
  const normalizedError = normalizeError(options.error);
  const payload = {
    ts: new Date().toISOString(),
    prefix,
    message,
    ...removeUndefined(options.data ?? {}),
    error: normalizedError.error,
    stack: normalizedError.stack,
    context: normalizeContext(handler, options.context),
  };

  const write = consoleMethod(level);

  try {
    write(JSON.stringify(payload));
  } catch (serializationError) {
    const fallbackError = normalizeError(serializationError);
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        prefix,
        message: 'structured_log_serialization_failed',
        error: fallbackError.error,
        stack: fallbackError.stack,
        context: normalizeContext(handler, options.context),
      })
    );
  }
}

export function createLogger(prefix: LogPrefix, handler: string) {
  return {
    log(message: string, options: StructuredLogOptions = {}): void {
      emitStructuredLog('log', prefix, handler, message, options);
    },
    warn(message: string, options: StructuredLogOptions = {}): void {
      emitStructuredLog('warn', prefix, handler, message, options);
    },
    error(message: string, options: StructuredLogOptions = {}): void {
      emitStructuredLog('error', prefix, handler, message, options);
    },
  };
}
