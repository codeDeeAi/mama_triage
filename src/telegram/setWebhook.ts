/**
 * Register the Telegram webhook against a deployment.
 *
 * Run with: npm run telegram:webhook -- https://your-domain
 *
 * Checks the deployment before touching the bot, because a webhook pointed at a URL that
 * is not serving looks identical to a bot that is simply not responding — and Telegram
 * accepts the registration either way, so the mistake surfaces later as silence.
 *
 * Telegram requires HTTPS with a certificate from a trusted CA. A self-signed certificate
 * is rejected, which is the usual failure on a fresh deployment whose reverse proxy has
 * not issued one yet.
 */

import { TelegramClient } from './client';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = process.argv[2] ?? process.env.PUBLIC_BASE_URL;

  if (!token) fail('TELEGRAM_BOT_TOKEN is not set.');
  if (!secret) {
    fail(
      'TELEGRAM_WEBHOOK_SECRET is not set.\n\n' +
        'It must be the value the deployment is running with — Telegram echoes it on ' +
        'every update, and the app rejects anything that does not match. On Coolify it ' +
        'is generated as SERVICE_PASSWORD_TELEGRAMWEBHOOK; copy it from the environment ' +
        'variables page.',
    );
  }
  if (!base) {
    fail('Usage: npm run telegram:webhook -- https://your-domain');
  }

  const origin = base.replace(/\/+$/, '');
  if (!origin.startsWith('https://')) {
    fail(
      `Telegram only accepts HTTPS webhooks, and this is ${origin.split(':')[0]}.\n\n` +
        'If the deployment answers on http but not https, the reverse proxy has not ' +
        'issued a certificate yet.',
    );
  }

  const url = `${origin}/webhook/telegram`;

  // Verify the deployment first. `/healthz` deliberately does not touch the database, so
  // a 200 here means the process is up; it is the weakest useful check and the right one
  // for "is there anything at this address at all".
  process.stdout.write(`Checking ${origin}/healthz ...\n`);
  try {
    const res = await fetch(`${origin}/healthz`);
    if (!res.ok) fail(`  ${origin}/healthz returned ${res.status}. Not registering.`);
    process.stdout.write(`  ok\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(
      `  could not reach ${origin}/healthz: ${reason}\n\n` +
        'If this is a certificate error, Telegram will fail the same way. Fix HTTPS ' +
        'first — registering now would leave the bot silently unreachable.',
    );
  }

  const client = new TelegramClient({ token });

  const me = await client.getMe();
  process.stdout.write(`Bot: @${me.username}\n`);

  await client.setWebhook(url, secret);
  process.stdout.write(`Webhook set: ${url}\n`);

  process.stdout.write(
    '\nLong polling is now disabled — Telegram refuses getUpdates while a webhook is ' +
      'registered. Do not run `npm run telegram:poll` against this bot.\n',
  );
}

/* istanbul ignore next -- CLI wiring */
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
