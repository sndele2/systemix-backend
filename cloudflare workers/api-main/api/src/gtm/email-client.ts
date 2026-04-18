/**
 * GTM outbound email transport configuration:
 * - SMTP_HOST: Office 365 SMTP host. Expected value: `smtp.office365.com`
 * - SMTP_PORT: Office 365 SMTP port. Expected value: `587`
 * - SMTP_USER: SMTP username for Outlook / Microsoft 365 authentication
 * - SMTP_PASS: SMTP password for Outlook / Microsoft 365 authentication
 *
 * Live SMTP sending is only attempted when `config.dryRun === false` and all SMTP settings are
 * present. Otherwise the client stays in dry-run mode. The live provider uses SMTP over port 587
 * with STARTTLS and plain-text messages only.
 */
import type { EmailSendResult, GTMConfig, OutboundEmailMessage, Result } from './types.ts';

const GTM_LOG_PREFIX = '[GTM]';
const GTM_DRY_RUN_PREFIX = '[GTM DRY RUN]';
const SMTP_HOSTNAME = 'smtp.office365.com';
const SMTP_PORT = 587;
const SMTP_PROVIDER_NAME = 'smtp-office365';
const SMTP_LINE_LENGTH = 76;
const SMTP_EHLO_HOST = 'systemix.local';
const SMTP_AUTH_FAILURE_CODES = new Set([454, 530, 534, 535]);
const DEFAULT_GTM_FROM_NAME = 'Systemix';
const DEFAULT_GTM_MAX_TOUCHES = 3;

export interface EmailPayload {
  to: string;
  from: string;
  subject: string;
  body: string;
}

export interface SendResult {
  messageId: string | null;
  provider: string;
  timestamp: string;
  dryRun: boolean;
}

export interface EmailProvider {
  sendEmail(payload: EmailPayload): Promise<Result<SendResult>>;
}

export interface EmailTransportEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}

export interface GtmRuntimeEnv extends EmailTransportEnv {
  GTM_DRY_RUN?: string;
  GTM_FROM_EMAIL?: string;
  GTM_FROM_NAME?: string;
  GTM_MAX_TOUCHES?: string;
}

export interface GtmTestEmailResult {
  dryRun: boolean;
  fromEmail: string;
  messageId: string | null;
  subject: string;
  toEmail: string;
}

interface SocketAddressLike {
  hostname: string;
  port: number;
}

interface SocketOptionsLike {
  secureTransport?: 'on' | 'off' | 'starttls';
  allowHalfOpen?: boolean;
  highWaterMark?: number | bigint;
}

interface TlsOptionsLike {
  expectedServerHostname?: string;
}

interface SocketInfoLike {
  remoteAddress?: string;
  localAddress?: string;
}

interface SocketLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  readonly opened: Promise<SocketInfoLike>;
  readonly upgraded: boolean;
  readonly secureTransport: 'on' | 'off' | 'starttls';
  close(): Promise<void>;
  startTls(options?: TlsOptionsLike): SocketLike;
}

type SocketConnectFn = (
  address: string | SocketAddressLike,
  options?: SocketOptionsLike
) => SocketLike;

