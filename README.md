# NICDAI Cloudflare SMTP relay

This Worker accepts authenticated email requests from the NICDAI Render service,
adds them to Cloudflare Queues, returns `202 Accepted`, and sends them through the
configured SMTP server in a background queue consumer.

The Worker accepts `POST /send` with:

```json
{
  "to": ["student@example.com"],
  "cc": ["support@example.com"],
  "subject": "NICDAI email verification",
  "body": "<p>Your verification code is ABC123.</p>",
  "bodyType": "html"
}
```

`to` is required and may be a string or array. `cc` is optional. `bodyType` must
be `text` or `html`. The maximum body size is 80,000 UTF-8 bytes and the combined
recipient limit is 50.

## One-time Cloudflare setup

Cloudflare Queues is available on Workers Free. From this directory:

```bash
npm install
npx wrangler login
npx wrangler queues create nicdai-email-delivery
npx wrangler queues create nicdai-email-dead-letter
```

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
| `SMTP_EHLO_NAME` | `nicdai-email-relay.workers.dev` |
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
https://nicdai-email-relay.YOUR-SUBDOMAIN.workers.dev/health
```

## Connect Render

Add these Render environment variables:

```text
EMAIL_RELAY_URL=https://nicdai-email-relay.YOUR-SUBDOMAIN.workers.dev/send
EMAIL_RELAY_KEY=the-same-value-stored-as-RELAY_API_KEY
EMAIL_RELAY_TIMEOUT_MS=10000
EMAIL_FROM=the-same-address-as-the-worker-SMTP_FROM_EMAIL
```

The NICDAI server uses this relay automatically for mail without attachments.
If direct SMTP is also configured, it is used when the relay HTTP request fails
and for certificate emails with PDF attachments. The current Worker payload
does not accept attachments.

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

In Cloudflare Workers & Pages, import the GitHub repository and use:

```text
Root directory: /
Build command: npm run build
Deploy command: npm run deploy
```

Create both queues and add every secret in the Cloudflare dashboard before the
first Git-connected deployment. The committed `wrangler.jsonc` connects the
producer and consumer to the same delivery queue.
