import { processCall } from '../services/processCall';

type Bindings = {
  SYSTEMIX: D1Database;
  ENVIRONMENT?: string;
  SIMULATOR_API_KEY?: string;
};

export async function simulateCallbackHandler(c: any) {
  const env = c.env as Bindings;

  if (env.ENVIRONMENT === 'production') {
    return c.json({ error: 'not_found' }, 404);
  }

  if (env.SIMULATOR_API_KEY) {
    const provided = c.req.header('x-simulator-key');
    if (!provided || provided !== env.SIMULATOR_API_KEY) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const callSid = body?.callSid;
  const fromPhone = body?.caller;
  const toPhone = body?.toPhone ?? body?.to;
  const recordingUrl = body?.recordingUrl;
  const db = env.SYSTEMIX;

  if (!callSid || !fromPhone || !toPhone || !recordingUrl) {
    return c.json({ error: 'callSid, caller, toPhone, and recordingUrl are required' }, 400);
  }

  await db
    .prepare(
      'INSERT OR IGNORE INTO calls (id, provider_call_id, from_phone, to_phone, provider, status) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), callSid, fromPhone, toPhone, 'simulate', 'initiated')
    .run();

  const task = processCall(
    { callSid, fromPhone, toPhone, recordingUrl },
    { env: c.env }
  );

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(task);
  }

  return c.json({ ok: true });
}