interface EmailClientDependencies {
  connect?: SocketConnectFn;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

interface SmtpResponse {
  code: number;
  message: string;
  lines: string[];
}

interface ProviderResolution {
  provider: EmailProvider | null;
  providerName: 'dry-run' | typeof SMTP_PROVIDER_NAME | null;
  error: string | null;
}

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function logInfo(message: string, data: Record<string, unknown> = {}): void {
  console.log(GTM_LOG_PREFIX + ' ' + message, {
    ts: new Date().toISOString(),
    ...data,
  });
}

function logError(message: string, data: Record<string, unknown> = {}): void {
  console.error(GTM_LOG_PREFIX + ' ' + message, {
    ts: new Date().toISOString(),
    ...data,
  });
}

function resolveFromField(fromAddress: string, fromName: string): string {
  const trimmedName = fromName.trim();
  return trimmedName.length > 0 ? `${trimmedName} <${fromAddress}>` : fromAddress;
}

function extractEmailAddress(value: string): string | null {
  const trimmedValue = value.trim();
  const match = trimmedValue.match(/<([^<>]+)>/);
  const candidate = (match ? match[1] : trimmedValue).trim();

  if (!/^[^\s@]+@[^\s@]+$/.test(candidate)) {
    return null;
  }

  return candidate;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function foldBase64(value: string): string {
  if (value.length <= SMTP_LINE_LENGTH) {
    return value;
  }

  const lines: string[] = [];
  for (let index = 0; index < value.length; index += SMTP_LINE_LENGTH) {
    lines.push(value.slice(index, index + SMTP_LINE_LENGTH));
  }

  return lines.join('\r\n');
}

function dotStuff(value: string): string {
  return value
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let output = '';

  for (const byte of bytes) {
    output += String.fromCharCode(byte);
  }

  return output;
}

function encodeBase64(value: string): string {
  return btoa(bytesToBinaryString(new TextEncoder().encode(value)));
}

function encodeHeaderValue(value: string): string {
  const isAscii = /^[\x20-\x7E]*$/.test(value);
  return isAscii ? value : `=?UTF-8?B?${encodeBase64(value)}?=`;
}

function parseSmtpPort(value: string | undefined): Result<number> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('SMTP_PORT is required when live SMTP sending is enabled');
  }

  const parsedPort = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    return fail('SMTP_PORT must be a positive integer');
  }

  if (parsedPort !== SMTP_PORT) {
    return fail(`SMTP_PORT must be ${SMTP_PORT}`);
  }

  return succeed(parsedPort);
}

function resolveSmtpConfig(env: EmailTransportEnv): Result<SmtpConfig> {
  const missingFields: string[] = [];

  if (!env.SMTP_HOST?.trim()) {
    missingFields.push('SMTP_HOST');
  }

  if (!env.SMTP_PORT?.trim()) {
    missingFields.push('SMTP_PORT');
  }

  if (!env.SMTP_USER?.trim()) {
    missingFields.push('SMTP_USER');
  }

  if (!env.SMTP_PASS?.trim()) {
    missingFields.push('SMTP_PASS');
  }

  if (missingFields.length > 0) {
    return fail('SMTP configuration incomplete: ' + missingFields.join(', '));
  }

  const host = env.SMTP_HOST!.trim();
  if (host !== SMTP_HOSTNAME) {
    return fail(`SMTP_HOST must be ${SMTP_HOSTNAME}`);
  }

  const portResult = parseSmtpPort(env.SMTP_PORT);
  if (!portResult.ok) {
    return portResult;
  }

  return succeed({
    host,
    port: portResult.value,
    user: env.SMTP_USER!.trim(),
    pass: env.SMTP_PASS!,
  });
}

function parseBooleanEnvFlag(value: string | undefined, fieldName: string): Result<boolean> {
  if (value === undefined || value.trim().length === 0) {
    return succeed(true);
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'on':
    case 'true':
    case 'yes':
      return succeed(true);
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return succeed(false);
    default:
      return fail(`${fieldName} must be one of true, false, 1, 0, on, off, yes, or no`);
  }
}

function parseGtmMaxTouches(value: string | undefined): Result<1 | 2 | 3> {
  if (value === undefined || value.trim().length === 0) {
    return succeed(DEFAULT_GTM_MAX_TOUCHES);
  }

  const trimmedValue = value.trim();
  if (trimmedValue !== '1' && trimmedValue !== '2' && trimmedValue !== '3') {
    return fail('GTM_MAX_TOUCHES must be 1, 2, or 3');
  }

  return succeed(Number.parseInt(trimmedValue, 10) as 1 | 2 | 3);
}

export function resolveGtmConfigFromEnv(env: GtmRuntimeEnv): Result<GTMConfig> {
  const fromEmail = env.GTM_FROM_EMAIL?.trim() || env.SMTP_USER?.trim() || '';
  if (fromEmail.length === 0) {
    return fail('GTM_FROM_EMAIL is required when SMTP_USER is not set');
  }

  if (extractEmailAddress(fromEmail) === null) {
    return fail('GTM_FROM_EMAIL must be a valid email address');
  }

  const maxTouchesResult = parseGtmMaxTouches(env.GTM_MAX_TOUCHES);
  if (!maxTouchesResult.ok) {
    return maxTouchesResult;
  }

  const dryRunResult = parseBooleanEnvFlag(env.GTM_DRY_RUN, 'GTM_DRY_RUN');
  if (!dryRunResult.ok) {
    return dryRunResult;
  }

  return succeed({
    fromEmail,
    fromName: env.GTM_FROM_NAME?.trim() || DEFAULT_GTM_FROM_NAME,
    maxTouches: maxTouchesResult.value,
    dryRun: dryRunResult.value,
  });
}

