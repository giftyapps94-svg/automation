/** Storefront side: fill the cart in preview mode, open the drawer, run the algorithm. */
import { config } from './config.js';
import { selectorAlgorithm } from './selector-algorithm.js';
import { clickFirst, log, settle, sleep, withPreview } from './util.js';

/**
 * Name-based guesses for the drawer root, tried ONLY when the structural pass
 * below finds nothing. Class and id names are cosmetic and differ per theme,
 * so these can never be the primary signal.
 */
const DRAWER_ROOT_HINTS = [
  'cart-drawer',
  'cart-notification',
  '#CartDrawer',
  '#cart-drawer',
  '[id*="CartDrawer"]',
  '[class*="cart-drawer"]',
  '[class*="drawer"][class*="cart"]',
  '[class*="mini-cart"]',
  '[id*="mini-cart"]',
  '#cart-notification',
  '[data-cart-drawer]',
  'aside[class*="cart"]',
];

/** Open a storefront page pinned to the previewed theme. */
export async function openPreviewPage(context, themeId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hitting the preview URL first sets the preview cookie for the session.
  await page.goto(withPreview(`${config.storeUrl}/`, themeId), { waitUntil: 'domcontentloaded' });
  await settle(page);
  await dismissPopups(page);
  return page;
}

/** Close the newsletter / cookie / preview-bar overlays that block clicks. */
export async function dismissPopups(page) {
  await clickFirst(
    page,
    [
      { role: 'button', name: /^(close|dismiss|no thanks|accept|got it)/i },
      'button[aria-label*="close" i]',
      '[class*="modal"] button[class*="close"]',
      '#shopify-pc__banner__btn-accept',
    ],
    { timeout: 2500 },
  ).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Add one product to the cart. Tries the real add-to-cart button first, then
 * falls back to the Ajax cart API so a stubborn theme can't stall the run.
 */
export async function addProductToCart(page, productPath, themeId) {
  const url = withPreview(`${config.storeUrl}${productPath}`, themeId);
  const handle = productHandle(productPath);

  // The browser profile is persistent, so the cart survives between runs.
  // Re-adding would stack duplicate lines and skew the item counts the
  // selector algorithm checks against.
  if (await cartHasProduct(page, handle)) {
    log(`  already in cart, skipping: ${productPath}`);
    return true;
  }

  log(`  add to cart: ${productPath}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await dismissPopups(page);

  const clicked = await clickFirst(
    page,
    [
      'form[action*="/cart/add"] button[type="submit"]:not([disabled])',
      'form[action*="/cart/add"] [name="add"]:not([disabled])',
      { role: 'button', name: /^add to cart$/i },
      { role: 'button', name: /add to (cart|bag)/i },
      'button[name="add"]',
    ],
    { timeout: 10000, label: 'Add to cart' },
  );

  if (clicked) {
    await sleep(2500);
    // Check for THIS product, not just a non-empty cart — otherwise a leftover
    // line from an earlier product reports success for one that never landed.
    if (await cartHasProduct(page, handle)) return true;
  }

  log('    falling back to /cart/add.js');
  const ok = await page.evaluate(async () => {
    const input = document.querySelector('form[action*="/cart/add"] [name="id"]');
    const id = input?.value;
    if (!id) return false;
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(id), quantity: 1 }] }),
    });
    return res.ok;
  });
  if (!ok) log(`    ! could not add ${productPath}`);
  return ok;
}

/**
 * Empty the store cart via the Ajax API. Called once per theme, before adding
 * products, so a fresh add-to-cart click always actually fires: without this
 * the persistent browser profile keeps last theme's items around, `cartHasProduct`
 * short-circuits the add for every later theme, and the drawer never gets the
 * "just added" event some themes rely on to auto-open it.
 */
export async function clearCart(page) {
  await page
    .evaluate(async () => {
      await fetch('/cart/clear.js', { method: 'POST', headers: { Accept: 'application/json' } });
    })
    .catch(() => {});
}

/** '/products/the-complete-snowboard?variant=1' -> 'the-complete-snowboard' */
function productHandle(productPath) {
  return String(productPath).split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
}

/**
 * True when the given product handle already has a line in the cart. Reads
 * /cart.js rather than the DOM, so it works from any storefront page and does
 * not depend on the theme rendering a cart count.
 */
async function cartHasProduct(page, handle) {
  if (!handle) return false;
  return page
    .evaluate(async (wanted) => {
      const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!res.ok) return false;
      const cart = await res.json();
      return (cart.items || []).some(
        (i) => i.handle === wanted || String(i.url || '').includes(`/products/${wanted}`),
      );
    }, handle)
    .catch(() => false);
}

/**
 * Everything this file knows about cart drawers, as one function that is
 * serialized with Function.prototype.toString and rebuilt inside the page (the
 * same trick runSelectorAlgorithm uses). Keeping it in one place means the
 * "find the open drawer" pass and the "find the button that opens it" pass
 * share a single definition of what a cart drawer is.
 *
 * @returns {{visibleRoot: () => (string|null), triggers: () => object[]}}
 */
function drawerProbe(hints) {
  const MONEY = /(?:[$€£¥₹₩₽₺]|\b(?:USD|EUR|GBP|INR|CAD|AUD|Rs)\b\.?)\s?\d|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}\b/i;
  // Only ever a tie-breaker: it is language-specific, so a theme in a locale we
  // did not list must still be found by the structural signals above it.
  const CART_WORDS =
    /cart|bag|basket|panier|carrito|cesta|warenkorb|carrello|winkelwagen|koszyk|корзин|カート|购物车|장바구니|سلة/i;
  const CHECKOUT_SEL = '[name="checkout"], a[href*="/checkout"], form[action$="/cart"] [type="submit"]';

  const q = (sel, root = document) => {
    try {
      return [...root.querySelectorAll(sel)];
    } catch {
      return [];
    }
  };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));
  const attr = (el, ...names) => names.map((n) => el.getAttribute(n) || '').join(' ');

  // Landmarks a drawer root never contains. Reaching one means the walk went
  // too far up and is about to select the whole page.
  const PAGE_LEVEL =
    'main, [role="main"], #MainContent, [role="banner"], [role="contentinfo"], nav, [role="navigation"]';

  /** Painted, on screen, and large enough to be a panel rather than a badge. */
  const isPanel = (el, min = 120) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > min &&
      r.height > min &&
      r.right > 0 &&
      r.left < innerWidth &&
      r.bottom > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0.1
    );
  };

  /** Holds at least one cart line: a product link and a price. */
  const hasCartLines = (el) =>
    q('a[href*="/products/"]', el).length > 0 &&
    q('*', el).some((n) => !n.children.length && MONEY.test((n.textContent || '').trim()));

  /**
   * Holds a way to check out. This is what separates a drawer from a product
   * page's add-to-cart block, which also has a product link and a price.
   */
  const hasCheckout = (el) => q(CHECKOUT_SEL, el).length > 0;

  /** Shortest chain of id / tag / nth-of-type segments that matches only `el`. */
  const uniqueSelector = (el) => {
    const seg = (e) => {
      if (e.id && q(`#${esc(e.id)}`).length === 1) return `#${esc(e.id)}`;
      const tag = e.tagName.toLowerCase();
      const sibs = e.parentElement
        ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName)
        : [];
      return sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(e) + 1})` : tag;
    };
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = seg(e);
      parts.unshift(s);
      const chain = parts.join(' > ');
      if (q(chain).length === 1 && q(chain)[0] === el) return chain;
      if (s.startsWith('#')) break;
    }
    return parts.join(' > ');
  };

  /**
   * Outermost cart-bearing container above `seed`, or null. `visible` adds the
   * on-screen panel test: a drawer that has not been opened yet is usually
   * display:none or 0x0, so the latent pass must not ask for geometry.
   */
  const rootAbove = (seed, visible) => {
    let best = null;
    for (let el = seed.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.matches(PAGE_LEVEL) || el.querySelector(PAGE_LEVEL)) break;
      if ((!visible || isPanel(el)) && hasCartLines(el) && hasCheckout(el)) best = el; // outermost wins
    }
    return best;
  };

  /**
   * The open drawer, as a unique CSS selector.
   *
   * Deliberately theme-agnostic, on the same basis as selector-algorithm.js: it
   * never looks for theme class names, only for facts that hold for every
   * Shopify cart drawer —
   *   1. it contains a checkout control ([name=checkout] / a link to /checkout)
   *   2. it contains cart lines: a[href*="/products/"] plus money-formatted text
   *   3. it is an on-screen panel, i.e. a container that is NOT a page landmark
   *      (main / header / nav / footer) and is not <body> itself
   * The root is the OUTERMOST ancestor of a checkout control that still
   * satisfies those, so the selector wraps the whole drawer rather than one of
   * its inner columns. The name hints are consulted only if that finds nothing.
   */
  const visibleRoot = () => {
    // A drawer that announces itself as a dialog is the strongest signal.
    for (const dialog of q('[role="dialog"], [aria-modal="true"], dialog[open]')) {
      if (isPanel(dialog) && hasCartLines(dialog) && hasCheckout(dialog)) return uniqueSelector(dialog);
    }

    // Otherwise climb from a visible checkout control. `/cart/add` forms are
    // excluded on purpose: on a product page that form's wrapper also has a
    // product link and a price, and would masquerade as a drawer.
    for (const seed of q(CHECKOUT_SEL).filter((el) => isPanel(el, 16))) {
      const root = rootAbove(seed, true);
      if (root) return uniqueSelector(root);
    }

    // Last resort: theme name guesses.
    for (const sel of hints) {
      const el = q(sel)[0];
      if (el && isPanel(el)) return sel;
    }
    return null;
  };

  /** Drawer roots in the DOM whether or not they are currently on screen. */
  const latentRoots = () => {
    const out = new Set();
    for (const el of q('[role="dialog"], [aria-modal="true"], dialog')) {
      if (hasCartLines(el) && hasCheckout(el)) out.add(el);
    }
    for (const seed of q(CHECKOUT_SEL)) {
      const root = rootAbove(seed, false);
      if (root) out.add(root);
    }
    return [...out];
  };

  /** Big enough to click, painted, and accepting pointer events. */
  const isClickable = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 8 &&
      r.height > 8 &&
      r.top < innerHeight &&
      r.bottom > 0 &&
      r.left < innerWidth &&
      r.right > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0.1 &&
      cs.pointerEvents !== 'none' &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.disabled
    );
  };

  /**
   * Rank the controls that plausibly open the cart drawer, best first.
   *
   * There is no markup a theme is obliged to use for this button, so instead of
   * guessing at names we score each visible control against evidence that does
   * not depend on the theme's vocabulary, strongest first:
   *
   *   +6  it points at a drawer we already found in the DOM — aria-controls /
   *       aria-owns / data-target / href="#id" naming that element or one of its
   *       wrappers. This is the only signal that ties a control to *this*
   *       drawer, so it outranks everything else.
   *   +3  it lives in the page header, where every theme puts the cart entry.
   *   +3  it is a link to /cart. Themes render the drawer button as the cart
   *       link and intercept the click; when JS does not bind, the same link
   *       still gets us to the cart page.
   *   +2  it has aria-expanded / a hidden checkbox / <summary>, i.e. it is a
   *       disclosure control rather than a plain link.
   *   +2  its accessible name mentions a cart (localized list, hence low).
   *   +2  it wraps an icon plus a short numeric badge — the item-count bubble.
   *   +1  it sits in the top corner strip where header cart icons live.
   *   -3  it is inside <main> or the footer, where the real header control is
   *       not, but sticky bars and duplicate mobile markup are.
   *
   * Anything inside a drawer we already located is dropped: the drawer's own
   * close and checkout buttons would otherwise score well. The ranking is only
   * a proposal — openCartDrawer confirms a candidate by clicking it and looking
   * for the drawer, so a wrong guess costs one click, not a wrong answer.
   */
  const triggers = () => {
    const roots = latentRoots();
    // Ids that a control may legitimately reference to mean "the cart drawer":
    // the root, its wrappers, and its immediate children.
    const drawerIds = new Set();
    for (const root of roots) {
      for (let e = root; e && e !== document.body; e = e.parentElement) if (e.id) drawerIds.add(e.id);
      for (const child of root.children) if (child.id) drawerIds.add(child.id);
    }

    const inside = (el, list) => list.some((r) => r.contains(el));
    const labelledText = (el) => {
      const id = el.getAttribute('aria-labelledby');
      return id ? document.getElementById(id)?.textContent || '' : '';
    };

    const scored = [];
    for (const el of q('a[href], button, summary, [role="button"], [onclick], label[for]')) {
      if (!isClickable(el) || inside(el, roots)) continue;

      const href = el.getAttribute('href') || '';
      const path = href.split('?')[0].split('#')[0];
      // A checkout link and an add-to-cart submit are cart-adjacent but never
      // the drawer toggle, and clicking them would leave the page or the state.
      if (/\/checkout|\/products\//.test(path) || el.closest('form[action*="/cart/add"]')) continue;

      const why = [];
      let score = 0;

      const refs = `${attr(el, 'aria-controls', 'aria-owns', 'data-target', 'for')} ${
        href.startsWith('#') ? href.slice(1) : ''
      }`
        .split(/\s+/)
        .filter(Boolean);
      if (refs.some((id) => drawerIds.has(id))) {
        score += 6;
        why.push('references drawer');
      }

      if (el.closest('header, [role="banner"]')) {
        score += 3;
        why.push('in header');
      }
      if (/\/cart\/?$/.test(path)) {
        score += 3;
        why.push('links to /cart');
      }
      if (el.hasAttribute('aria-expanded') || el.tagName === 'SUMMARY' || el.tagName === 'LABEL') {
        score += 2;
        why.push('disclosure control');
      }
      const name = `${attr(el, 'aria-label', 'title', 'alt')} ${labelledText(el)} ${el.textContent || ''}`;
      const iconHint = q('svg, use, img, symbol', el).some((n) =>
        CART_WORDS.test(attr(n, 'href', 'xlink:href', 'src', 'alt', 'data-name')),
      );
      if (CART_WORDS.test(name) || iconHint) {
        score += 2;
        why.push('cart in name');
      }
      const badge =
        q('svg, img', el).length > 0 &&
        q('*', el).some((n) => !n.children.length && /^\(?\d{1,3}\)?$/.test((n.textContent || '').trim()));
      if (badge) {
        score += 2;
        why.push('icon + count badge');
      }
      const r = el.getBoundingClientRect();
      if (r.top < 250 && (r.left + r.width / 2 > innerWidth * 0.6 || r.right > innerWidth - 24)) {
        score += 1;
        why.push('header corner');
      }
      if (el.closest('main, [role="main"], footer, [role="contentinfo"]')) {
        score -= 3;
        why.push('outside header');
      }

      if (score > 0) scored.push({ el, score, why: why.join(', ') });
    }

    // `<div role=button>` wrappers around a real `<button>` produce two entries
    // for one control; keep the inner, more precise click target.
    const kept = scored.filter(
      (c) => !scored.some((o) => o !== c && c.el.contains(o.el) && o.score >= c.score),
    );
    kept.sort((a, b) => b.score - a.score);
    return kept
      .slice(0, 8)
      .map((c) => ({ selector: uniqueSelector(c.el), score: c.score, why: c.why }));
  };

  return { visibleRoot, triggers };
}

/** Rebuild drawerProbe inside the page and run one of its passes. */
function runProbe(page, op) {
  return page.evaluate(
    ({ source, hints, op: name }) => {
      const probe = new Function(`return (${source})`)()(hints);
      return probe[name]();
    },
    { source: drawerProbe.toString(), hints: DRAWER_ROOT_HINTS, op },
  );
}

/** Selector of the currently open cart drawer, or null. */
async function visibleDrawerRoot(page) {
  return runProbe(page, 'visibleRoot');
}

/** Ranked guesses at the control that opens the drawer. @see drawerProbe */
export async function cartTriggerCandidates(page) {
  return runProbe(page, 'triggers');
}

/**
 * Open the cart drawer and return the CSS selector of its root, or null.
 *
 * The button is confirmed by its effect, not by its markup: candidates are
 * clicked best-first and a candidate only wins if the drawer is on screen
 * afterwards. A candidate that navigates instead (the plain /cart link on a
 * theme with no drawer at all, or with JS not yet bound) is undone by going
 * back, so the next candidate starts from the same page.
 */
export async function openCartDrawer(page) {
  // Some themes pop the drawer automatically on add; check before clicking.
  let root = await visibleDrawerRoot(page);
  if (root) {
    log(`  drawer already open: ${root}`);
    return root;
  }

  const candidates = await cartTriggerCandidates(page);
  if (!candidates.length) log('  ! no cart trigger candidates on this page');
  const startUrl = page.url();

  for (const { selector, score, why } of candidates) {
    log(`  try trigger [${score}] ${selector} (${why})`);
    const clicked = await clickSelector(page, selector);
    if (!clicked) continue;
    await sleep(2000);

    root = await visibleDrawerRoot(page);
    if (root) {
      log(`  cart trigger: ${selector}`);
      log(`  drawer root: ${root}`);
      return root;
    }

    if (page.url() !== startUrl) {
      // It was a navigation, not a drawer. Restore the page for the next try.
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await dismissPopups(page);
    } else {
      // It opened something else (search, menu); close it so it does not cover
      // the next candidate.
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
  }

  log('  ! no cart drawer detected for this theme');
  return null;
}

/** Click one CSS selector, falling back to a forced click through overlays. */
async function clickSelector(page, selector) {
  const el = page.locator(selector).first();
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await el.click({ timeout: 4000 });
    return true;
  } catch {
    try {
      await el.click({ timeout: 2000, force: true });
      return true;
    } catch {
      log(`    ! could not click ${selector}`);
      return false;
    }
  }
}

/** Navigate to the full cart page in preview mode. */
export async function openCartPage(page, themeId) {
  await page.goto(withPreview(`${config.storeUrl}/cart`, themeId), { waitUntil: 'domcontentloaded' });
  await settle(page);
  await dismissPopups(page);
}

/**
 * The cart's real line items, straight from /cart.js. This is the algorithm's
 * ground truth: the DOM cannot tell a cart line apart from a "you may also
 * like" card (both are a product link next to a price), but the API knows
 * exactly how many lines exist, which products they are, and — critically —
 * their price in cents regardless of the store's currency or locale
 * formatting, which the selector algorithm uses instead of guessing at
 * currency symbols.
 *
 * One entry per LINE, so `lines.length` is the row count — not `item_count`,
 * which sums quantities.
 *
 * @returns {Promise<{
 *   lines: Array<{handle: string, title: string, key: string, quantity: number, finalPrice: number|null}>,
 *   totalPrice: number|null,
 * }>}
 */
async function cartLines(page) {
  const cart = await page
    .evaluate(async () => {
      const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const cart = await res.json();
      return {
        totalPrice: Number.isFinite(cart.total_price) ? cart.total_price : null,
        lines: (cart.items || []).map((i) => ({
          handle: i.handle || String(i.url || '').split('/products/')[1]?.split(/[?#]/)[0] || '',
          title: i.product_title || i.title || '',
          key: i.key || '',
          quantity: i.quantity || 1,
          // Cents, in the shop's currency — themes render this in whatever
          // symbol/locale format they like, but the digits stay the same, so
          // the algorithm can match on them without knowing the currency.
          finalPrice: Number.isFinite(i.final_price) ? i.final_price : null,
        })),
      };
    })
    .catch(() => null);
  if (!cart?.lines?.length) log('  [cart] /cart.js returned no lines - falling back to DOM-only detection.');
  return cart || { lines: [], totalPrice: null };
}

/**
 * Execute the selector algorithm inside the page.
 * @returns {Promise<{orderLevelGift: string|null, productLevelGift: string|null, debug?: object}>}
 */
export async function runSelectorAlgorithm(page, { context, rootSelector = null }) {
  const cart = await cartLines(page);
  const result = await page.evaluate(
    ({ source, input }) => {
      // Rebuild the function inside the page so it can use document/window.
      const fn = new Function(`return (${source})`)();
      return fn(input);
    },
    { source: selectorAlgorithm.toString(), input: { context, rootSelector, cart } },
  );
  log(
    `  [${context}] orderLevelGift=${result?.orderLevelGift || 'null'} ` +
      `productLevelGift=${result?.productLevelGift || 'null'}`,
  );
  return result || { orderLevelGift: null, productLevelGift: null };
}

export { DRAWER_ROOT_HINTS };
