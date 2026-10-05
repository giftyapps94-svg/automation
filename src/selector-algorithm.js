/**
 * ============================================================================
 *  THE SELECTOR ALGORITHM
 * ============================================================================
 *
 * `selectorAlgorithm` is serialised and executed INSIDE the storefront page via
 * page.evaluate(). That has two hard consequences:
 *
 *   1. It cannot close over anything in this module (no imports, no outer
 *      consts). Everything it needs must live inside the function body or
 *      arrive through the single `input` argument.
 *   2. It runs in the browser, so `document`, `window`, `getComputedStyle`
 *      etc. are all available and Node APIs are not.
 *
 * INPUT
 *   input.context   'cart'   -> running on /cart (the full cart page)
 *                   'drawer' -> running with the cart drawer open
 *   input.rootSelector  best-guess CSS selector for the drawer/cart root that
 *                       the harness already located, or null.
 *   input.cart      { lines: [{handle, title, key, quantity, finalPrice}],
 *                     totalPrice }   <- straight from /cart.js
 *
 * OUTPUT  (both keys required; use null when nothing was found)
 *   { orderLevelGift: 'CSS selector'|null,
 *     productLevelGift: 'CSS selector'|null,
 *     debug: {...} }
 *
 * ----------------------------------------------------------------------------
 *  HOW IT WORKS
 * ----------------------------------------------------------------------------
 *
 * /cart.js is the ONLY source of truth. The DOM is searched for things the
 * API already told us are there — never the other way round.
 *
 * PRODUCT LEVEL
 *   1. For each cart line, find its title link (matched by product handle from
 *      /cart.js) and the node rendering its `final_price` (matched by the
 *      exact amount from /cart.js).
 *   2. The item anchor is the FIRST COMMON PARENT of that title and that
 *      price — the tightest element holding both.
 *   3. The emitted selector must match exactly as many elements as there are
 *      lines in /cart.js. Not the number of rows the DOM appears to have —
 *      the API's count, and nothing else. Anything short or long is discarded.
 *
 * ORDER LEVEL
 *   1. Find the node rendering `total_price` from /cart.js and the checkout
 *      button, then take their CLOSEST COMMON PARENT.
 *
 * CURRENCY
 *   Prices are matched by the digits /cart.js reported (in cents), rendered
 *   into every plausible format — "1234.56", "1,234.56", "1.234,56",
 *   "1 234,56", and bare "1234" for zero-decimal currencies. No currency
 *   symbol or code is ever hard-coded, so the algorithm is not USD-only.
 *
 * SELECTOR SHAPE
 *   - between 3 and 7 segments
 *   - segment identity priority: stable id > stable id prefix > data-attribute
 *     > meaningful class > any class > custom element > role > bare tag
 *   - ids are per-merchant and per-cart, so any id containing a digit is
 *     rejected outright; `CartItem-42` degrades to `[id^="CartItem-"]`
 *   - a bare tag (`div`) that has a sibling of the same tag always gets
 *     `:nth-child(n)`, since the tag alone identifies nothing
 *   - every candidate is verified with querySelectorAll before being returned
 */
