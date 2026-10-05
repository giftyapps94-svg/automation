/** Everything that happens on themes.shopify.com: listing, pricing, "Try theme". */
import { config } from './config.js';
import { clickFirst, firstVisible, log, settle, sleep } from './util.js';
import { waitForThemeInLibrary } from './adminThemes.js';

/**
 * Read the theme list produced by shopify_theme_scraper.py.
 * Entries look like {handle, preset, name, url}.
 */
export async function loadThemesFromFile(file = config.themesFile) {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.themes || [];
  return list.filter((t) => t && t.url);
}

/**
 * Fallback discovery path: browse the theme store sorted newest-first.
 * Used when you pass `--source store` instead of the JSON file.
 */
export async function loadThemesFromStore(context, { limit = 10 } = {}) {
  const page = await context.newPage();
  const url = `${config.themeStoreUrl}/themes?sort_by=newest`;
  log(`Browsing theme store sorted by newest: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);

  // The sort control is a plain select on desktop; set it explicitly in case the
  // query param was ignored.
  const sort = await firstVisible(page, ['select[name="sort_by"]', 'select#sort_by'], {
    timeout: 4000,
  });
  if (sort) {
    await sort.selectOption('newest').catch(() => {});
    await settle(page);
  }

  const themes = await page.evaluate((max) => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/themes/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/themes\/([a-z0-9-]+)(?:\/(?:presets|styles)\/([a-z0-9-]+))?\/?$/);
      if (!m) continue;
      const key = `${m[1]}/${m[2] || ''}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        handle: m[1],
        preset: m[2] || '',
        name: (a.textContent || m[1]).trim().replace(/\s+/g, ' ').slice(0, 80),
        url: new URL(href, location.origin).toString(),
      });
      if (seen.size >= max) break;
    }
    return [...seen.values()];
  }, limit);

  await page.close();
  log(`Found ${themes.length} themes in the store listing.`);
  return themes;
}

/** Scrape name + price from a theme's store page. Price is "free" or "paid". */
async function readThemeMeta(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const name =
      document.querySelector('h1')?.textContent?.trim() ||
      document.title.split('—')[0].trim();
    const priceMatch = text.match(/\$\s?\d[\d,]*/);
    const free = /\bfree\b/i.test(text.slice(0, 4000)) && !priceMatch;
    return {
      name,
      price: free ? 'free' : priceMatch ? 'paid' : 'unknown',
      priceLabel: free ? 'Free' : priceMatch ? priceMatch[0] : null,
    };
  });
}

/**
 * Open a theme's store page and click through "Try theme" for the configured store.
 * Resolves once Shopify has redirected to the admin themes page (or the install
 * timeout is hit).
 *
 * @returns {Promise<{name: string, price: string, priceLabel: string|null, installed: boolean}>}
 */
export async function installTheme(context, theme) {
  const page = await context.newPage();
  try {
    log(`Opening theme page: ${theme.url}`);
    await page.goto(theme.url, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const meta = await readThemeMeta(page);
    log(`  ${meta.name} — ${meta.price}${meta.priceLabel ? ` (${meta.priceLabel})` : ''}`);

    const clicked = await clickFirst(
      page,
      [
        { role: 'link', name: /^\s*try theme\s*$/i },
        { role: 'button', name: /^\s*try theme\s*$/i },
        'a[href*="/try"]',
        { role: 'button', name: /add (theme )?to (theme library|store)/i },
      ],
      // Theme pages carry two "Try theme" controls (the hero one and the one in
      // the sticky header). The second is the one that actually starts the
      // install, so ask for index 1 — firstVisible falls back to the only match
      // on pages that render just one.
      { timeout: 15000, label: 'Try theme', index: 1 },
    );
    if (!clicked) return { ...meta, installed: false };

    console.log('shr clicker', clicked);
    // No confirmation step: Shopify adds the theme on its own, so just wait.
    const installed = await waitForInstall(page, meta.name || theme.name);
    return { ...meta, installed };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Wait for the install to actually finish.
 *
 * Two stages, because the redirect happens BEFORE the theme is added: first
 * wait to land on the admin themes page, then wait for the theme's row to show
 * up in the library. Returning on the redirect alone hands the next step a
 * library that does not contain the theme yet.
 */
async function waitForInstall(page, themeName) {
  const deadline = Date.now() + config.installTimeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/admin\.shopify\.com\/store\/[^/]+\/themes/.test(url)) {
      log('  redirected to admin themes page — waiting for the theme to be added');
      await settle(page, 3000);
      const remaining = Math.max(15000, deadline - Date.now());
      const { themeId } = await waitForThemeInLibrary(page, themeName, { timeout: remaining });
      return Boolean(themeId);
    }
    await sleep(2000);
  }
  log('  ! install did not redirect to admin within the timeout');
  return false;
}
