/** Admin side: locate the freshly installed theme, grab its id, open Preview. */
import { config } from './config.js';
import { clickFirst, firstVisible, log, settle, sleep } from './util.js';

/**
 * Online Store > Themes is sometimes rendered inside the admin's app iframe.
 * Return whichever context actually contains the theme library.
 */
async function themesScope(page, { timeout = 15000, quiet = false } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      // Probe for the links we actually need, not for surrounding copy.
      const hit = await frame
        .evaluate(() =>
          [...document.querySelectorAll('a[href*="/themes/"]')].some((a) =>
            /\/themes\/\d{6,}/.test(a.getAttribute('href') || ''),
          ),
        )
        .catch(() => false); // frame detached or still navigating
      if (hit) {
        if (!quiet) log(`  theme library found in frame: ${frame.url()}`);
        return frame;
      }
    }
    await sleep(500);
  }
  if (!quiet) log('  ! theme links not found in any frame — falling back to the main page');
  return page;
}

export async function openThemesPage(context) {
  const page = await context.newPage();
  await page.goto(`${config.adminUrl}/themes`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await assertLoggedIn(page);
  return page;
}

async function assertLoggedIn(page) {
  if (/accounts\.shopify\.com|\/login/.test(page.url())) {
    throw new Error(
      'Not logged in — the saved session has expired. Run `npm run login` again.',
    );
  }
}

/**
 * Find the theme's card in the library by name and read its theme id out of the
 * editor/preview links Shopify renders inside it.
 *
 * @returns {Promise<{themeId: string|null, matchedName: string|null}>}
 */
export async function findInstalledTheme(page, themeName, { quiet = false } = {}) {
  const scope = await themesScope(page, quiet ? { timeout: 5000, quiet } : {});
  const needle = normalise(themeName);
  const result = await scope.evaluate((wanted) => {
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    // Each library row carries links like /themes/123456789/editor
    const cards = new Map();
    console.log('card', document.querySelectorAll('a[href*="/themes/"]'))
    for (const a of document.querySelectorAll('a[href*="/themes/"]')) {
      const m = a.getAttribute('href').match(/\/themes\/(\d{6,})/);
      if (!m) continue;
      const card =
        a.closest('li, [role="listitem"], .Polaris-ResourceItem, [data-theme-id], div[class*="card"]') ||
        a.parentElement;
      if (!card) continue;
      // innerText is empty for cards Shopify has not painted yet, and the
      // anchor's own label is sometimes the only text there is.
      const label = norm(
        card.innerText || card.textContent || a.getAttribute('aria-label') || a.textContent,
      ).slice(0, 300);
      if (!cards.has(m[1]) || !cards.get(m[1])) cards.set(m[1], label);
    }
    const w = norm(wanted);
    // Every word counts, not just the long ones: "Be Yours" is carried by
    // "be" + "yours", and dropping words under 3 chars threw half of it away.
    // But the words every card shares must not count, or any name scores on
    // "theme"/"current"/"editor" and matches the wrong row.
    const BOILERPLATE = new Set([
      'theme', 'themes', 'current', 'live', 'editor', 'edit', 'customize',
      'preview', 'published', 'unpublished', 'default', 'library', 'actions',
      'add', 'sample', 'version', 'view', 'more',
    ]);
    const words = w.split(' ').filter(Boolean);
    const meaningful = words.filter((x) => !BOILERPLATE.has(x));
    const needles = meaningful.length ? meaningful : words;
    let best = null;
    for (const [id, label] of cards) {
      if (!label) continue;
      const hits = needles.filter((word) => label.includes(word)).length;
      // Whole name > every word present > at least two words present.
      // One shared word is not a match: that is how "Nonexistent Theme"
      // used to land on "Dawn".
      const score = label.includes(w) ? needles.length + 2
        : hits === needles.length ? needles.length + 1
        : hits >= 2 ? hits
        : 0;
      if (score && (!best || score > best.score)) best = { id, label, score };
    }
    console.log(best, cards, w)
    return best ? { themeId: best.id, matchedName: best.label.split('\n')[0] } : { themeId: null, matchedName: null };
  }, needle);
  if (result.themeId) log(`  matched theme in library: ${result.matchedName} (id ${result.themeId})`);
  else if (!quiet) log(`  ! could not match "${themeName}" in the theme library`);
  return result;
}

/** The ⋯ button on a theme card: aria-label "Click for more theme actions". */
const MENU_BUTTON = [
  'button[aria-label*="theme actions" i]',
  { role: 'button', name: /more (theme )?actions|more options|⋯/i },
  'button[aria-haspopup="menu"]',
];

const normalise = (s) => String(s).replace(/\s*\(.*?\)\s*$/, '').trim();

/**
 * Block until the theme really exists in the library.
 *
 * Landing on the admin themes URL is NOT the end of the install: Shopify
 * redirects first and adds the row afterwards, so anything that reads the
 * library immediately can miss it. Poll findInstalledTheme, reloading between
 * attempts because the row often arrives without the list re-rendering.
 *
 * @returns {Promise<{themeId: string|null, matchedName: string|null}>}
 */
export async function waitForThemeInLibrary(page, themeName, { timeout = 120000 } = {}) {
  const deadline = Date.now() + timeout;
  const listUrl = `${config.adminUrl}/themes`;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    // The tab that ran the install can land on the editor, on an "adding
    // theme" interstitial, or on a themes URL for a different store section.
    // Polling those never finds a library, so put it on the list first.
    if (!/\/themes(?:[/?#]|$)/.test(page.url())) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(page, 2000);
    }
    const last = Date.now() + 8000 >= deadline;
    const found = await findInstalledTheme(page, themeName, { quiet: !last })
      .catch(() => ({ themeId: null }));
    if (found.themeId) {
      log(`  theme present in library after ${attempt} check(s)`);
      return found;
    }
    if (last) break;
    await sleep(3000);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page, 2000);
  }
  log(`  ! "${themeName}" never appeared in the library within ${Math.round(timeout / 1000)}s`);
  return { themeId: null, matchedName: null };
}

/**
 * The library row for a theme. Prefer the list item wrapping the theme's own
 * links; fall back to the whole page so the ⋯ lookup still has somewhere to go.
 */
async function themeRow(scope, { themeId, themeName, strict = false }) {
  const candidates = themeId
    ? [
        // The card: nearest ancestor of this theme's links that owns a ⋯ button.
        `xpath=//a[contains(@href,"/themes/${themeId}")]/ancestor::*[.//button[contains(@aria-label,"theme actions")]][1]`,
        `li:has(a[href*="/themes/${themeId}"])`,
        `[role="listitem"]:has(a[href*="/themes/${themeId}"])`,
        `div:has(> a[href*="/themes/${themeId}"])`,
      ]
    : [`li:has-text("${normalise(themeName)}")`, `[role="listitem"]:has-text("${normalise(themeName)}")`];

  const row = await firstVisible(scope, candidates, { timeout: 6000 });
  // `strict` callers (delete) must not act on the whole-page fallback: every
  // theme's controls and badges live in there, so a miss would target the
  // wrong theme.
  if (strict) return row || null;
  return row || scope.locator('body');
}

/**
 * Open the theme's ⋯ menu and read the id out of its Preview link.
 *
 * Throws if the row, menu or link is missing — no guessed fallback URL.
 *
 * @returns {Promise<{themeId: string|null, previewUrl: string}>}
 */
export async function previewTheme(context, page, { themeName, themeId }) {
  const scope = await themesScope(page);

  // strict: never fall back to the whole page, or the first Preview link there
  // belongs to some other theme.
  const row = await themeRow(scope, { themeId, themeName, strict: true });
  if (!row) throw new Error(`Could not open preview for "${themeName}" — its row was not found in the library.`);

  const menuOpened = await clickFirst(row, MENU_BUTTON, { timeout: 6000, label: '⋯ menu' }).catch(() => false);
  if (!menuOpened) throw new Error(`Could not open preview for "${themeName}" — ⋯ menu not found.`);

  // Preview is a link: <a aria-label="Preview (opens in a new window)" href="...?preview_theme_id=ID">.
  // Read the href instead of opening the new tab.
  const link = row.locator('a[aria-label^="Preview"]').first();
  const href = await link.getAttribute('href', { timeout: 8000 }).catch(() => null);
  if (!href) throw new Error(`Could not open preview for "${themeName}" — Preview link not found.`);

  const id = new URL(href).searchParams.get('preview_theme_id');
  if (!id) throw new Error(`Preview link for "${themeName}" has no preview_theme_id (${href}).`);
  if (themeId && id !== String(themeId)) {
    throw new Error(`Preview link for "${themeName}" is for theme ${id}, expected ${themeId}.`);
  }

  await page.keyboard.press('Escape').catch(() => {}); // close the popover
  log(`  preview link found (theme id ${id})`);
  return { themeId: id, previewUrl: href };
}

/**
 * Log what the confirmation dialog actually contains, across every frame, so a
 * missed button can be diagnosed from the run log instead of guessing.
 */
async function dumpDialog(page) {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const describe = (d) => ({
          tag: d.tagName.toLowerCase(),
          text: (d.innerText || '').trim().slice(0, 200),
          buttons: [...d.querySelectorAll('button, [role="button"], input[type="submit"]')].map(
            (b) =>
              `${(b.innerText || b.value || b.getAttribute('aria-label') || '').trim()}` +
              `${b.disabled ? ' [disabled]' : ''}`,
          ),
          inputs: [...d.querySelectorAll('input, textarea')].map((i) => i.type || i.tagName.toLowerCase()),
        });

        const modals = [
          ...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], ui-modal'),
        ].map(describe);

        // The modal often lives in its own frame with no container of its own,
        // so also describe the whole document when it has delete-ish controls.
        if (!modals.length && /delete/i.test(document.body?.innerText || '')) {
          modals.push({ ...describe(document.body), tag: 'body (no modal container)' });
        }
        return modals;
      })
      .catch(() => []);
    for (const d of found) log(`  [dialog @ ${frame.url()}] ${JSON.stringify(d)}`);
  }
}