export function selectorAlgorithm(input) {
  // ---------------------------------------------------------------- BEGIN ---
  const { context, rootSelector, cart } = input;

  const MIN_SEGMENTS = 3;
  const MAX_SEGMENTS = 7;

  // ===== ground truth, /cart.js and nothing else ==========================
  const lines = cart && Array.isArray(cart.lines) ? cart.lines : [];
  const lineCount = lines.length;
  const cartTotal = cart && Number.isFinite(cart.totalPrice) ? cart.totalPrice : null;
  const wantSurface = context === 'drawer' ? 'drawer' : 'page';

  const debug = { context, surface: wantSurface, rootSelector, cartLines: lineCount };

  const q = (sel, root = document) => {
    try { return [...root.querySelectorAll(sel)]; } catch { return []; }
  };
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
  const escStr = s => String(s).replace(/(["\\])/g, '\\$1');
  const textOf = el => (el.textContent || '').replace(/\u00A0/g, ' ').trim();
  const depthOf = el => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
  const deepestFirst = els => els.slice().sort((a, b) => depthOf(b) - depthOf(a));

  // ===== 1. prices, matched by value — never by currency symbol ===========
  /**
   * Every plausible rendering of a cents amount. Themes format the same number
   * many ways (grouping with , . or space, decimal mark . or ,, trailing .00
   * dropped), but the digits Shopify charged do not change.
   */
  function priceForms(cents) {
    if (!Number.isFinite(cents)) return { decimal: [], bare: [] };
    const abs = Math.round(Math.abs(cents));
    const whole = String(Math.floor(abs / 100));
    const frac = String(abs % 100).padStart(2, '0');
    const groupings = [
      whole,
      whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','),
      whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.'),
      whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' '),
    ];
    const decimal = new Set();
    for (const w of groupings) { decimal.add(`${w}.${frac}`); decimal.add(`${w},${frac}`); }
    // Zero-decimal currencies (JPY, KRW) and themes that drop a .00 tail.
    const bare = frac === '00' ? [...new Set(groupings)] : [];
    return { decimal: [...decimal], bare };
  }

  /**
   * A bare integer is far weaker evidence than a decimal form — "3" also
   * appears in "3 items" — so it only counts as money when what sits next to
   * it says so: a currency symbol, a short currency code, or nothing at all.
   * Deliberately checks the number's NEIGHBOURS rather than the whole string,
   * so a labelled total ("Total ¥2,300") still reads as a price.
   */
  function bareMatch(t, v) {
    for (let from = 0; ; ) {
      const i = t.indexOf(v, from);
      if (i < 0) return false;
      from = i + 1;
      const before = t.slice(0, i);
      const after = t.slice(i + v.length);
      if (/\d$/.test(before) || /^\d/.test(after)) continue;  // part of a longer number
      if (/^[.,]\d/.test(after)) continue;                    // really "2,300.50"
      if (!before.trim() && !after.trim()) return true;       // the text is just the number
      if (/[^\w\s.,()\-]\s*$/.test(before)) return true;      // "¥2,300"
      if (/^\s*[^\w\s.,()\-]/.test(after)) return true;       // "2,300 €"
      const wordBefore = (before.match(/([A-Za-z]+)\s*$/) || [, ''])[1];
      const wordAfter = (after.match(/^\s*([A-Za-z]+)/) || [, ''])[1];
      // a currency code is short ("kr", "USD"); a noun like "items" is not
      if (wordBefore.length && wordBefore.length <= 3) return true;
      if (wordAfter.length && wordAfter.length <= 3) return true;
    }
  }

  /** Does this element render exactly `cents`, in any currency or format? */
  function showsPrice(el, cents) {
    const t = textOf(el);
    if (!t || t.length > 60) return false;
    const { decimal, bare } = priceForms(cents);
    if (decimal.some(v => t.includes(v))) return true;
    return bare.some(v => bareMatch(t, v));
  }

  /** Deepest nodes rendering `cents` — a wrapper "contains" the text too. */
  const priceNodes = (cents, root = document) =>
    q('*', root).filter(el => showsPrice(el, cents) && !q('*', el).some(d => showsPrice(d, cents)));

  // ===== 2. titles, matched by handle from /cart.js =======================
  const handleOf = href =>
    String(href || '').split('/products/')[1]?.split(/[?#]/)[0].split('/')[0] || '';

  /**
   * The line's title link. A row usually has two links to the same product —
   * the thumbnail and the title — so prefer the one whose text is the title
   * /cart.js reported; the image link renders no text at all.
   */
  function titleNodes(line, root = document) {
    const links = q('a[href*="/products/"]', root)
      .filter(a => handleOf(a.getAttribute('href')) === line.handle && textOf(a));
    if (!line.title) return links;
    const named = links.filter(a => {
      const t = textOf(a);
      return t.includes(line.title.trim()) || line.title.trim().includes(t);
    });
    return named.length ? named : links;
  }

  // ===== 3. rendered-ness and which surface an element sits on ============
  const visible = el => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    // Vertical overflow is fine — a long cart page runs below the fold.
    return !(r.right <= 0 || r.bottom <= 0 || r.left >= vw);
  };

  /** A drawer has to float over the page to work; the page cart is in flow. */
  const surfaceOf = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'DIALOG' ||
          n.getAttribute('aria-modal') === 'true' ||
          n.getAttribute('role') === 'dialog') return 'drawer';
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed') return 'drawer';
      if (cs.position === 'absolute' && (parseInt(cs.zIndex, 10) || 0) > 0) return 'drawer';
    }
    return 'page';
  };

  // ===== 4. item anchor = first common parent of title + final_price ======
  const commonParent = (a, b) => {
    if (a.contains(b)) return a;
    for (let n = a.parentElement; n; n = n.parentElement) if (n.contains(b)) return n;
    return null;
  };

  /** Tightest element holding this line's title and this line's final_price. */
  function anchorsForLine(line) {
    if (!Number.isFinite(line.finalPrice)) return [];
    const prices = priceNodes(line.finalPrice);
    if (!prices.length) return [];
    const out = [];
    for (const title of titleNodes(line)) {
      let best = null;
      for (const price of prices) {
        const cp = commonParent(title, price);
        if (cp && (!best || depthOf(cp) > depthOf(best))) best = cp;
      }
      if (best) out.push(best);
    }
    return out;
  }

  const missingPrices = lines.filter(l => !Number.isFinite(l.finalPrice)).length;
  const rawAnchors = [];
  for (const line of lines) rawAnchors.push(...anchorsForLine(line));

  // Two links in one row can bottom out at different depths, so one anchor may
  // contain another. Keep only the deepest of any nested pair.
  const uniqueAnchors = [...new Set(rawAnchors)];
  const anchors = uniqueAnchors.filter(a => !uniqueAnchors.some(o => o !== a && a.contains(o)));

  debug.anchorsFound = anchors.length;
  if (missingPrices) debug.linesWithoutPrice = missingPrices;

  /**
   * Containers holding EXACTLY the /cart.js line count of anchors. Both
   * surfaces live in the same document, so there are usually two such chains
   * of containers — one around the page cart, one around the drawer.
   */
  function containers() {
    const holds = new Map();
    for (const a of anchors) {
      for (let n = a.parentElement; n; n = n.parentElement) {
        if (!holds.has(n)) holds.set(n, []);
        holds.get(n).push(a);
      }
    }
    return [...holds.entries()]
      .filter(([, list]) => list.length === lineCount)
      .map(([root, items]) => ({ root, items }))
      .sort((a, b) => depthOf(b.root) - depthOf(a.root)); // tightest first
  }

  const rootEl = rootSelector ? q(rootSelector)[0] || null : null;
  debug.rootResolved = Boolean(rootEl);

  /**
   * Pick the container belonging to the surface the harness actually opened.
   * Picking the closed drawer while on /cart (or vice versa) yields a selector
   * pointing at markup nobody can see, so a wrong-surface container is only
   * accepted when the harness itself pointed at it.
   */
  function chooseContainer(all) {
    if (!all.length) return null;
    const inRoot = rootEl
      ? all.filter(c => c.root === rootEl || rootEl.contains(c.root) || c.root.contains(rootEl))
      : [];
    const shown = all.filter(c => visible(c.root));
    const onSurface = shown.filter(c => surfaceOf(c.root) === wantSurface);
    const ladder = [
      ['harness root, rendered on requested surface', inRoot.filter(c => onSurface.includes(c))],
      ['rendered on requested surface', onSurface],
      ['only container in the document', all.length === 1 ? shown : []],
      ['harness root, rendered (surface mismatch)', inRoot.filter(c => shown.includes(c))],
    ].find(([, pool]) => pool.length);
    if (!ladder) return null;
    debug.pick = ladder[0];
    return ladder[1][0];
  }

  const chosen = lineCount ? chooseContainer(containers()) : null;
  const items = chosen ? deepestFirst(chosen.items).reverse() : [];
  if (lineCount && !chosen) {
    debug.productLevelSkipped = anchors.length
      ? `no container holds exactly ${lineCount} cart lines on the ${wantSurface} surface`
      : 'no title+price pair matched any /cart.js line';
  }

  // ===== 5. segment identity, strongest signal first ======================
  const KEYWORD = /cart|item|line|product|price|total|checkout|drawer|footer|mini|summary/i;

  // Ids carrying variant/product/line numbers ("CartItem-2", "cart-item-4482",
  // "shopify-block-a1b2c3") differ per merchant and per cart, so they can
  // never appear verbatim. A segment is volatile when it holds a digit or
  // looks generated.
  const isVolatileSegment = seg =>
    /\d/.test(seg) || /^[a-f0-9]{8,}$/i.test(seg) || /^[a-z0-9]{12,}$/i.test(seg);
  const isVolatileId = id => id.split(/[-_:.]+/).filter(Boolean).some(isVolatileSegment);

  /** Longest leading run of stable segments, kept with its separator. */
  function stablePrefixOf(id) {
    const parts = id.split(/([-_:.]+)/).filter(Boolean);
    let prefix = '';
    for (const part of parts) {
      if (/^[-_:.]+$/.test(part)) { prefix += part; continue; }
      if (isVolatileSegment(part)) return prefix || null;
      prefix += part;
    }
    return null; // entire id was stable — caller may use it directly
  }

  function token(el, { allowId }) {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';

    if (id && !isVolatileId(id)) {
      if (allowId) return { s: `${tag}#${esc(id)}`, strong: 4 };
    } else if (id) {
      const prefix = stablePrefixOf(id);
      if (prefix) return { s: `${tag}[id^="${escStr(prefix)}"]`, strong: 4 };
    }

    const data = [...el.attributes].find(a => a.name.startsWith('data-'));
    if (data) return { s: `${tag}[${data.name}]`, strong: 3 };

    const classes = [...el.classList]
      .filter(c => !/^[a-f0-9]{6,}$/i.test(c) && !/^(css-|sc-|_)/.test(c) && !/\d{3,}/.test(c));
    const best = classes.sort((a, b) => (KEYWORD.test(b) - KEYWORD.test(a)) || b.length - a.length)[0];
    if (best) return { s: `${tag}.${esc(best)}`, strong: KEYWORD.test(best) ? 2 : 1 };

    if (tag.includes('-')) return { s: tag, strong: 2 };
    const role = el.getAttribute('role');
    if (role) return { s: `${tag}[role="${role}"]`, strong: 1 };
    return { s: tag, strong: 0 };
  }

  // ===== 6. build a verified 3-7 segment chain ============================
  /**
   * @param target    element the selector must land on
   * @param expected  the exact node set the selector must resolve to
   */
  function chainFor(target, expected) {
    const path = [];
    for (let n = target; n && n !== document.body; n = n.parentElement) path.unshift(n);
    if (!path.length) return null;
    // Elements sitting just below <body> cannot reach MIN_SEGMENTS on their
    // own. `body` pads the chain out without changing what it matches; it is
    // forced to the bare tag (below) so it never acts as a signal, only as
    // filler, and drops out again as soon as real ancestors can do the job.
    path.unshift(document.body);

    // An id is only safe when its element holds EVERY expected node; on a
    // single row it would pin the selector to that one line.
    const holdsAll = el => expected.every(e => (el === e ? expected.length === 1 : el.contains(e)));

    const toks = path.map((el, i) => {
      if (el === document.body) return { s: 'body', strong: 0, depth: i, nth: 0, ambiguous: false };
      const siblings = el.parentElement ? [...el.parentElement.children] : [];
      return {
        ...token(el, { allowId: holdsAll(el) }),
        depth: i,
        nth: siblings.indexOf(el) + 1,
        // a bare tag that shares its tag with a sibling identifies nothing
        ambiguous: siblings.filter(s => s.tagName === el.tagName).length > 1,
      };
    });

    const targetTok = toks[toks.length - 1];
    const ancestors = toks.slice(0, -1);
    const ok = sel => {
      const got = q(sel);
      return got.length === expected.length && got.every(g => expected.includes(g));
    };

    // The last segment is only pinned by position when a single element is
    // expected. The product-level selector has to match every cart line, and
    // :nth-child would cut it down to one.
    const pinTarget = expected.length === 1;
    const lastIdx = toks.length - 1;

    /**
     * Pinning rounds, least brittle first. A bare tag with a same-tag sibling
     * is always pinned — there is no round where leaving it ambiguous helps.
     * Beyond that, position is added from the DEEPEST segment upward, since a
     * pin close to the target is the most precise and the least likely to
     * break when the theme reflows an outer wrapper.
     */
    function variants(chain) {
      const seen = new Set();
      const out = [];
      const pinnable = chain
        .map((t, i) => ({ t, i }))
        .filter(({ t, i }) => t.nth && (i !== lastIdx || pinTarget))
        .sort((a, b) => b.t.depth - a.t.depth)
        .map(({ i }) => i);

      for (let extra = 0; extra <= pinnable.length; extra++) {
        const forced = new Set(pinnable.slice(0, extra));
        const sel = chain
          .map((t, i) => {
            const must = t.strong === 0 && t.ambiguous && (i !== lastIdx || pinTarget);
            return (t.nth && (must || forced.has(i))) ? `${t.s}:nth-child(${t.nth})` : t.s;
          })
          .join(' ');
        if (!seen.has(sel)) { seen.add(sel); out.push(sel); }
      }
      return out;
    }

    // Strongest ancestors first, so the chain stays meaningful rather than
    // merely long, then re-ordered into document order to form the selector.
    const ranked = ancestors.slice().sort((a, b) => b.strong - a.strong || b.depth - a.depth);
    const maxAncestors = Math.min(MAX_SEGMENTS - 1, ranked.length);
    const minAncestors = Math.min(MIN_SEGMENTS - 1, ranked.length);

    for (let n = minAncestors; n <= maxAncestors; n++) {
      const picked = ranked.slice(0, n).sort((a, b) => a.depth - b.depth);
      for (const sel of variants([...picked, targetTok])) if (ok(sel)) return sel;
    }
    return null;
  }

  // ===== 7. product level =================================================
  let productLevelGift = null;
  if (items.length === lineCount && lineCount > 0) {
    productLevelGift = chainFor(items[0], items);
    if (!productLevelGift) debug.productLevelSkipped = 'no verified chain matched all lines';
  }

  // ===== 8. order level: closest parent of total_price + checkout =========
  let orderLevelGift = null;
  const CHECKOUT = '[name="checkout"], a[href*="/checkout"], button[href*="/checkout"]';

  if (Number.isFinite(cartTotal)) {
    const scope = chosen ? chosen.root : (rootEl || document);
    // Climb out of the item list: the totals block is a sibling of it, not a
    // descendant, so search from the nearest ancestor holding a checkout.
    let region = scope === document ? document : scope;
    while (region !== document && !q(CHECKOUT, region).length && region.parentElement) {
      region = region.parentElement;
    }

    const checkouts = q(CHECKOUT, region).filter(el => !items.some(it => it.contains(el)));
    // A line's own price can equal the cart total (single item), so totals
    // inside a cart row are excluded.
    const totals = priceNodes(cartTotal, region === document ? document : region)
      .filter(el => !items.some(it => it.contains(el)));

    let best = null;
    for (const total of totals) {
      for (const co of checkouts) {
        const cp = commonParent(total, co);
        if (cp && (!best || depthOf(cp) > depthOf(best))) best = cp;
      }
    }
    debug.orderAnchor = Boolean(best);
    if (best) orderLevelGift = chainFor(best, [best]);
  } else {
    debug.orderLevelSkipped = 'no total_price in the /cart.js payload';
  }

  // ===== 9. keep each surface's selectors out of the other ================
  // Anything resolving into a container we did NOT choose belongs to the
  // opposite surface, so drop it rather than hand back a cross-surface match.
  if (chosen) {
    const foreign = containers()
      .map(c => c.root)
      .filter(r => r !== chosen.root && !chosen.root.contains(r) && !r.contains(chosen.root));
    const leaks = sel => sel && q(sel).some(el => foreign.some(f => f === el || f.contains(el)));
    if (leaks(productLevelGift)) { debug.productLeaked = productLevelGift; productLevelGift = null; }
    if (leaks(orderLevelGift)) { debug.orderLeaked = orderLevelGift; orderLevelGift = null; }
  }

  debug.productMatches = productLevelGift ? q(productLevelGift).length : 0;
  debug.orderMatches = orderLevelGift ? q(orderLevelGift).length : 0;

  console.log(`%c=== ${wantSurface === 'drawer' ? 'CART DRAWER' : 'CART PAGE'} ===`,
    'font-weight:bold;font-size:13px');
  console.log('product level :', productLevelGift, `-> ${debug.productMatches} of ${lineCount} lines`);
  console.log('order level   :', orderLevelGift, `-> ${debug.orderMatches} match`);

  return { orderLevelGift, productLevelGift, debug };
  // ------------------------------------------------------------------ END ---
}
