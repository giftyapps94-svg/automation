#!/usr/bin/env node
/**
 * One-time interactive login.
 *
 *   npm run login            # log in, or verify the existing session
 *   npm run login -- --force # ignore the saved session and log in again
 *
 * Opens a real browser window using the SAME persistent profile that
 * `npm run start` uses. If that profile is already logged in, this exits
 * immediately without asking for anything — credentials are only needed the
 * first time, or after Shopify actually expires the session.
 */
import readline from 'node:readline/promises';
import { config, parseArgs } from './config.js';
import { launchContext, saveAuthState, isLoggedIn } from './browser.js';
import { log } from './util.js';

const args = parseArgs();

async function main() {
  const context = await launchContext({ headless: false });

  try {
    if (!args.force && (await isLoggedIn(context))) {
      log('Already logged in — no credentials needed.');
      await saveAuthState(context);
      log(`Session refreshed at ${config.authState}`);
      return;
    }

    const page = await context.newPage();
    log(`Opening ${config.adminUrl} — log in manually.`);
    await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded' });

    // Warm up themes.shopify.com too, so the "Try theme" flow already knows the account.
    const themeStore = await context.newPage();
    await themeStore.goto(config.themeStoreUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(
      '\nLog in to Shopify admin in the browser window.\n' +
        'Tick "remember me"/"trust this device" if offered — it keeps 2FA from ' +
        'reappearing.\nWhen you can see the admin dashboard, press Enter here to save the session... ',
    );
    rl.close();

    await saveAuthState(context);
    log(`Session saved to ${config.authState}`);
    log(`Browser profile kept at ${config.userDataDir} — later runs reuse it, so this is a one-off.`);
  } finally {
    // Closing the context is what flushes the profile to disk.
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