const MODAL = '[role="dialog"], dialog[open], [aria-modal="true"], .Polaris-Modal-Dialog, ui-modal';

// Copy Shopify puts in the delete confirmation. Used to tell the modal's own
// frame apart from the theme list, which also has "Delete" controls in it.
const CONFIRM_COPY = /can'?t be undone|cannot be undone|are you sure|permanently|delete .*theme|theme .*deleted/i;

/**
 * Handle the "Delete theme?" confirmation modal.
 *
 * Shopify renders this modal in its OWN iframe: the dialog chrome stays in the
 * parent document while the body and its buttons live in a child frame that
 * has no role="dialog" wrapper of its own. So a modal-container-scoped lookup
 * finds nothing there. Instead, walk every frame and accept either
 *   (a) a real modal container, or
 *   (b) a frame whose body reads like the confirmation copy,
 * then click the delete button within it.
 *
 * `listFrame` is the frame holding the theme library; it is skipped for (b)
 * so a row's own "Delete" control can never be mistaken for the confirmation.
 */
async function confirmDelete(page, themeName, listFrame, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      // (a) a modal container in this frame, or (b) the frame body itself
      let root = frame.locator(MODAL).last();
      if (!(await root.isVisible().catch(() => false))) {
        if (frame === listFrame) continue;
        const text = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
        if (!CONFIRM_COPY.test(text)) continue;
        root = frame.locator('body');
      }

      // Some versions disable the confirm button until the name is retyped.
      const input = root.locator('input[type="text"], input:not([type]), textarea').first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(normalise(themeName)).catch(() => {});
      }

      // "Delete" / "Delete theme" both match; exclude Cancel and friends.
      const button = root
        .locator('button, [role="button"], input[type="submit"]')
        .filter({ hasText: /delete/i })
        .last();

      if (!(await button.isVisible().catch(() => false))) continue;

      if (await button.isDisabled().catch(() => false)) {
        log('  ! confirm button is disabled — the modal wants something else filled in');
        return false;
      }

      log(`  confirming delete in frame: ${frame.url()}`);
      await button.click({ timeout: 5000 }).catch(() => {});

      // The modal going away is the signal that the click registered. When the
      // modal lives in its own frame, that frame is detached instead.
      const gone = await Promise.race([
        root.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false),
        waitForDetached(frame, 8000),
      ]);
      if (gone) return true;
    }
    await sleep(400);
  }

  return false;
}

