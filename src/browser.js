/**
 * Single place where the browser is launched, so `npm run login` and
 * `npm run start` always get an IDENTICAL browser.
 *
 * WHY A PERSISTENT PROFILE
 * `storageState` (auth.json) only carries cookies + localStorage. Shopify admin
 * also leans on sessionStorage, IndexedDB and a device-trust marker, none of
 * which survive a storageState round-trip — which is why a restored session
 * keeps bouncing back to the login screen. A real on-disk Chrome profile keeps
 * all of it, so the login sticks across runs.
 *
 * auth.json is still written after every session (for anything that reads it,
 * and as a portable backup) and is used to seed a brand-new profile once.
 */
import { existsSync } from 'node:fs';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';
import { log } from './util.js';

// Chrome's own automation banner makes Shopify's bot checks re-challenge the
// session; both entry points must launch with the same flags or the profile
// looks like a different device on the next run.
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

/**
 * Launch a persistent context. The same profile directory is reused by every
 * command, so a login done once is still there on the next run.
 *
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function launchContext({ headless = false, slowMo = 0 } = {}) {
  await mkdir(config.userDataDir, { recursive: true });
  const firstRun = !existsSync(path.join(config.userDataDir, 'Default'));

  const options = {
    headless,
    slowMo,
    viewport: { width: 1440, height: 900 },
    args: LAUNCH_ARGS,
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(config.userDataDir, {
      ...options,
      channel: config.browserChannel || undefined,
    });
  } catch (err) {
    // Installed Chrome is preferred (Shopify treats bundled Chromium as more
    // suspicious), but fall back rather than dying if it isn't present.
    log(`  ! channel "${config.browserChannel}" unavailable (${err.message.split('\n')[0]}) — using bundled Chromium`);
    context = await chromium.launchPersistentContext(config.userDataDir, options);
  }

  context.setDefaultTimeout(30000);
  if (firstRun) await seedFromAuthState(context);
  return context;
}

/** One-time import of a pre-existing auth.json into a fresh profile. */
async function seedFromAuthState(context) {
  if (!existsSync(config.authState)) return;
  try {
    const state = JSON.parse(await readFile(config.authState, 'utf8'));
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
      log(`  seeded new browser profile with ${state.cookies.length} cookie(s) from ${path.basename(config.authState)}`);
    }
  } catch (err) {
    log(`  ! could not seed profile from ${config.authState}: ${err.message}`);
  }
}

/**
 * Persist cookies + localStorage to auth.json. Called after login AND after
 * every run, so cookies Shopify rotated mid-run are not thrown away.
 */
export async function saveAuthState(context) {
  await context.storageState({ path: config.authState });
  // The file is a complete admin session — keep it owner-only.
  await chmod(config.authState, 0o600).catch(() => {});
  return config.authState;
}

/** True when the profile can reach the admin without being bounced to login. */
export async function isLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(`${config.adminUrl}/themes`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    return !/accounts\.shopify\.com|\/login/.test(page.url());
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}
