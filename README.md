# NICDAI Cloudflare SMTP relay

This Worker accepts authenticated email requests from the NICDAI Render service,
stages PDF attachments temporarily in Cloudflare Workers KV, adds small delivery
messages to Cloudflare Queues, returns `202 Accepted`, and sends them through the
configured SMTP server in a background queue consumer.

The Worker accepts `POST /send` with:

```json
{
  "to": ["student@example.com"],
  "cc": ["support@example.com"],
  "subject": "NICDAI email verification",
  "body": "<p>Your verification code is ABC123.</p>",
  "bodyType": "html",
  "attachments": [{
    "filename": "NICDAI-2026-EXAMPLE.pdf",
    "contentType": "application/pdf",
    "size": 123456,
    "sha256": "64-lowercase-hex-characters",
    "contentBase64": "base64-encoded-pdf"
  }]
}
```

`to` is required and may be a string or array. `cc` is optional. `bodyType` must
be `text` or `html`. The maximum body size is 80,000 UTF-8 bytes and the combined
recipient limit is 50. Attachments are optional, restricted to three validated
PDF files, 10 MB per file and 15 MB total. The Render application calculates the
size and SHA-256 digest automatically.

## One-time Cloudflare setup

Cloudflare Queues is available on Workers Free. From this directory:

```bash
npm install
npx wrangler login
npx wrangler queues create nicdai-email-delivery
npx wrangler queues create nicdai-email-dead-letter
npx wrangler kv namespace create nicdai-email-attachments
```

Copy the 32-character namespace ID printed by Wrangler. Before deploying from a
terminal, expose it only to the build process:

```bash
export ATTACHMENT_KV_NAMESPACE_ID=replace-with-the-32-character-namespace-id
```

On Windows Command Prompt use `set ATTACHMENT_KV_NAMESPACE_ID=...`; on
PowerShell use `$env:ATTACHMENT_KV_NAMESPACE_ID='...'`. The deployment script
creates a temporary Wrangler configuration that binds that exact namespace as
`ATTACHMENT_KV`. The namespace ID is an identifier, not a secret, but it should
still be supplied as configuration instead of hard-coded.

When using the Cloudflare dashboard, create the namespace under **Storage &
Databases → Workers KV**. Do not look for it in the R2 bucket selector. The
deployment script binds it by its namespace ID, so a separate manual dashboard
binding is not required.

The Worker writes binary PDFs directly to KV with a 24-hour expiration, queues
only their private key and integrity metadata, waits 60 seconds for KV
propagation, and deletes each key after SMTP accepts the email. No public file
URL is created.

Generate a relay key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Store the authentication key and SMTP credentials as encrypted Worker secrets.
Do not commit their real values:

```bash
npx wrangler secret put RELAY_API_KEY
npx wrangler secret put SMTP_USERNAME
npx wrangler secret put SMTP_PASSWORD
```

`RELAY_API_KEY`, `SMTP_USERNAME`, and `SMTP_PASSWORD` are required and
intentionally have no usable default. Default credentials would make the relay
unsafe. `SMTP_FROM_EMAIL` defaults to `SMTP_USERNAME` when it is not set.

All other runtime settings are Cloudflare environment bindings. Safe defaults
are committed in `wrangler.jsonc` and are also applied by the Worker if a binding
is omitted:

| Environment binding | Default |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `SMTP_FROM_EMAIL` | Value of `SMTP_USERNAME` |
| `SMTP_FROM_NAME` | `NICDAI` |
| `SMTP_EHLO_NAME` | `nicdai-email-relay.demojangid.workers.dev` |
| `SMTP_TIMEOUT_MS` | `30000` |

Copy `.dev.vars.example` to `.dev.vars` for local development. The real
`.dev.vars` file is ignored by Git.

For Gmail with implicit TLS, use the defaults and configure the required values:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=your-full-address@gmail.com
SMTP_PASSWORD=your-16-character-Google-App-Password
SMTP_FROM_EMAIL=your-full-address@gmail.com
SMTP_FROM_NAME=NICDAI
```

For Gmail STARTTLS, change `SMTP_PORT` to `587` and `SMTP_SECURE` to `false` in
`wrangler.jsonc`. Port 25 is intentionally rejected because Workers blocks it.

Deploy:

```bash
npm run check
npm run build
npm run deploy
```

The health endpoint is:

```text
https://nicdai-email-relay.demojangid.workers.dev/health
```

It should report both `queueConfigured` and `attachmentStorageConfigured` as
`true`, with `attachmentStorage` set to `workers-kv`, before certificate delivery
is enabled.

## Connect Render

Add these Render environment variables:

```text
EMAIL_RELAY_URL=https://nicdai-email-relay.demojangid.workers.dev/send
EMAIL_RELAY_KEY=the-same-value-stored-as-RELAY_API_KEY
EMAIL_RELAY_TIMEOUT_MS=30000
EMAIL_FROM=the-same-address-as-the-worker-SMTP_FROM_EMAIL
```

The NICDAI server uses this relay exclusively for every email when the relay URL
and key are configured, including certificate emails with PDF attachments.
Attachments are staged privately in Workers KV, integrity-checked before
delivery, attached to a multipart MIME message, and deleted after Gmail accepts
the message. Render does not attempt direct SMTP if the Worker rejects or cannot
accept a relay request.

Call the Worker only from the Render backend, never from browser JavaScript:

```js
const response = await fetch(process.env.EMAIL_RELAY_URL, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.EMAIL_RELAY_KEY}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    to: ['student@example.com'],
    cc: [],
    subject: 'NICDAI verification code',
    body: '<p>Your verification code is <strong>ABC123</strong>.</p>',
    bodyType: 'html'
  })
});

if (response.status !== 202) {
  throw new Error(`Email relay rejected the request: ${response.status}`);
}
```

The successful response is:

```json
{
  "status": "queued",
  "requestId": "generated-uuid"
}
```

SMTP failures are retried with exponential delays. After the configured retry
limit, Cloudflare moves the message to `nicdai-email-dead-letter`. Use Workers
logs and Queue metrics to monitor delivery; message bodies and credentials are
never written to application logs.

## Deploy from GitHub

In Cloudflare Workers & Pages, import the `nicdai-email-relay` GitHub repository
and use:

```text
Root directory: ./
Build command: npm run build
Deploy command: npm run deploy
```

If deploying the embedded Worker from `nicdai-app`, use
`cloudflare-email-worker` as the root directory instead.

Create both queues and the `nicdai-email-attachments` KV namespace before the
first Git-connected deployment. In **Workers & Pages → your Worker → Settings →
Build → Variables and secrets**, add:

```text
ATTACHMENT_KV_NAMESPACE_ID=the-32-character-KV-namespace-ID
```

This is a build variable used by `npm run deploy`; it is not a Worker runtime
secret. Add `RELAY_API_KEY`, `SMTP_USERNAME`, and `SMTP_PASSWORD` as encrypted
Worker runtime secrets. The generated deployment configuration connects the
producer, consumer, and `ATTACHMENT_KV` binding to the exact namespace ID.
