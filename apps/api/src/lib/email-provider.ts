/**
 * Email Provider Abstraction Layer
 *
 * This abstraction allows swapping email service providers per region without code changes.
 * This is needed for the CN region, where Resend may not be available.
 *
 * Supported Providers:
 * - Resend (current, global)
 * - Alibaba Cloud DirectMail (China)
 * - Tencent Cloud SES (China)
 * - AWS SES (global, including China regions)
 * - Scaleway TEM (transactional email HTTP API — the Scaleway-profile default, WS-5)
 * - SMTP (generic RFC 5321 client — Mailpit in CI/e2e, or any SMTP relay)
 */

// NOTE: this module is intentionally free of the structured (pino-backed)
// trellis logger. It is bundled into the Cognito `create-auth-challenge`
// Lambda via `createEmailProvider`, and pulling in the foundation logger would
// bloat that bundle. The one place that logs (Resend usage-stats) uses
// `console.error` instead. The AWS SES SDK is loaded through a lazy, cached
// dynamic import (see `loadSesSdk` below) so it can stay an esbuild external
// (provided by the Lambda runtime) and the client is reused across warm
// invocations.

export interface EmailSendOptions {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  tags?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
  provider: string;
}

export interface EmailUsageStats {
  emailsSent: number;
  period: "month" | "day" | "year";
  periodStart: string; // ISO date string
  periodEnd: string; // ISO date string
}

export interface EmailProvider {
  /**
   * Send an email
   */
  sendEmail(options: EmailSendOptions): Promise<EmailSendResult>;

  /**
   * Get usage statistics (for cost calculation)
   * Returns null if provider doesn't support usage stats
   */
  getUsageStats?(
    period?: "month" | "day" | "year",
  ): Promise<EmailUsageStats | null>;

  /**
   * Get provider name for identification
   */
  getName(): string;
}

/**
 * Resend Email Provider (Current Implementation)
 *
 * Used globally except in China where it may not be available.
 */
