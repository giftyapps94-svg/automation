/** Shared Playwright helpers. Themes vary wildly, so nearly everything here is
 *  "try a list of candidates, take the first one that actually works". */

export const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a list of Playwright locators from loose candidate descriptors.
 * A descriptor is either a CSS/text selector string, or {role, name} / {text}.
 */
export function toLocators(scope, candidates) {
  return candidates.map((c) => {
    if (typeof c === 'string') return scope.locator(c);
    if (c.role) return scope.getByRole(c.role, { name: c.name, exact: false });
    if (c.text) return scope.getByText(c.text, { exact: false });
    throw new Error(`Unsupported candidate: ${JSON.stringify(c)}`);
  });
}

/**
 * First candidate that resolves to a visible element, or null.
 *
 * `index` picks which match of a candidate to prefer when one descriptor hits
 * several elements — theme store pages render the same control twice (hero +
 * sticky bar), and only one of them is the live one. The requested index is
 * tried first and the first visible match is the fallback, so pages with a
 * single copy of the control still work.
 */
export async function firstVisible(scope, candidates, { timeout = 8000, index = 0 } = {}) {
  const deadline = Date.now() + timeout;
  const locators = toLocators(scope, candidates);
  while (Date.now() < deadline) {
    for (const locator of locators) {
      const tries = index ? [locator.nth(index), locator.first()] : [locator.first()];
      for (const el of tries) {
        try {
          if (await el.isVisible({ timeout: 250 })) return el;
        } catch {
          /* locator not attached / index out of range — keep polling */
        }
      }
    }
    await sleep(250);
  }
  return null;
}

/** Click the first visible candidate. Returns true if something was clicked. */
export async function clickFirst(scope, candidates, { timeout = 8000, label = '', index = 0 } = {}) {
  const el = await firstVisible(scope, candidates, { timeout, index });
  if (!el) {
    if (label) log(`  ! could not find: ${label}`);
    return false;
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 10000 });
  log('clicked', el,label);
  return true;
}

/** Wait for the network to go quiet, but never hang the run on it. */
export async function settle(page, ms = 1500) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(ms);
}

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

/** Append `preview_theme_id` to a storefront URL so the page renders the unpublished theme. */
export function withPreview(url, themeId) {
  if (!themeId) return url;
  const u = new URL(url);
  u.searchParams.set('preview_theme_id', String(themeId));
  return u.toString();
}
