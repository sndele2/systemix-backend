// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { EmailClient, resolveGtmConfigFromEnv } from './email-client.ts';

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

console.log = () => {};
console.error = () => {};

test.after(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

function buildConfig(overrides = {}) {
  return {
    fromEmail: 'outbound@example.com',
    fromName: 'Systemix',
    maxTouches: 3,
    dryRun: true,
    ...overrides,
  };
}

function buildPayload(overrides = {}) {
  return {
    to: 'test-recipient@example.com',
    from: 'Systemix <outbound@example.com>',
    subject: 'Checking in',
    body: 'Plain text body',
    ...overrides,
  };
}

class MockSocket {
  constructor(responses, writes, options = {}) {
    this.closed = Promise.resolve();
    this.opened = Promise.resolve({
      remoteAddress: 'smtp.office365.com:587',
      localAddress: '127.0.0.1:12345',
    });
    this.upgraded = options.upgraded ?? false;
    this.secureTransport = options.secureTransport ?? 'off';
    this.tlsSocket = options.tlsSocket ?? null;
    this.writes = writes;
    this.readable = new ReadableStream({
      start(controller) {
        for (const response of responses) {
          controller.enqueue(encoder.encode(response));
        }
        controller.close();
      },
    });
    this.writable = new WritableStream({
      write: (chunk) => {
        this.writes.push(decoder.decode(chunk));
      },
    });
  }

  async close() {
    return;
  }

  startTls() {
    if (this.tlsSocket === null) {
      throw new Error('TLS socket not configured');
    }

    return this.tlsSocket;
  }
}

function createSuccessfulSmtpConnector() {
  const preTlsWrites = [];
  const postTlsWrites = [];
  let connectCalls = 0;

  const postTlsSocket = new MockSocket(
    [
      '250-smtp.office365.com Hello again\r\n250 AUTH LOGIN XOAUTH2\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 Start mail input; end with <CRLF>.<CRLF>\r\n',
      '250 2.0.0 OK <server-message-id@example.com>\r\n',
      '221 2.0.0 Bye\r\n',
    ],
    postTlsWrites,
    {
      upgraded: true,
      secureTransport: 'on',
    }
  );

  const preTlsSocket = new MockSocket(
    [
      '220 smtp.office365.com Microsoft ESMTP MAIL Service ready\r\n',
      '250-smtp.office365.com Hello\r\n250-STARTTLS\r\n250 AUTH LOGIN XOAUTH2\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
    ],
    preTlsWrites,
    {
      upgraded: false,
      secureTransport: 'starttls',
      tlsSocket: postTlsSocket,
    }
  );

  return {
    preTlsWrites,
    postTlsWrites,
    get connectCalls() {
      return connectCalls;
    },
    connect(address, options) {
      connectCalls += 1;
      assert.deepEqual(address, {
        hostname: 'smtp.office365.com',
        port: 587,
      });
      assert.deepEqual(options, {
        secureTransport: 'starttls',
        allowHalfOpen: false,
      });
      return preTlsSocket;
    },
  };
}

function createAuthFailureConnector() {
  const postTlsWrites = [];

  const postTlsSocket = new MockSocket(
    [
      '250-smtp.office365.com Hello again\r\n250 AUTH LOGIN XOAUTH2\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '535 5.7.139 Authentication unsuccessful\r\n',
    ],
    postTlsWrites,
    {
      upgraded: true,
      secureTransport: 'on',
    }
  );

  const preTlsSocket = new MockSocket(
    [
      '220 smtp.office365.com Microsoft ESMTP MAIL Service ready\r\n',
      '250-smtp.office365.com Hello\r\n250-STARTTLS\r\n250 AUTH LOGIN XOAUTH2\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
    ],
    [],
    {
      upgraded: false,
      secureTransport: 'starttls',
      tlsSocket: postTlsSocket,
    }
  );

  return {
    postTlsWrites,
    connect() {
      return preTlsSocket;
    },
  };
}

test('dry-run mode returns success and does not open an SMTP socket', async () => {
  let connectCalls = 0;
  const client = new EmailClient(
    buildConfig(),
    {
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.com',
      SMTP_PASS: 'secret-pass',
    },
    {
      connect: () => {
        connectCalls += 1;
        throw new Error('connect should not be called in dry-run mode');
      },
    }
  );

  const result = await client.sendEmail(buildPayload());

  assert.equal(result.ok, true);
  assert.equal(result.value.provider, 'dry-run');
  assert.equal(result.value.dryRun, true);
  assert.equal(result.value.messageId, null);
  assert.equal(Number.isNaN(Date.parse(result.value.timestamp)), false);
  assert.equal(connectCalls, 0);
});

test('resolveGtmConfigFromEnv defaults to dry-run and falls back to SMTP_USER for fromEmail', () => {
  assert.deepEqual(
    resolveGtmConfigFromEnv({
      SMTP_USER: 'mailbox@example.com',
    }),
    {
      ok: true,
      value: {
        fromEmail: 'mailbox@example.com',
        fromName: 'Systemix',
        maxTouches: 3,
        dryRun: true,
      },
    }
  );
});

test('resolveGtmConfigFromEnv enables live mode only when GTM_DRY_RUN is explicitly false', () => {
  assert.deepEqual(
    resolveGtmConfigFromEnv({
      GTM_DRY_RUN: 'false',
      GTM_FROM_EMAIL: 'outbound@example.com',
      GTM_FROM_NAME: 'Systemix Test',
      GTM_MAX_TOUCHES: '2',
      SMTP_USER: 'mailbox@example.com',
    }),
    {
      ok: true,
      value: {
        fromEmail: 'outbound@example.com',
        fromName: 'Systemix Test',
        maxTouches: 2,
        dryRun: false,
      },
    }
  );
});

test('live SMTP send succeeds for a test email address', async () => {
  const connector = createSuccessfulSmtpConnector();
  const client = new EmailClient(
    buildConfig({ dryRun: false }),
    {
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.com',
      SMTP_PASS: 'secret-pass',
    },
    {
      connect: connector.connect,
    }
  );

  const result = await client.sendEmail(buildPayload());

  assert.equal(result.ok, true);
  assert.equal(result.value.provider, 'smtp-office365');
  assert.equal(result.value.dryRun, false);
  assert.equal(result.value.messageId, 'server-message-id@example.com');
  assert.equal(Number.isNaN(Date.parse(result.value.timestamp)), false);
  assert.equal(connector.connectCalls, 1);
  assert.deepEqual(connector.preTlsWrites, ['EHLO systemix.local\r\n', 'STARTTLS\r\n']);
  assert.deepEqual(connector.postTlsWrites.slice(0, 6), [
    'EHLO systemix.local\r\n',
    'AUTH LOGIN\r\n',
    'bWFpbGJveEBleGFtcGxlLmNvbQ==\r\n',
    'c2VjcmV0LXBhc3M=\r\n',
    'MAIL FROM:<outbound@example.com>\r\n',
    'RCPT TO:<test-recipient@example.com>\r\n',
  ]);
  assert.equal(connector.postTlsWrites[6], 'DATA\r\n');
  assert.match(connector.postTlsWrites[7], /From: Systemix <outbound@example.com>\r\n/);
  assert.match(connector.postTlsWrites[7], /To: test-recipient@example.com\r\n/);
  assert.match(connector.postTlsWrites[7], /Subject: Checking in\r\n/);
  assert.match(connector.postTlsWrites[7], /Content-Type: text\/plain; charset=UTF-8\r\n/);
  assert.match(connector.postTlsWrites[7], /Content-Transfer-Encoding: base64\r\n/);
  assert.match(connector.postTlsWrites[7], /UGxhaW4gdGV4dCBib2R5/);
});

test('missing SMTP config returns an error result in live mode', async () => {
  let connectCalls = 0;
  const client = new EmailClient(
    buildConfig({ dryRun: false }),
    {
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.com',
    },
    {
      connect: () => {
        connectCalls += 1;
        throw new Error('connect should not be called when config is incomplete');
      },
    }
  );

  assert.deepEqual(await client.sendEmail(buildPayload()), {
    ok: false,
    error: 'SMTP configuration incomplete: SMTP_PASS',
  });
  assert.equal(connectCalls, 0);
});

test('SMTP auth failures return a clear error result', async () => {
  const connector = createAuthFailureConnector();
  const client = new EmailClient(
    buildConfig({ dryRun: false }),
    {
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.com',
      SMTP_PASS: 'secret-pass',
    },
    {
      connect: connector.connect,
    }
  );

  const result = await client.sendEmail(buildPayload());

  assert.deepEqual(result, {
    ok: false,
    error: 'SMTP authentication failed: 5.7.139 Authentication unsuccessful',
  });
  assert.deepEqual(connector.postTlsWrites.slice(0, 4), [
    'EHLO systemix.local\r\n',
    'AUTH LOGIN\r\n',
    'bWFpbGJveEBleGFtcGxlLmNvbQ==\r\n',
    'c2VjcmV0LXBhc3M=\r\n',
  ]);
});
