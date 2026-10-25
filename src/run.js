#!/usr/bin/env node
/**
 * Main pipeline.
 *
 *   npm run start -- --limit 5
 *   npm run start -- --source store --limit 10     # browse theme store, newest first
 *   npm run start -- --only abode                  # filter the JSON list by handle/name
 *   npm run start -- --skip-install                # theme already installed, go straight to preview
 *   npm run start -- --publish-theme               # also publish each theme (changes the live store)
 *   npm run start -- --keep-theme                  # do NOT delete the theme afterwards
 *
 * Per theme:
 *   install -> find in admin -> preview -> add 2 products -> run selector
 *   algorithm on cart page + cart drawer -> inject markers -> snapshot ->
 *   append record to theme-selectors.json -> (hook) publish to Google Docs ->
 *   delete the installed theme from the admin.
 *
 * The delete step runs even when the capture fails, so the store does not fill
 * up with test themes. It is skipped for --skip-install (we did not install it),
 * --publish-theme (it is now live) and --keep-theme, and never touches the
 * published theme.
 */
import { existsSync } from 'node:fs';
import { config, parseArgs } from './config.js';
import { launchContext, saveAuthState } from './browser.js';
import { log, settle, sleep, withPreview } from './util.js';
import { loadThemesFromFile, loadThemesFromStore, installTheme } from './themeStore.js';
import {
  openThemesPage,
  previewTheme,
  publishTheme,
  deleteTheme,
  waitForThemeInLibrary,
} from './adminThemes.js';
import {
  openPreviewPage,
  addProductToCart,
  clearCart,
  openCartDrawer,
  openCartPage,
  dismissPopups,
  runSelectorAlgorithm,
} from './cart.js';
import { apiConfigured, deleteThemeViaCli, getThemeRole } from './adminApi.js';
import { injectMarkers } from './injector.js';
import { captureSnapshot, publishToGoogleDocs } from './snapshots.js';
import { appendRecord, existingThemeUrls, findPreselected } from './store.js';