export class ResendEmailProvider implements EmailProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl: string = "https://api.resend.com",
    // Retained for call-site compatibility; unused (this module avoids the
    // structured logger to keep the Lambda bundle lean).
    _env?: unknown,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  getName(): string {
    return "resend";
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const response = await fetch(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: options.from,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
        reply_to: options.replyTo,
        cc: options.cc
          ? Array.isArray(options.cc)
            ? options.cc
            : [options.cc]
          : undefined,
        bcc: options.bcc
          ? Array.isArray(options.bcc)
            ? options.bcc
            : [options.bcc]
          : undefined,
        tags: options.tags,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { id: string };
    return {
      messageId: data.id,
      provider: "resend",
    };
  }

  async getUsageStats(
    period: "month" | "day" | "year" = "month",
  ): Promise<EmailUsageStats | null> {
    try {
      const response = await fetch(`${this.baseUrl}/usage`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const usage = (await response.json()) as { emails_sent?: number };
      const emailsSent = usage.emails_sent || 0;

      // Calculate period dates
      const now = new Date();
      let periodStart: Date;
      let periodEnd: Date = now;

      if (period === "month") {
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (period === "day") {
        periodStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
      } else {
        periodStart = new Date(now.getFullYear(), 0, 1);
      }

      return {
        emailsSent,
        period,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      };
    } catch (error) {
      console.error("[ResendEmailProvider] Error fetching usage stats:", error);
      return null;
    }
  }
}

/**
 * Alibaba Cloud DirectMail Provider (China)
 *
 * Alibaba Cloud DirectMail is a China-compliant email service.
 * Documentation: https://www.alibabacloud.com/help/en/directmail
 */
export class AlibabaDirectMailProvider implements EmailProvider {
  private accessKeyId: string;
  private accessKeySecret: string;
  private region: string; // e.g., 'cn-hangzhou'
  private accountName: string; // Verified sender email address

  constructor(
    accessKeyId: string,
    accessKeySecret: string,
    region: string = "cn-hangzhou",
    accountName: string,
  ) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.region = region;
    this.accountName = accountName;
  }

  getName(): string {
    return "alibaba-directmail";
  }

  async sendEmail(_options: EmailSendOptions): Promise<EmailSendResult> {
    // NOT IMPLEMENTED. The earlier version issued an UNSIGNED request to the
    // Alibaba DirectMail REST API (no HMAC-SHA1 signature), which the service
    // rejects — it never actually delivered mail. Rather than silently issue a
    // broken request, fail loudly. A real implementation must sign requests via
    // the Alibaba Cloud SDK / proper signature algorithm before this is enabled.
    void this.accessKeyId;
    void this.accessKeySecret;
    void this.region;
    void this.accountName;
    throw new Error(
      "AlibabaDirectMailProvider.sendEmail is not implemented (requires a signed Alibaba Cloud SDK integration)",
    );
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // Alibaba Cloud DirectMail usage stats would require additional API calls
    // This is a placeholder - implement based on Alibaba Cloud API documentation
    return null;
  }
}

/**
 * Tencent Cloud SES Provider (China)
 *
 * Tencent Cloud Simple Email Service is a China-compliant email service.
 * Documentation: https://cloud.tencent.com/document/product/1288
 */
export class TencentSESProvider implements EmailProvider {
  private secretId: string;
  private secretKey: string;
  private region: string; // e.g., 'ap-beijing'
  private fromEmail: string; // Verified sender email address

  constructor(
    secretId: string,
    secretKey: string,
    region: string = "ap-beijing",
    fromEmail: string,
  ) {
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.region = region;
    this.fromEmail = fromEmail;
  }

  getName(): string {
    return "tencent-ses";
  }

  async sendEmail(_options: EmailSendOptions): Promise<EmailSendResult> {
    // NOT IMPLEMENTED. The earlier version issued an UNSIGNED request to the
    // Tencent Cloud SES v3 API (no TC3-HMAC-SHA256 signature), which the service
    // rejects — it never actually delivered mail. Fail loudly rather than issue
    // a broken request. A real implementation must sign requests via the Tencent
    // Cloud SDK / TC3-HMAC-SHA256 before this is enabled.
    void this.secretId;
    void this.secretKey;
    void this.region;
    void this.fromEmail;
    throw new Error(
      "TencentSESProvider.sendEmail is not implemented (requires a signed Tencent Cloud SDK integration)",
    );
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // Tencent Cloud SES usage stats would require additional API calls
    // This is a placeholder - implement based on Tencent Cloud API documentation
    return null;
  }
}

/**
 * Lazily import `@aws-sdk/client-ses` once and cache the module promise.
 *
 * Deferring the import (a) lets the Cognito Lambda keep `@aws-sdk/*` marked
 * external in esbuild (the SES SDK is provided by the Lambda runtime, not
 * bundled), and (b) means non-SES code paths never pay to load it. The cached
 * promise is reused across warm Lambda invocations.
 */
let sesSdkPromise:
  | Promise<typeof import("@aws-sdk/client-ses")>
  | undefined;
function loadSesSdk(): Promise<typeof import("@aws-sdk/client-ses")> {
  if (!sesSdkPromise) {
    sesSdkPromise = import("@aws-sdk/client-ses");
  }
  return sesSdkPromise;
}

/**
 * AWS SES Provider (Global, including China regions)
 *
 * Sends via the AWS SDK (`@aws-sdk/client-ses`), signed with SigV4 by the SDK.
 * Uses the **default credential provider chain** — no static keys are passed,
 * so it picks up the ECS task role / Lambda execution role automatically.
 *
 * AWS SES works globally and has China regions (Beijing, Ningxia).
 * Documentation: https://docs.aws.amazon.com/ses/
 */
export class AWSSESProvider implements EmailProvider {
  private region: string; // e.g. 'us-east-1', 'cn-north-1', 'cn-northwest-1'
  private fromEmail?: string;
  private configurationSet?: string;
  /** Cached SESClient promise — reused across warm invocations. */
  private clientPromise?: Promise<
    InstanceType<typeof import("@aws-sdk/client-ses").SESClient>
  >;

  constructor(
    region: string = "us-east-1",
    opts?: { fromEmail?: string; configurationSet?: string },
  ) {
    this.region = region;
    this.fromEmail = opts?.fromEmail;
    this.configurationSet = opts?.configurationSet;
  }

  getName(): string {
    return "aws-ses";
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SESClient } = await loadSesSdk();
        // NO `credentials` option → default credential provider chain
        // (ECS task role / Lambda execution role / env / SSO).
        return new SESClient({ region: this.region });
      })();
    }
    return this.clientPromise;
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const source = options.from || this.fromEmail;
    if (!source) {
      throw new Error(
        "AWS SES requires a from address (options.from or the provider's fromEmail)",
      );
    }

    const { SendEmailCommand } = await loadSesSdk();
    const client = await this.getClient();

    const toAddresses = Array.isArray(options.to) ? options.to : [options.to];
    const ccAddresses = options.cc
      ? Array.isArray(options.cc)
        ? options.cc
        : [options.cc]
      : undefined;
    const bccAddresses = options.bcc
      ? Array.isArray(options.bcc)
        ? options.bcc
        : [options.bcc]
      : undefined;

    const command = new SendEmailCommand({
      Source: source,
      Destination: {
        ToAddresses: toAddresses,
        CcAddresses: ccAddresses,
        BccAddresses: bccAddresses,
      },
      Message: {
        Subject: { Data: options.subject, Charset: "UTF-8" },
        Body: {
          Html: options.html
            ? { Data: options.html, Charset: "UTF-8" }
            : undefined,
          Text: options.text
            ? { Data: options.text, Charset: "UTF-8" }
            : undefined,
        },
      },
      ReplyToAddresses: options.replyTo ? [options.replyTo] : undefined,
      ...(this.configurationSet
        ? { ConfigurationSetName: this.configurationSet }
        : {}),
    });

    const response = await client.send(command);
    return {
      messageId: response.MessageId || "unknown",
      provider: "aws-ses",
    };
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // AWS SES usage stats would require CloudWatch API calls
    // This is a placeholder - implement based on AWS CloudWatch API
    return null;
  }
}

