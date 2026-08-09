import fs from 'node:fs';

const namespaceId = String(process.env.ATTACHMENT_KV_NAMESPACE_ID || '').trim();
if (!/^[a-f0-9]{32}$/i.test(namespaceId)) {
  console.error(
    'ATTACHMENT_KV_NAMESPACE_ID must contain the 32-character ID of the nicdai-email-attachments KV namespace.'
  );
  process.exitCode = 1;
} else {
  const sourceUrl = new URL('../wrangler.jsonc', import.meta.url);
  const outputUrl = new URL('../.wrangler.deploy.jsonc', import.meta.url);
  const config = JSON.parse(fs.readFileSync(sourceUrl, 'utf8'));
  config.kv_namespaces = [{ binding: 'ATTACHMENT_KV', id: namespaceId }];
  fs.writeFileSync(outputUrl, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log('Prepared Worker deployment configuration with the ATTACHMENT_KV binding.');
}