const args = parseArgs();
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function main() {
  if (!existsSync(config.userDataDir) && !existsSync(config.authState)) {
    throw new Error(`No saved session at ${config.userDataDir}. Run \`npm run login\` first.`);
  }

  // Same persistent profile as `npm run login`, so the session carries over.
  const context = await launchContext({
    headless: !config.headed,
    slowMo: config.headed ? 60 : 0,
  });

  try {
    const themes = await selectThemes(context);
    log(`Processing ${themes.length} theme(s).`);

    for (const [i, theme] of themes.entries()) {
      log(`\n=== [${i + 1}/${themes.length}] ${theme.name} ===`);
      try {
        await processTheme(context, theme);
      } catch (err) {
        log(`  !! failed: ${err.message}`);
      }
    }
  } finally {
    // Write back the cookies Shopify rotated during the run; without this the
    // saved session goes stale and the next run asks for credentials again.
    await saveAuthState(context).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function selectThemes(context) {
  const limit = Number(args.limit || 0);
  let themes =
    args.source === 'store'
      ? await loadThemesFromStore(context, { limit: limit || 10 })
      : await loadThemesFromFile();

  if (args.only) {
    const needle = String(args.only).toLowerCase();
    themes = themes.filter(
      (t) => t.handle?.includes(needle) || t.name?.toLowerCase().includes(needle),
    );
  }

  console.log(args)
  if (!args.redo) {
    const done = await existingThemeUrls();
    const before = themes.length;
    themes = themes.filter((t) => !done.has(t.url));
    if (before !== themes.length) log(`Skipping ${before - themes.length} theme(s) already captured.`);
  }

  return limit ? themes.slice(0, limit) : themes;
}

/**
 * Delete via the Shopify CLI (Theme Access password), then the admin UI. The CLI
 * only sees live/unpublished themes, so trial themes fall through to the UI. The
 * Admin API's themeDelete is not used: it needs a Shopify exemption.
 */
async function removeTheme(adminPage, { themeId, themeName }) {
  // Trial themes (role DEMO) are invisible to the CLI, so go straight to the UI.
  const isTrial = apiConfigured() && themeId && (await getThemeRole(themeId)) === 'DEMO';
  if (isTrial) log(`  "${themeName}" is a trial theme — the CLI cannot delete it, using the admin UI`);
  else if (config.themeAccessPassword && themeId && (await deleteThemeViaCli({ themeId, themeName }))) {
    return true;
  }
  return deleteTheme(adminPage, { themeId, themeName });
}

async function processTheme(context, theme) {
  // Why we must not delete the theme afterwards (null = delete it). Skipped when
  // we did not install it (--skip-install), when we just published it, or on
  // --keep-theme.
  const skipReason = args['keep-theme']
    ? '--keep-theme'
    : args['skip-install']
      ? '--skip-install (theme was not installed by this run)'
      : args['publish-theme']
        ? '--publish-theme (theme is now live)'
        : null;

  // --- 1. install ---------------------------------------------------------
  let meta = { name: theme.name, price: 'unknown', priceLabel: null, installed: false };
  if (!args['skip-install']) {
    meta = await installTheme(context, theme);
  }

  // --- 2. locate in admin + open preview ----------------------------------
  const adminPage = await openThemesPage(context);
  // Retry rather than one-shot: on --skip-install runs, and whenever the admin
  // list is still catching up, the row can take a few seconds to appear.
  const { themeId: foundId } = await waitForThemeInLibrary(adminPage, meta.name || theme.name);
  let preview;
  try {
    preview = await previewTheme(context, adminPage, {
      themeName: meta.name || theme.name,
      themeId: foundId,
    });
  } catch (err) {
    // Preview failed: remove the theme we just installed so it does not linger.
    if (!skipReason) {
      await removeTheme(adminPage, {
        themeId: foundId,
        themeName: meta.name || theme.name,
      }).catch((e) => log(`  ! delete failed: ${e.message}`));
    }
    await adminPage.close().catch(() => {});
    throw err;
  }
  const { themeId, previewUrl } = preview;

  if (args['publish-theme']) {
    await publishTheme(adminPage, { themeId, themeName: meta.name || theme.name });
  }

  try {
    await captureTheme(context, theme, meta, { themeId, previewUrl });
  } finally {
    // --- 7. clean up: remove the theme we installed ------------------------
    // Runs even when the capture failed, so a broken theme does not stay in
    // the library. Skipped when we did not install it (--skip-install), when
    // we just published it, or on --keep-theme.
    if (skipReason) {
      log(`  keeping theme — ${skipReason}`);
    } else {
      await removeTheme(adminPage, {
        themeId,
        themeName: meta.name || theme.name,
      }).catch((err) => log(`  ! delete failed: ${err.message}`));
    }
    await adminPage.close().catch(() => {});
  }
}

async function captureTheme(context, theme, meta, { themeId, previewUrl }) {
  // --- 3. fill the cart in preview mode -----------------------------------
  const page = await openPreviewPage(context, themeId);
  let drawer;
  let drawerShot;
  let cart;
  let cartShot;
  let drawerMobileShot = null;
  let cartMobileShot = null;
  let drawerRoot;
  // Known selectors from preselected.json: skip the algorithm for this theme.
  const preselected = await findPreselected(theme);
  if (preselected) log('  using preselected selectors (selector algorithm skipped)');
  // Whether the gift properties landed on the first product's cart line.
  let giftPropertiesAdded = false;
  try {
    // Reset the shared store cart before adding anything: the browser profile
    // is persistent, so without this, items left over from an earlier theme
    // make `addProductToCart` think this theme's products are already there
    // and skip the click entirely — losing the add-to-cart event some themes
    // rely on to auto-open the drawer, and stacking quantities run over run.
    await clearCart(page);
    // Gift properties go on the first product only.
    for (const [i, productPath] of config.productPaths.entries()) {
      const res = await addProductToCart(page, productPath, themeId, { withGift: i === 0 });
      if (i === 0) giftPropertiesAdded = Boolean(res.giftPropertiesAdded);
    }

    // --- 4. cart drawer: algorithm -> inject -> snapshot ------------------
    drawerRoot = await openCartDrawer(page);
    drawer = preselected
      ? {
          orderLevelGift: preselected.orderLevelGift.cartDrawerSelector,
          productLevelGift: preselected.productLevelGift.cartDrawerSelector,
        }
      : await runSelectorAlgorithm(page, { context: 'drawer', rootSelector: drawerRoot });
    await injectMarkers(page, [
      { key: 'orderLevelGift', selector: drawer.orderLevelGift },
      { key: 'productLevelGift', selector: drawer.productLevelGift },
    ]);
    drawerShot = await captureSnapshot(page, {
      themeName: theme.name,
      themeId,
      label: 'cart-drawer-desktop',
      rootSelector: drawerRoot,
    });

    // --- 5. cart page: algorithm -> inject -> snapshot --------------------
    await openCartPage(page, themeId);
    cart = preselected
      ? {
          orderLevelGift: preselected.orderLevelGift.cartSelector,
          productLevelGift: preselected.productLevelGift.cartSelector,
        }
      : await runSelectorAlgorithm(page, { context: 'cart', rootSelector: null });
    await injectMarkers(page, [
      { key: 'orderLevelGift', selector: cart.orderLevelGift },
      { key: 'productLevelGift', selector: cart.productLevelGift },
    ]);
    cartShot = await captureSnapshot(page, {
      themeName: theme.name,
      themeId,
      label: 'cart-page-desktop',
    });

    // --- 5b. same two views at mobile width, reusing the desktop selectors --
    await page.setViewportSize(MOBILE_VIEWPORT);
    try {
      await page.goto(withPreview(`${config.storeUrl}/`, themeId), { waitUntil: 'domcontentloaded' });
      await settle(page);
      await dismissPopups(page);
      const mobileDrawerRoot = await openCartDrawer(page);
      await injectMarkers(page, [
        { key: 'orderLevelGift', selector: drawer.orderLevelGift },
        { key: 'productLevelGift', selector: drawer.productLevelGift },
      ]);
      drawerMobileShot = await captureSnapshot(page, {
        themeName: theme.name,
        themeId,
        label: 'cart-drawer-mobile',
        rootSelector: mobileDrawerRoot,
      });

      await openCartPage(page, themeId);
      await injectMarkers(page, [
        { key: 'orderLevelGift', selector: cart.orderLevelGift },
        { key: 'productLevelGift', selector: cart.productLevelGift },
      ]);
      cartMobileShot = await captureSnapshot(page, {
        themeName: theme.name,
        themeId,
        label: 'cart-page-mobile',
      });
    } catch (err) {
      log(`  ! mobile snapshots failed: ${err.message}`);
    }
  } finally {
    // Close the preview tab even on failure, so a long run does not
    // accumulate a tab per broken theme.
    await page.close().catch(() => {});
  }

  // --- 6. persist + publish ----------------------------------------------
  const record = {
    themeId: themeId ? Number(themeId) || themeId : null,
    themeName: meta.name || theme.name,
    price: meta.price,
    url: theme.url,
    previewUrl,
    selectors: {
      orderLevelGift: {
        cartSelector: cart.orderLevelGift || '',
        cartDrawerSelector: drawer.orderLevelGift || '',
      },
      productLevelGift: {
        cartSelector: cart.productLevelGift || '',
        cartDrawerSelector: drawer.productLevelGift || '',
      },
    },
    selectorSource: preselected ? 'preselected' : 'algorithm',
    giftPropertiesAdded,
    snapshots: {
      cartPage: cartShot,
      cartDrawer: drawerShot,
      cartPageMobile: cartMobileShot,
      cartDrawerMobile: drawerMobileShot,
    },
    capturedAt: new Date().toISOString(),
  };

  const docUrl = await publishToGoogleDocs(record);
  if (docUrl) record.googleDocUrl = docUrl;

  await appendRecord(record);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