/**
 * Reject CR/LF/NUL in a value that will end up inside (or become) an RFC 5322
 * header. Untrusted input (a display name, a Reply-To address, …) that
 * carries a raw `\r\n` can terminate the current header and start injecting
 * arbitrary ones (extra recipients, a spoofed header, etc.) into providers
 * that build/forward raw MIME (the SMTP provider's hand-rolled headers, TEM's
 * `additional_headers`). Throws a clear, non-silent error rather than
 * stripping — a caller that hits this should fix the input, not have it
 * silently mangled.
 */
function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      `Email header injection blocked: ${field} contains a CR, LF, or NUL character`,
    );
  }
}

/**
 * Split a possibly display-named address ("Jane <jane@example.com>") into the
 * `{ email, name? }` object shape the Scaleway TEM API expects. A bare
 * address passes through as `{ email }`.
 */
function toAddressObject(addr: string): { email: string; name?: string } {
  assertNoHeaderInjection(addr, "address");
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(addr);
  if (match && match[2]) {
    const name = match[1]?.replace(/^"|"$/g, "").trim();
    return name ? { email: match[2], name } : { email: match[2] };
  }
  return { email: addr.trim() };
}

function toAddressList(value: string | string[] | undefined): Array<{ email: string; name?: string }> | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map(toAddressObject);
}

/**
 * Scaleway Transactional Email (TEM) provider — the Scaleway-profile default
 * (`EMAIL_SERVICE=scaleway-tem`, manifest D8a draft below).
 *
 * Sends via the TEM HTTP API (fetch-based, same pattern as Resend — no SDK):
 *   POST https://api.scaleway.com/transactional-email/v1alpha1/regions/{region}/emails
 *   Header: X-Auth-Token: <IAM API secret key>
 *   Body: { from: {email,name?}, to: [{email,name?}], cc, bcc, subject,
 *           text, html, project_id, additional_headers: [{key,value}] }
 *
 * Grounding (2026-07-20, do not trust memory over these):
 * - API shape: https://www.scaleway.com/en/developers/api/transactional-email/
 *   (v1alpha1 is the current version; region fr-par).
 * - Capabilities/limits (2 MB API payload, per-recipient billing incl. CC):
 *   https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/
 * - The TEM SMTP relay (smtp.tem.scaleway.com, ports 25/587/2587 STARTTLS,
 *   465/2465 implicit TLS; username = project ID, password = API secret key:
 *   https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/)
 *   is reachable through the generic {@link SmtpEmailProvider} instead —
 *   this class deliberately speaks only the HTTP API (structured errors,
 *   no long-lived socket, consistent with the Resend adapter).
 *
 * Config is fail-closed: missing projectId/secretKey throws at construction
 * (in the factory), never at send time with a half-configured client.
 */
export class ScalewayTemProvider implements EmailProvider {
  private readonly secretKey: string;
  private readonly projectId: string;
  private readonly region: string;
  private readonly baseUrl: string;
  private readonly defaultFrom?: string;

  constructor(options: {
    secretKey: string;
    projectId: string;
    /** TEM region (default `fr-par` — the TEM region per the API docs). */
    region?: string;
    /** Override for tests/fakes; default `https://api.scaleway.com`. */
    baseUrl?: string;
    /** Default From address when a send omits `from`. */
    defaultFrom?: string;
  }) {
    this.secretKey = options.secretKey;
    this.projectId = options.projectId;
    this.region = options.region || "fr-par";
    this.baseUrl = options.baseUrl || "https://api.scaleway.com";
    this.defaultFrom = options.defaultFrom;
  }