export async function sendGtmTestEmail(
  config: GTMConfig,
  env: EmailTransportEnv,
  toEmail: string
): Promise<Result<GtmTestEmailResult>> {
  const trimmedRecipient = toEmail.trim();
  if (extractEmailAddress(trimmedRecipient) === null) {
    return fail('toEmail must be a valid email address');
  }

  const timestamp = new Date().toISOString();
  const subject = `Systemix GTM SMTP test ${timestamp}`;
  const body = [
    'This is a single GTM SMTP test message from Systemix.',
    `Timestamp: ${timestamp}`,
    `Mode: ${config.dryRun ? 'dry-run' : 'live'}`,
    '',
    'No GTM lead state, queueing, or Twilio/SMS logic was triggered by this test.',
  ].join('\n');

  const client = new EmailClient(config, env);
  const result = await client.sendEmail({
    to: trimmedRecipient,
    from: resolveFromField(config.fromEmail, config.fromName),
    subject,
    body,
  });

  if (!result.ok) {
    return result;
  }

  return succeed({
    dryRun: result.value.dryRun,
    fromEmail: config.fromEmail,
    messageId: result.value.messageId,
    subject,
    toEmail: trimmedRecipient,
  });
}

function parseResponseLine(line: string): Result<{ code: number; separator: ' ' | '-'; text: string }> {
  if (!/^\d{3}[ -]/.test(line)) {
    return fail('Invalid SMTP response line: ' + line);
  }

  return succeed({
    code: Number.parseInt(line.slice(0, 3), 10),
    separator: line.charAt(3) === '-' ? '-' : ' ',
    text: line.slice(4),
  });
}

function extractServerMessageId(response: SmtpResponse): string | null {
  const match = response.message.match(/<([^<>]+)>/);
  return match ? match[1] : null;
}

async function loadSocketConnector(): Promise<SocketConnectFn> {
  const socketsModule = await import('cloudflare:sockets');
  return socketsModule.connect as SocketConnectFn;
}

class DryRunEmailProvider implements EmailProvider {
  async sendEmail(payload: EmailPayload): Promise<Result<SendResult>> {
    const timestamp = new Date().toISOString();

    console.log(GTM_DRY_RUN_PREFIX + ' outbound email payload', {
      ts: timestamp,
      to: payload.to,
      from: payload.from,
      subject: payload.subject,
    });

    return succeed({
      messageId: null,
      provider: 'dry-run',
      timestamp,
      dryRun: true,
    });
  }
}

class SmtpConnection {
  private socket: SocketLike;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buffer = '';