/** Resolve true once the frame is detached from the page, else false on timeout. */
async function waitForDetached(frame, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (frame.isDetached()) return true;
    await sleep(250);
  }
  return false;
}

/**
 * True when this theme's row carries the published-theme badge. Shopify does
 * not offer Delete on the live theme, but we refuse before opening the menu
 * rather than relying on that.
 */
async function isLiveTheme(row) {
  return row
    .locator('text=/\\b(live|current theme)\\b/i')
    .first()
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true, () => false);
}

/**
 * Delete the theme from the admin's theme library. Called at the end of a run
 * so the store does not accumulate every theme the pipeline installs.
 *
 * Refuses to act unless it can pin down this theme's own row, and never
 * touches the published theme. Returns true only if the theme is gone from the
 * library afterwards.
 */
export async function deleteTheme(page, { themeId, themeName }) {
  const scope = await themesScope(page);
  const label = themeName || themeId;

  const row = await themeRow(scope, { themeId, themeName, strict: true });
  if (!row) {
    log(`  ! refusing to delete "${label}" — could not identify its row in the library`);
    return false;
  }

  if (await isLiveTheme(row)) {
    log(`  ! refusing to delete "${label}" — it is the live theme`);
    return false;
  }

  const opened = await clickFirst(row, MENU_BUTTON, { timeout: 6000, label: '⋯ menu (delete)' });
  if (!opened) return false;

  // <button aria-label="Delete"> inside this card's popover. The preview step
  // may have left this menu open, in which case the click above closed it, so
  // reopen it once and retry.
  const DELETE_BUTTON = ['button[aria-label="Delete"]', { role: 'button', name: /^\s*delete\s*$/i }];
  let chose = await clickFirst(row, DELETE_BUTTON, { timeout: 3000, label: 'Delete' }).catch(() => false);
  if (!chose) {
    await clickFirst(row, MENU_BUTTON, { timeout: 6000, label: '⋯ menu (retry)' }).catch(() => false);
    chose = await clickFirst(
      row,
      DELETE_BUTTON,
      { timeout: 6000, label: 'Delete' },
    );
  }
  if (!chose) {
    const items = await row
      .locator('button, [role="menuitem"], a')
      .evaluateAll((els) =>
        els.map((e) => `${(e.innerText || e.getAttribute('aria-label') || '').trim()}`.slice(0, 40)).filter(Boolean),
      )
      .catch(() => []);
    log(`  row controls after opening menu: ${JSON.stringify(items)}`);
    await dumpDialog(page);
    return false;
  }

  const confirmed = await confirmDelete(page, themeName, scope === page ? null : scope);
  if (!confirmed) {
    await dumpDialog(page);
    return false;
  }

  await settle(page, 2000);

  // Verify: the theme's links should no longer be in the library.
  if (themeId) {
    const stillThere = await scope
      .locator(`a[href*="/themes/${themeId}"]`)
      .first()
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
    if (stillThere) {
      log(`  ! delete did not take effect for "${label}"`);
      return false;
    }
  }

  log(`  deleted theme ${label}`);
  return true;
}

/**
 * Publish the theme (makes it live on the store). NOT called by default —
 * run.js only does this when you pass `--publish-theme`, because it changes
 * what real visitors see.
 */
export async function publishTheme(page, { themeId, themeName }) {
  const scope = await themesScope(page);
  const opened = await clickFirst(
    await themeRow(scope, { themeId, themeName }),
    [{ role: 'button', name: /more actions|actions/i }, 'button[aria-haspopup="menu"]'],
    { timeout: 6000, label: '⋯ menu (publish)' },
  );
  if (!opened) return false;

  await clickFirst(scope, [{ role: 'menuitem', name: /^publish$/i }, 'text="Publish"'], {
    timeout: 6000,
    label: 'Publish',
  });
  const confirm = await firstVisible(scope, [{ role: 'button', name: /^publish$/i }], { timeout: 6000 });
  if (confirm) await confirm.click().catch(() => {});
  await settle(page, 3000);
  log(`  published theme ${themeName}`);
  return true;
}