  getName(): string {
    return "scaleway-tem";
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const fromAddr = options.from || this.defaultFrom;
    if (!fromAddr) {
      throw new Error(
        "Scaleway TEM requires a from address (options.from or the provider's defaultFrom)",
      );
    }

    const body: Record<string, unknown> = {
      from: toAddressObject(fromAddr),
      to: toAddressList(options.to),
      cc: toAddressList(options.cc),
      bcc: toAddressList(options.bcc),
      subject: options.subject,
      // TEM treats text as the primary body; html is optional. Pass both
      // through as given (the API accepts either or both).
      text: options.text,
      html: options.html,
      project_id: this.projectId,
    };
    if (options.replyTo) {
      // Reply-To goes through additional_headers per the TEM API reference.
      // Guard before it reaches the wire: a CR/LF/NUL here would inject an
      // arbitrary header into the outbound message.
      assertNoHeaderInjection(options.replyTo, "replyTo");
      body.additional_headers = [{ key: "Reply-To", value: options.replyTo }];
    }

    const response = await fetch(
      `${this.baseUrl}/transactional-email/v1alpha1/regions/${this.region}/emails`,
      {
        method: "POST",
        headers: {
          "X-Auth-Token": this.secretKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Scaleway TEM API error: ${response.status} ${error}`);
    }

    // Response: { emails: [ { id, message_id, status, ... } ] } — one entry
    // per recipient (TEM bills per recipient). Any entry's message_id/id
    // identifies the send; parse defensively.
    const data = (await response.json()) as {
      emails?: Array<{ id?: string; message_id?: string }>;
    };
    const first = data.emails?.[0];
    return {
      messageId: first?.message_id || first?.id || "unknown",
      provider: "scaleway-tem",
    };
  }

  async getUsageStats(): Promise<EmailUsageStats | null> {
    // TEM exposes statistics via GET .../statistics; not needed for the
    // Scaleway profile's cost tracking yet (Quaestor reads the Consumption
    // API instead). Deliberately unimplemented.
    return null;
  }
}

/**
 * Generic SMTP provider (`EMAIL_SERVICE=smtp`) — a minimal, dependency-free
 * RFC 5321 client over `node:net`/`node:tls`.
 *
 * Primary use: the CI/e2e mail sink (Mailpit — the G2 spike's capture
 * server) and local dev. It also speaks to real relays (e.g. the TEM SMTP
 * relay above) via implicit TLS or STARTTLS + AUTH PLAIN, but production
 * Scaleway deployments should prefer {@link ScalewayTemProvider} (structured
 * API errors, no hand-rolled TLS session management on the hot path).
 *
 * Implementation notes:
 * - Bodies are transferred base64-encoded (Content-Transfer-Encoding:
 *   base64), which sidesteps dot-stuffing and line-length limits entirely
 *   ('.' is not in the base64 alphabet).
 * - text+html sends use multipart/alternative; single-body sends use a
 *   single part.
 * - Envelope recipients = to + cc + bcc; bcc never appears in headers.
 * - AUTH PLAIN only (RFC 4616) — Mailpit and the TEM relay both accept it.
 * - Fail-closed: missing host throws at construction (factory).
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly host: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly startTls: boolean;
  private readonly username?: string;
  private readonly password?: string;
  private readonly defaultFrom?: string;
  private readonly timeoutMs: number;

  constructor(options: {
    host: string;
    /** Default 587 (submission). Mailpit's default is 1025. */
    port?: number;
    /** Implicit TLS from byte one (ports 465/2465-style). Default false. */
    secure?: boolean;
    /** Upgrade via STARTTLS after EHLO. Default false (Mailpit needs none). */
    startTls?: boolean;
    username?: string;
    password?: string;
    defaultFrom?: string;
    /** Per-command timeout. Default 15s. */
    timeoutMs?: number;
  }) {
    this.host = options.host;
    this.port = options.port ?? 587;
    this.secure = options.secure ?? false;
    this.startTls = options.startTls ?? false;
    this.username = options.username;
    this.password = options.password;
    this.defaultFrom = options.defaultFrom;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getName(): string {
    return "smtp";
  }

  async sendEmail(options: EmailSendOptions): Promise<EmailSendResult> {
    const fromAddr = options.from || this.defaultFrom;
    if (!fromAddr) {
      throw new Error(
        "SMTP requires a from address (options.from or the provider's defaultFrom)",
      );
    }
    const from = toAddressObject(fromAddr);
    const toList = toAddressList(options.to) ?? [];
    const ccList = toAddressList(options.cc) ?? [];
    const bccList = toAddressList(options.bcc) ?? [];
    const recipients = [...toList, ...ccList, ...bccList].map((a) => a.email);
    if (recipients.length === 0) {
      throw new Error("SMTP send requires at least one recipient");
    }

    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${from.email.split("@")[1] || "localhost"}>`;
    const message = buildMimeMessage({
      from: fromAddr,
      to: toList,
      cc: ccList,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
      messageId,
    });

    await this.transact(from.email, recipients, message);
    return { messageId, provider: "smtp" };
  }

  /** Run the full SMTP dialogue for one message. */
  private async transact(
    envelopeFrom: string,
    recipients: string[],
    message: string,
  ): Promise<void> {
    const [{ connect: netConnect }, tls] = await Promise.all([
      import("node:net"),
      import("node:tls"),
    ]);

    let socket: import("node:stream").Duplex = this.secure
      ? tls.connect({ host: this.host, port: this.port, servername: this.host })
      : netConnect({ host: this.host, port: this.port });

    // Line-buffered reply reader. SMTP replies may be multi-line
    // ("250-...\r\n250 ..."): the final line has a space after the code.
    let buffer = "";
    let pendingResolve: ((reply: { code: number; text: string }) => void) | null = null;
    let pendingReject: ((err: Error) => void) | null = null;
    let timer: NodeJS.Timeout | null = null;

    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        pendingReject?.(new Error(`SMTP timeout after ${this.timeoutMs}ms (${this.host}:${this.port})`));
        socket.destroy();
      }, this.timeoutMs);
    };

    const tryFlushReply = () => {
      // Scan buffered lines for a completed reply (last line: "NNN text").
      const lines = buffer.split("\r\n");
      // Last element is a partial line (or "") — never inspect it as final.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (/^\d{3}(?: |$)/.test(line)) {
          const code = Number(line.slice(0, 3));
          const consumed = lines.slice(0, i + 1);
          buffer = lines.slice(i + 1).join("\r\n");
          if (timer) clearTimeout(timer);
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve?.({ code, text: consumed.join("\n") });
          return;
        }
      }
    };

    const attachReader = (s: import("node:stream").Duplex) => {
      s.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        tryFlushReply();
      });
      s.on("error", (err: Error) => {
        if (timer) clearTimeout(timer);
        pendingReject?.(err);
      });
    };
    attachReader(socket);

    const readReply = (): Promise<{ code: number; text: string }> =>
      new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        armTimeout();
        tryFlushReply(); // a full reply may already be buffered
      });

    const command = async (
      line: string,
      expect: number[],
    ): Promise<{ code: number; text: string }> => {
      socket.write(`${line}\r\n`);
      const reply = await readReply();
      if (!expect.includes(reply.code)) {
        socket.destroy();
        // Never echo AUTH payloads into errors.
        const redacted = line.startsWith("AUTH") ? "AUTH ***" : line;
        throw new Error(`SMTP ${redacted} failed: ${reply.text}`);
      }
      return reply;
    };

    try {
      const greeting = await readReply();
      if (greeting.code !== 220) {
        throw new Error(`SMTP greeting failed: ${greeting.text}`);
      }
      await command("EHLO trellis.localdomain", [250]);

      if (this.startTls && !this.secure) {
        await command("STARTTLS", [220]);
        // Upgrade the existing socket; re-EHLO afterwards (RFC 3207 §4.2).
        socket = tls.connect({ socket: socket as import("node:net").Socket, servername: this.host });
        buffer = "";
        attachReader(socket);
        await command("EHLO trellis.localdomain", [250]);
      }

      if (this.username !== undefined && this.password !== undefined) {
        // AUTH PLAIN: base64("\0user\0pass") — RFC 4616.
        const token = Buffer.from(`\u0000${this.username}\u0000${this.password}`).toString("base64");
        await command(`AUTH PLAIN ${token}`, [235]);
      }

      await command(`MAIL FROM:<${envelopeFrom}>`, [250]);
      for (const rcpt of recipients) {
        await command(`RCPT TO:<${rcpt}>`, [250, 251]);
      }
      await command("DATA", [354]);
      socket.write(message.endsWith("\r\n") ? message : `${message}\r\n`);
      await command(".", [250]);
      // QUIT is best-effort; the message is accepted at this point.
      socket.write("QUIT\r\n");
    } finally {
      if (timer) clearTimeout(timer);
      socket.destroy();
    }
  }
}

