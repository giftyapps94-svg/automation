# Gifty theme automation

Playwright pipeline that walks every Shopify theme in `shopify_themes.json`,
installs it, previews it, works out where a gift block can be injected in the
cart and cart drawer, and records the selectors as JSON.

```
login (saved session)
  └─ install theme from themes.shopify.com  ("Try theme")
       └─ find it in admin → ⋯ → Preview      (gives preview_theme_id)
            └─ add both products to the cart
                 ├─ cart drawer: run algorithm → inject button → snapshot
                 └─ cart page:   run algorithm → inject button → snapshot
                      └─ append record to theme-selectors.json
                           └─ publishToGoogleDocs() hook
```

## Setup

```bash
npm install          # also installs the Chromium build
cp .env.example .env # set SHOPIFY_STORE at minimum
npm run login        # opens a browser; log in by hand, press Enter, session saved to auth.json
```

`auth.json` is the whole auth story — no credentials are typed by the script, so
2FA and CAPTCHA are handled by you once. Re-run `npm run login` when the session
expires (the run fails with a clear message when it has).

## Running

```bash
npm start                         # every theme in shopify_themes.json
npm start -- --limit 5            # first 5 not already captured
npm start -- --only dawn          # filter by handle or name
npm start -- --source store --limit 10   # browse the theme store sorted newest-first instead
npm start -- --skip-install       # theme already in the library; go straight to preview
npm start -- --redo               # don't skip themes already in the output file
npm start -- --publish-theme      # also publish each theme (changes the live storefront)
```

Themes already present in `theme-selectors.json` are skipped unless `--redo` is
passed, so a run can be interrupted and resumed. Publishing the theme is opt-in
because it changes what real visitors see.

## The selector algorithm

[src/selector-algorithm.js](src/selector-algorithm.js) holds a placeholder.
Replace the body between the `BEGIN`/`END` markers with your algorithm.

It is stringified and re-evaluated inside the storefront page, so it must be
self-contained — no imports, no closures over module scope.

```js
// input
{ context: 'cart' | 'drawer', rootSelector: string | null }

// output
{ orderLevelGift: 'CSS selector' | null,
  productLevelGift: 'CSS selector' | null,
  debug?: {} }
```

The harness runs it twice per theme — once on `/cart`, once with the drawer
open — and merges the two results. Returned selectors must work with
`document.querySelectorAll(sel)[0]`, which is exactly how
[src/injector.js](src/injector.js) anchors the "Theme injector" button.

## Output

Records are appended to `theme-selectors.json` (atomic write; re-running a theme
replaces its record rather than duplicating it):

```json
{
  "themeId": 123456789,
  "themeName": "Dawn",
  "price": "free",
  "url": "https://themes.shopify.com/themes/dawn/presets/dawn",
  "previewUrl": "https://your-store.myshopify.com/?preview_theme_id=123456789",
  "selectors": {
    "orderLevelGift":   { "cartSelector": "", "cartDrawerSelector": "" },
    "productLevelGift": { "cartSelector": "", "cartDrawerSelector": "" }
  },
  "snapshots": {
    "cartPage":   "/abs/path/snapshots/dawn/cart-page.png",
    "cartDrawer": "/abs/path/snapshots/dawn/cart-drawer.png"
  },
  "capturedAt": "2026-08-10T00:00:00.000Z"
}
```

Screenshots land in `snapshots/<theme>/`.

## Google Docs publishing

`publishToGoogleDocs()` in [src/snapshots.js](src/snapshots.js) is a documented
stub — it logs what it would publish and returns `null`. To finish it you need
`googleapis`, a service account with the Drive + Docs APIs enabled, and a shared
Drive folder: the Docs API can't read local files, so each PNG has to be
uploaded to Drive first and inserted by URL.

## Layout

| File | Role |
| --- | --- |
| [src/run.js](src/run.js) | Orchestrator — one function per pipeline stage |
| [src/login.js](src/login.js) | Interactive session capture |
| [src/themeStore.js](src/themeStore.js) | Theme list, price scrape, "Try theme" install |
| [src/adminThemes.js](src/adminThemes.js) | Find theme in the library, ⋯ → Preview, publish |
| [src/cart.js](src/cart.js) | Add to cart, open drawer, run the algorithm |
| [src/injector.js](src/injector.js) | Injects the "Theme injector" marker button |
| [src/snapshots.js](src/snapshots.js) | Screenshots + Google Docs hook |
| [src/store.js](src/store.js) | Append-only JSON output |
| [src/util.js](src/util.js) | Candidate-list locator helpers |

Theme markup varies enormously, so every interaction is a *candidate list* — a
ranked set of selectors/roles, first visible match wins — rather than one brittle
selector. Add candidates to those lists as you hit themes that don't cooperate.

## Known rough edges

- **Install flow.** `themes.shopify.com` occasionally A/B-tests the "Try theme"
  → store-picker dialog. `selectStoreIfPrompted()` covers the shapes seen so
  far; a new variant needs a candidate added there.
- **Drawer detection.** Themes with no drawer at all record empty
  `cartDrawerSelector` values and snapshot the page as-is — that is expected,
  not a failure.
- **Admin iframe.** `themesScope()` sniffs for the app iframe and falls back to
  the top-level page.