  constructor(socket: SocketLike) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  static async open(config: SmtpConfig, connect: SocketConnectFn): Promise<Result<SmtpConnection>> {
    try {
      const socket = connect(
        {
          hostname: config.host,
          port: config.port,
        },
        {
          secureTransport: 'starttls',
          allowHalfOpen: false,
        }
      );

      await socket.opened;
      return succeed(new SmtpConnection(socket));
    } catch (error) {
      return fail(
        'Failed to open SMTP socket: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }

  async readResponse(): Promise<Result<SmtpResponse>> {
    const lines: string[] = [];
    let expectedCode: number | null = null;

    while (true) {
      const lineResult = await this.readLine();
      if (!lineResult.ok) {
        return lineResult;
      }

      const parsedLineResult = parseResponseLine(lineResult.value);
      if (!parsedLineResult.ok) {
        return parsedLineResult;
      }

      const parsedLine = parsedLineResult.value;
      if (expectedCode === null) {
        expectedCode = parsedLine.code;
      } else if (expectedCode !== parsedLine.code) {
        return fail('Inconsistent SMTP response code sequence');
      }

      lines.push(lineResult.value);

      if (parsedLine.separator === ' ') {
        return succeed({
          code: parsedLine.code,
          message: lines.map((line) => line.slice(4)).join('\n'),
          lines,
        });
      }
    }
  }

  async sendCommand(command: string): Promise<Result<SmtpResponse>> {
    const writeResult = await this.writeRaw(command + '\r\n');
    if (!writeResult.ok) {
      return writeResult;
    }

    return this.readResponse();
  }

  async sendData(data: string): Promise<Result<SmtpResponse>> {
    const writeResult = await this.writeRaw(data + '\r\n.\r\n');
    if (!writeResult.ok) {
      return writeResult;
    }

    return this.readResponse();
  }

  async upgradeToTls(expectedServerHostname: string): Promise<Result<void>> {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();

      const upgradedSocket = this.socket.startTls({
        expectedServerHostname,
      });

      await upgradedSocket.opened;

      this.socket = upgradedSocket;
      this.reader = upgradedSocket.readable.getReader();
      this.writer = upgradedSocket.writable.getWriter();
      this.buffer = '';

      return succeed(undefined);
    } catch (error) {
      return fail(
        'Failed to upgrade SMTP connection to TLS: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  async sendQuit(): Promise<void> {
    const writeResult = await this.writeRaw('QUIT\r\n');
    if (!writeResult.ok) {
      return;
    }

    await this.readResponse();
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // Ignore writer close failures during connection teardown.
    }

    try {
      await this.socket.close();
    } catch {
      // Ignore socket close failures during connection teardown.
    }

    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  private async writeRaw(value: string): Promise<Result<void>> {
    try {
      await this.writer.write(this.encoder.encode(value));
      return succeed(undefined);
    } catch (error) {
      return fail(
        'Failed to write to SMTP socket: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }

  private async readLine(): Promise<Result<string>> {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newlineIndex + 1);
        return succeed(line);
      }

      const readResult = await this.reader.read();
      if (readResult.done) {
        return fail('SMTP connection closed unexpectedly');
      }

      this.buffer += this.decoder.decode(readResult.value, {
        stream: true,
      });
    }
  }
}

class SmtpEmailProvider implements EmailProvider {
  private readonly config: SmtpConfig;
  private readonly connectorFactory: () => Promise<SocketConnectFn>;

  constructor(config: SmtpConfig, connectorFactory: () => Promise<SocketConnectFn>) {
    this.config = config;
    this.connectorFactory = connectorFactory;
  }

  async sendEmail(payload: EmailPayload): Promise<Result<SendResult>> {
    const fromAddress = extractEmailAddress(payload.from);
    if (fromAddress === null) {
      return fail('Invalid from email address');
    }

    const toAddress = extractEmailAddress(payload.to);
    if (toAddress === null) {
      return fail('Invalid recipient email address');
    }

    const connectorResult = await this.resolveConnector();
    if (!connectorResult.ok) {
      logError('smtp_connector_unavailable', {
        provider: SMTP_PROVIDER_NAME,
        error: connectorResult.error,
      });
      return connectorResult;
    }

    const connectionResult = await SmtpConnection.open(this.config, connectorResult.value);
    if (!connectionResult.ok) {
      logError('smtp_connect_failed', {
        provider: SMTP_PROVIDER_NAME,
        to: toAddress,
        error: connectionResult.error,
      });
      return connectionResult;
    }

    const timestamp = new Date().toISOString();
    const generatedMessageId = `${crypto.randomUUID()}@${this.config.host}`;
    const connection = connectionResult.value;

    try {
      const sendResult = await this.sendMessage(
        connection,
        payload,
        fromAddress,
        toAddress,
        generatedMessageId,
        timestamp
      );

      if (!sendResult.ok) {
        logError('smtp_send_failed', {
          provider: SMTP_PROVIDER_NAME,
          to: toAddress,
          subject: payload.subject,
          error: sendResult.error,
        });
        return sendResult;
      }

      logInfo('smtp_send_succeeded', {
        provider: SMTP_PROVIDER_NAME,
        to: toAddress,
        subject: payload.subject,
        messageId: sendResult.value.messageId,
        timestamp,
      });

      return sendResult;
    } finally {
      await connection.sendQuit();
      await connection.close();
    }
  }

  private async resolveConnector(): Promise<Result<SocketConnectFn>> {
    try {
      return succeed(await this.connectorFactory());
    } catch (error) {
      return fail(
        'SMTP connector unavailable: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }

  private async sendMessage(
    connection: SmtpConnection,
    payload: EmailPayload,
    fromAddress: string,
    toAddress: string,
    generatedMessageId: string,
    timestamp: string
  ): Promise<Result<SendResult>> {
    const bannerResult = await connection.readResponse();
    if (!bannerResult.ok) {
      return bannerResult;
    }

    if (bannerResult.value.code !== 220) {
      return fail('SMTP server rejected connection: ' + bannerResult.value.message);
    }

    const ehloResult = await connection.sendCommand(`EHLO ${SMTP_EHLO_HOST}`);
    const ehloValidatedResult = this.expectResponse(
      ehloResult,
      [250],
      'SMTP EHLO failed'
    );
    if (!ehloValidatedResult.ok) {
      return ehloValidatedResult;
    }

    const startTlsResult = await connection.sendCommand('STARTTLS');
    const startTlsValidatedResult = this.expectResponse(
      startTlsResult,
      [220],
      'SMTP STARTTLS failed'
    );
    if (!startTlsValidatedResult.ok) {
      return startTlsValidatedResult;
    }

    const upgradeResult = await connection.upgradeToTls(this.config.host);
    if (!upgradeResult.ok) {
      return upgradeResult;
    }

    const secureEhloResult = await connection.sendCommand(`EHLO ${SMTP_EHLO_HOST}`);
    const secureEhloValidatedResult = this.expectResponse(
      secureEhloResult,
      [250],
      'SMTP EHLO after STARTTLS failed'
    );
    if (!secureEhloValidatedResult.ok) {
      return secureEhloValidatedResult;
    }

    const authResult = await this.authenticate(connection);
    if (!authResult.ok) {
      return authResult;
    }

    const mailFromResult = await connection.sendCommand(`MAIL FROM:<${fromAddress}>`);
    const mailFromValidatedResult = this.expectResponse(
      mailFromResult,
      [250],
      'SMTP MAIL FROM failed'
    );
    if (!mailFromValidatedResult.ok) {
      return mailFromValidatedResult;
    }

    const rcptToResult = await connection.sendCommand(`RCPT TO:<${toAddress}>`);
    const rcptToValidatedResult = this.expectResponse(
      rcptToResult,
      [250, 251],
      'SMTP RCPT TO failed'
    );
    if (!rcptToValidatedResult.ok) {
      return rcptToValidatedResult;
    }

    const dataReadyResult = await connection.sendCommand('DATA');
    const dataReadyValidatedResult = this.expectResponse(
      dataReadyResult,
      [354],
      'SMTP DATA command failed'
    );
    if (!dataReadyValidatedResult.ok) {
      return dataReadyValidatedResult;
    }

    const message = this.buildMessage(payload, generatedMessageId, timestamp);
    const dataAcceptedResult = await connection.sendData(message);
    const dataAcceptedValidatedResult = this.expectResponse(
      dataAcceptedResult,
      [250],
      'SMTP message body rejected'
    );
    if (!dataAcceptedValidatedResult.ok) {
      return dataAcceptedValidatedResult;
    }

    return succeed({
      messageId: extractServerMessageId(dataAcceptedValidatedResult.value) ?? generatedMessageId,
      provider: SMTP_PROVIDER_NAME,
      timestamp,
      dryRun: false,
    });
  }

  private async authenticate(connection: SmtpConnection): Promise<Result<void>> {
    const authStartResult = await connection.sendCommand('AUTH LOGIN');
    const authStartValidatedResult = this.expectResponse(
      authStartResult,
      [334],
      'SMTP AUTH LOGIN failed',
      true
    );
    if (!authStartValidatedResult.ok) {
      return authStartValidatedResult;
    }

    const usernameResult = await connection.sendCommand(encodeBase64(this.config.user));
    const usernameValidatedResult = this.expectResponse(
      usernameResult,
      [334],
      'SMTP username rejected',
      true
    );
    if (!usernameValidatedResult.ok) {
      return usernameValidatedResult;
    }

    const passwordResult = await connection.sendCommand(encodeBase64(this.config.pass));
    const passwordValidatedResult = this.expectResponse(
      passwordResult,
      [235],
      'SMTP password rejected',
      true
    );
    if (!passwordValidatedResult.ok) {
      return passwordValidatedResult;
    }

    return succeed(undefined);
  }

  private buildMessage(payload: EmailPayload, generatedMessageId: string, timestamp: string): string {
    const body = dotStuff(foldBase64(encodeBase64(normalizeLineEndings(payload.body))));
    const headers = [
      `From: ${payload.from}`,
      `To: ${payload.to}`,
      `Subject: ${encodeHeaderValue(payload.subject)}`,
      `Date: ${new Date(timestamp).toUTCString()}`,
      `Message-ID: <${generatedMessageId}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ];

    return headers.join('\r\n');
  }

  private expectResponse(
    responseResult: Result<SmtpResponse>,
    allowedCodes: readonly number[],
    context: string,
    treatAuthFailure: boolean = false
  ): Result<SmtpResponse> {
    if (!responseResult.ok) {
      return responseResult;
    }

    if (allowedCodes.includes(responseResult.value.code)) {
      return responseResult;
    }

    if (treatAuthFailure && SMTP_AUTH_FAILURE_CODES.has(responseResult.value.code)) {
      return fail('SMTP authentication failed: ' + responseResult.value.message);
    }

    return fail(`${context}: ${responseResult.value.code} ${responseResult.value.message}`);
  }
}

export class EmailClient implements EmailProvider {
  private readonly config: GTMConfig;
  private readonly provider: EmailProvider | null;
  private readonly providerName: 'dry-run' | typeof SMTP_PROVIDER_NAME | null;
  private readonly providerError: string | null;

  constructor(
    config: GTMConfig,
    env: EmailTransportEnv = {},
    dependencies: EmailClientDependencies = {}
  ) {
    this.config = {
      ...config,
      dryRun: config.dryRun !== false,
    };

    const resolution = this.resolveProvider(env, dependencies);
    this.provider = resolution.provider;
    this.providerName = resolution.providerName;
    this.providerError = resolution.error;

    if (resolution.providerName !== null) {
      logInfo('email provider mode active', {
        provider: resolution.providerName,
      });
      return;
    }

    logError('email provider configuration invalid', {
      error: resolution.error,
    });
  }

  async sendEmail(payload: EmailPayload): Promise<Result<SendResult>> {
    if (this.providerError !== null) {
      return fail(this.providerError);
    }

    if (this.provider === null) {
      return fail('Email provider is not configured');
    }

    return this.provider.sendEmail(payload);
  }

  async send(message: OutboundEmailMessage): Promise<EmailSendResult> {
    const fromAddress = this.config.fromEmail.trim();
    if (!fromAddress) {
      logError('email send blocked by missing from address');
      return {
        success: false,
        dryRun: this.providerName === 'dry-run',
        messageId: null,
      };
    }

    const result = await this.sendEmail({
      to: message.toEmail,
      from: resolveFromField(fromAddress, this.config.fromName),
      subject: message.subject,
      body: message.body,
    });

    if (!result.ok) {
      logError('email send failed', {
        provider: this.providerName,
        error: result.error,
      });
      return {
        success: false,
        dryRun: this.providerName === 'dry-run',
        messageId: null,
      };
    }

    return {
      success: true,
      dryRun: result.value.dryRun,
      messageId: result.value.messageId,
    };
  }

  private resolveProvider(
    env: EmailTransportEnv,
    dependencies: EmailClientDependencies
  ): ProviderResolution {
    if (this.config.dryRun) {
      return {
        provider: new DryRunEmailProvider(),
        providerName: 'dry-run',
        error: null,
      };
    }

    const smtpConfigResult = resolveSmtpConfig(env);
    if (!smtpConfigResult.ok) {
      return {
        provider: null,
        providerName: null,
        error: smtpConfigResult.error,
      };
    }

    const connectorFactory =
      dependencies.connect === undefined
        ? loadSocketConnector
        : async (): Promise<SocketConnectFn> => dependencies.connect!;

    return {
      provider: new SmtpEmailProvider(smtpConfigResult.value, connectorFactory),
      providerName: SMTP_PROVIDER_NAME,
      error: null,
    };
  }
}