/** Build the RFC 5322 message (headers + base64 bodies). Exported for tests. */
export function buildMimeMessage(parts: {
  from: string;
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  messageId: string;
}): string {
  // Header-injection guard: every value that lands verbatim in a header line
  // below must be free of CR/LF/NUL, checked BEFORE any header string is
  // assembled (a raw \r\n in a display name or Reply-To could otherwise
  // terminate the header and inject an arbitrary one).
  assertNoHeaderInjection(parts.from, "from");
  for (const addr of parts.to) {
    assertNoHeaderInjection(addr.email, "to.email");
    if (addr.name) assertNoHeaderInjection(addr.name, "to.name");
  }
  for (const addr of parts.cc) {
    assertNoHeaderInjection(addr.email, "cc.email");
    if (addr.name) assertNoHeaderInjection(addr.name, "cc.name");
  }
  if (parts.replyTo) assertNoHeaderInjection(parts.replyTo, "replyTo");
  assertNoHeaderInjection(parts.subject, "subject");

  const fmt = (a: { email: string; name?: string }) =>
    a.name ? `"${a.name.replace(/"/g, "")}" <${a.email}>` : a.email;
  // Encode non-ASCII subjects as RFC 2047 encoded-words.
  const subject = /^[\x20-\x7e]*$/.test(parts.subject)
    ? parts.subject
    : `=?UTF-8?B?${Buffer.from(parts.subject, "utf8").toString("base64")}?=`;

  const headers: string[] = [
    `From: ${parts.from}`,
    `To: ${parts.to.map(fmt).join(", ")}`,
  ];
  if (parts.cc.length > 0) headers.push(`Cc: ${parts.cc.map(fmt).join(", ")}`);
  if (parts.replyTo) headers.push(`Reply-To: ${parts.replyTo}`);
  headers.push(`Subject: ${subject}`);
  headers.push(`Message-ID: ${parts.messageId}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push("MIME-Version: 1.0");

  const b64 = (s: string) => {
    const raw = Buffer.from(s, "utf8").toString("base64");
    // 76-char lines per RFC 2045 §6.8.
    return raw.replace(/(.{76})/g, "$1\r\n");
  };
  const bodyPart = (type: string, content: string) =>
    [
      `Content-Type: ${type}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      b64(content),
    ].join("\r\n");

  let body: string;
  if (parts.text !== undefined && parts.html !== undefined) {
    const boundary = `=_trellis_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      bodyPart("text/plain", parts.text),
      `--${boundary}`,
      bodyPart("text/html", parts.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else if (parts.html !== undefined) {
    const [typeLine, encLine, , ...content] = bodyPart("text/html", parts.html).split("\r\n");
    headers.push(typeLine, encLine);
    body = content.join("\r\n");
  } else {
    const [typeLine, encLine, , ...content] = bodyPart("text/plain", parts.text ?? "").split("\r\n");
    headers.push(typeLine, encLine);
    body = content.join("\r\n");
  }

  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/**
 * Factory function to create email provider based on region and configuration
 */
export interface EmailProviderConfig {
  provider:
    | "resend"
    | "alibaba-directmail"
    | "tencent-ses"
    | "aws-ses"
    | "scaleway-tem"
    | "smtp";
  region?: string; // For region-specific provider selection
  // Resend config
  resendApiKey?: string;
  resendBaseUrl?: string;
  // Alibaba DirectMail config
  alibabaAccessKeyId?: string;
  alibabaAccessKeySecret?: string;
  alibabaRegion?: string;
  alibabaAccountName?: string;
  // Tencent SES config
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentRegion?: string;
  tencentFromEmail?: string;
  // AWS SES config
  /**
   * @deprecated Ignored for authentication. The SES provider now uses the
   * default AWS credential provider chain (ECS task / Lambda execution role).
   * Retained only so existing call sites that still pass it keep compiling.
   */
  awsAccessKeyId?: string;
  /**
   * @deprecated Ignored for authentication. See `awsAccessKeyId`.
   */
  awsSecretAccessKey?: string;
  awsRegion?: string;
  /** Default From address for the SES provider (used when a send omits `from`). */
  awsFromEmail?: string;
  /** SES configuration set name applied to every send (event publishing/tracking). */
  sesConfigurationSet?: string;
  // Scaleway TEM config
  temProjectId?: string;
  temSecretKey?: string;
  temRegion?: string;
  temApiUrl?: string;
  /** Default From address for TEM/SMTP (used when a send omits `from`). */
  fromEmail?: string;
  // Generic SMTP config
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpStartTls?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
}

/**
 * Structural source for {@link emailProviderConfigFromEnv} /
 * {@link validateEmailEnv}. Both the application `Env` object and the raw
 * `process.env` satisfy this shape, so a single helper serves the API and the
 * Cognito Lambda. All fields are optional strings.
 */
export interface EmailEnvSource {
  EMAIL_SERVICE?: string;
  EMAIL_SERVICE_REGION?: string;
  AWS_SES_REGION?: string;
  SES_REGION?: string;
  AWS_REGION?: string;
  FROM_EMAIL?: string;
  SES_CONFIGURATION_SET?: string;
  RESEND_API_KEY?: string;
  RESEND_BASE_URL?: string;
  ALIBABA_ACCESS_KEY_ID?: string;
  ALIBABA_ACCESS_KEY_SECRET?: string;
  ALIBABA_REGION?: string;
  ALIBABA_ACCOUNT_NAME?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_REGION?: string;
  TENCENT_FROM_EMAIL?: string;
  // Scaleway TEM (manifest D8a DRAFT — to be frozen with the WS-0 manifest):
  //   EMAIL_SERVICE=scaleway-tem selects the provider;
  //   TEM_PROJECT_ID    — Scaleway project the TEM domain lives in (required);
  //   TEM_SECRET_KEY    — IAM API secret key (falls back to SCW_SECRET_KEY,
  //                       the standard Scaleway SDK/CLI variable);
  //   TEM_REGION        — default fr-par;
  //   TEM_API_URL       — override for tests/fakes.
  TEM_PROJECT_ID?: string;
  TEM_SECRET_KEY?: string;
  SCW_SECRET_KEY?: string;
  TEM_REGION?: string;
  TEM_API_URL?: string;
  // Generic SMTP (manifest D8a DRAFT): EMAIL_SERVICE=smtp selects it.
  //   SMTP_HOST (required), SMTP_PORT (default 587; Mailpit: 1025),
  //   SMTP_SECURE=true → implicit TLS, SMTP_STARTTLS=true → STARTTLS,
  //   SMTP_USERNAME/SMTP_PASSWORD → AUTH PLAIN (both or neither).
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_STARTTLS?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
}

/**
 * Build an {@link EmailProviderConfig} from an env-shaped source.
 *
 * Region precedence for the AWS SES provider:
 *   EMAIL_SERVICE_REGION → AWS_SES_REGION → SES_REGION → AWS_REGION → us-east-1.
 *
 * Shared by the API (passes `Env`) and the Cognito magic-link Lambda (passes
 * `process.env`) so provider selection is defined in exactly one place.
 */
export function emailProviderConfigFromEnv(
  src: EmailEnvSource,
): EmailProviderConfig {
  const provider =
    (src.EMAIL_SERVICE as EmailProviderConfig["provider"]) || "aws-ses";
  const awsRegion =
    src.EMAIL_SERVICE_REGION ||
    src.AWS_SES_REGION ||
    src.SES_REGION ||
    src.AWS_REGION ||
    "us-east-1";
  return {
    provider,
    // Resend
    resendApiKey: src.RESEND_API_KEY,
    resendBaseUrl: src.RESEND_BASE_URL,
    // AWS SES (role-based; no static credentials)
    awsRegion,
    awsFromEmail: src.FROM_EMAIL,
    sesConfigurationSet: src.SES_CONFIGURATION_SET,
    // Alibaba DirectMail
    alibabaAccessKeyId: src.ALIBABA_ACCESS_KEY_ID,
    alibabaAccessKeySecret: src.ALIBABA_ACCESS_KEY_SECRET,
    alibabaRegion: src.ALIBABA_REGION,
    alibabaAccountName: src.ALIBABA_ACCOUNT_NAME,
    // Tencent SES
    tencentSecretId: src.TENCENT_SECRET_ID,
    tencentSecretKey: src.TENCENT_SECRET_KEY,
    tencentRegion: src.TENCENT_REGION,
    tencentFromEmail: src.TENCENT_FROM_EMAIL,
    // Scaleway TEM
    temProjectId: src.TEM_PROJECT_ID,
    temSecretKey: src.TEM_SECRET_KEY || src.SCW_SECRET_KEY,
    temRegion: src.TEM_REGION,
    temApiUrl: src.TEM_API_URL,
    fromEmail: src.FROM_EMAIL,
    // Generic SMTP
    smtpHost: src.SMTP_HOST,
    smtpPort: src.SMTP_PORT ? Number(src.SMTP_PORT) : undefined,
    smtpSecure: src.SMTP_SECURE === "true",
    smtpStartTls: src.SMTP_STARTTLS === "true",
    smtpUsername: src.SMTP_USERNAME,
    smtpPassword: src.SMTP_PASSWORD,
  };
}

/**
 * Validate email-related env for the EXPLICITLY selected provider. Returns a
 * list of human-readable errors (empty = valid). Only the fields the selected
 * provider actually needs are checked:
 *   - `resend`  → RESEND_API_KEY
 *   - `aws-ses` → FROM_EMAIL
 *
 * Callers gate this on `EMAIL_SERVICE` being set, so a deployment that never
 * selects a provider is never penalised.
 */
export function validateEmailEnv(src: EmailEnvSource): string[] {
  const errors: string[] = [];
  const provider = src.EMAIL_SERVICE;
  if (provider === "resend") {
    if (!src.RESEND_API_KEY) {
      errors.push("RESEND_API_KEY is required when EMAIL_SERVICE=resend");
    }
  } else if (provider === "aws-ses") {
    if (!src.FROM_EMAIL) {
      errors.push("FROM_EMAIL is required when EMAIL_SERVICE=aws-ses");
    }
  } else if (provider === "scaleway-tem") {
    if (!src.TEM_PROJECT_ID) {
      errors.push("TEM_PROJECT_ID is required when EMAIL_SERVICE=scaleway-tem");
    }
    if (!src.TEM_SECRET_KEY && !src.SCW_SECRET_KEY) {
      errors.push(
        "TEM_SECRET_KEY (or SCW_SECRET_KEY) is required when EMAIL_SERVICE=scaleway-tem",
      );
    }
    if (!src.FROM_EMAIL) {
      errors.push("FROM_EMAIL is required when EMAIL_SERVICE=scaleway-tem");
    }
  } else if (provider === "smtp") {
    if (!src.SMTP_HOST) {
      errors.push("SMTP_HOST is required when EMAIL_SERVICE=smtp");
    }
    if (!src.FROM_EMAIL) {
      errors.push("FROM_EMAIL is required when EMAIL_SERVICE=smtp");
    }
    // AUTH PLAIN needs both halves; one without the other is a config bug.
    if (Boolean(src.SMTP_USERNAME) !== Boolean(src.SMTP_PASSWORD)) {
      errors.push(
        "SMTP_USERNAME and SMTP_PASSWORD must be set together (or both unset) when EMAIL_SERVICE=smtp",
      );
    }
  }
  return errors;
}

export function createEmailProvider(
  config: EmailProviderConfig,
): EmailProvider {
  // If region is China, prefer China-compatible providers
  if (config.region === "CN" || config.region === "cn") {
    // Priority: Alibaba DirectMail > Tencent SES > AWS SES (China regions)
    if (
      config.provider === "alibaba-directmail" ||
      (config.provider === "resend" && config.alibabaAccessKeyId)
    ) {
      if (
        !config.alibabaAccessKeyId ||
        !config.alibabaAccessKeySecret ||
        !config.alibabaAccountName
      ) {
        throw new Error(
          "Alibaba DirectMail requires accessKeyId, accessKeySecret, and accountName",
        );
      }
      return new AlibabaDirectMailProvider(
        config.alibabaAccessKeyId,
        config.alibabaAccessKeySecret,
        config.alibabaRegion || "cn-hangzhou",
        config.alibabaAccountName,
      );
    }

    if (
      config.provider === "tencent-ses" ||
      (config.provider === "resend" && config.tencentSecretId)
    ) {
      if (
        !config.tencentSecretId ||
        !config.tencentSecretKey ||
        !config.tencentFromEmail
      ) {
        throw new Error(
          "Tencent SES requires secretId, secretKey, and fromEmail",
        );
      }
      return new TencentSESProvider(
        config.tencentSecretId,
        config.tencentSecretKey,
        config.tencentRegion || "ap-beijing",
        config.tencentFromEmail,
      );
    }

    if (
      config.provider === "aws-ses" ||
      (config.provider === "resend" &&
        (config.awsAccessKeyId || config.awsFromEmail))
    ) {
      // Role-based auth (default credential chain); China region by default.
      return new AWSSESProvider(config.awsRegion || "cn-north-1", {
        fromEmail: config.awsFromEmail,
        configurationSet: config.sesConfigurationSet,
      });
    }
  }

  // Default to Resend for non-China regions or explicit Resend selection
  if (config.provider === "resend" || !config.provider) {
    if (!config.resendApiKey) {
      throw new Error("Resend requires resendApiKey");
    }
    return new ResendEmailProvider(config.resendApiKey, config.resendBaseUrl);
  }

  // Explicit provider selection
  switch (config.provider) {
    case "alibaba-directmail":
      if (
        !config.alibabaAccessKeyId ||
        !config.alibabaAccessKeySecret ||
        !config.alibabaAccountName
      ) {
        throw new Error(
          "Alibaba DirectMail requires accessKeyId, accessKeySecret, and accountName",
        );
      }
      return new AlibabaDirectMailProvider(
        config.alibabaAccessKeyId,
        config.alibabaAccessKeySecret,
        config.alibabaRegion || "cn-hangzhou",
        config.alibabaAccountName,
      );

    case "tencent-ses":
      if (
        !config.tencentSecretId ||
        !config.tencentSecretKey ||
        !config.tencentFromEmail
      ) {
        throw new Error(
          "Tencent SES requires secretId, secretKey, and fromEmail",
        );
      }
      return new TencentSESProvider(
        config.tencentSecretId,
        config.tencentSecretKey,
        config.tencentRegion || "ap-beijing",
        config.tencentFromEmail,
      );

    case "aws-ses":
      // Role-based auth: the default AWS credential provider chain supplies
      // credentials (ECS task role / Lambda execution role). Any
      // awsAccessKeyId/awsSecretAccessKey on the config are @deprecated and
      // ignored — no static keys are threaded into the client.
      return new AWSSESProvider(config.awsRegion || "us-east-1", {
        fromEmail: config.awsFromEmail,
        configurationSet: config.sesConfigurationSet,
      });

    case "scaleway-tem":
      // Fail closed: refuse to construct a half-configured client.
      if (!config.temProjectId || !config.temSecretKey) {
        throw new Error(
          "Scaleway TEM requires temProjectId and temSecretKey (TEM_PROJECT_ID + TEM_SECRET_KEY/SCW_SECRET_KEY)",
        );
      }
      return new ScalewayTemProvider({
        secretKey: config.temSecretKey,
        projectId: config.temProjectId,
        region: config.temRegion,
        baseUrl: config.temApiUrl,
        defaultFrom: config.fromEmail,
      });

    case "smtp":
      if (!config.smtpHost) {
        throw new Error("SMTP provider requires smtpHost (SMTP_HOST)");
      }
      if (Boolean(config.smtpUsername) !== Boolean(config.smtpPassword)) {
        throw new Error(
          "SMTP provider requires smtpUsername and smtpPassword together (or neither)",
        );
      }
      return new SmtpEmailProvider({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        startTls: config.smtpStartTls,
        username: config.smtpUsername,
        password: config.smtpPassword,
        defaultFrom: config.fromEmail,
      });

    default:
      throw new Error(`Unknown email provider: ${config.provider}`);
  }
}
