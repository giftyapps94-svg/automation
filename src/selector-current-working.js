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
 *      arrive through the single `input` argument. That is why the whole
 *      cart-selector finder below lives inside the function.
 *   2. It runs in the browser, so `document`, `window`, `getComputedStyle`
 *      etc. are all available and Node APIs are not.
 *
 * INPUT
 *   input.context   'cart'   -> running on /cart (the full cart page)
 *                   'drawer' -> running with the cart drawer open
 *   input.rootSelector  best-guess CSS selector for the drawer/cart root that
 *                       the harness already located, or null.
 *
 * OUTPUT  (both keys required; use null when nothing was found)
 *   {
 *     orderLevelGift:   'CSS selector',   // anchor for a cart-wide gift block
 *     productLevelGift: 'CSS selector',   // anchor for a per-line-item gift block
 *     debug:            { ...anything }   // optional, logged to the console
 *   }
 *
 * The harness calls this twice per theme (once with context 'cart', once with
 * 'drawer') and merges the two results into:
 *   selectors.orderLevelGift.cartSelector / .cartDrawerSelector
 *   selectors.productLevelGift.cartSelector / .cartDrawerSelector
 *
 * ----------------------------------------------------------------------------
 *  Shopify cart selector finder — structural, theme-agnostic.
 * ----------------------------------------------------------------------------
 *
 * Outputs ONE selector per target, built as a chain of 3-7 segments
 * (ancestor > ancestor > ... > target) so it is specific enough that only
 * the intended elements match.
 *
 * WHY IT IS THEME AGNOSTIC
 * It never looks for theme class names. It only uses three facts that are
 * true of every Shopify cart because they are functional, not cosmetic:
 *   1. a cart line links to its product:      a[href*="/products/"]
 *   2. a price is money-formatted text
 *   3. checkout is [name=checkout] or a link to /checkout
 * Everything else is derived by walking the DOM structure.
 *
 * ALGORITHM
 *   1. title   = a[href*="/products/"]
 *   2. item parent = walk up from each title until the ancestor also
 *      contains a money element  -> lowest common parent of title + price
 *   3. contexts: each checkout element is a context seed. Walk up from it
 *      until the ancestor contains item parents -> that ancestor is the
 *      context root. Item parents are assigned to the smallest context root
 *      containing them. This separates the page cart from the drawer without
 *      guessing names (themes render drawer markup on /cart too).
 *      The context TYPE ('page' | 'drawer') is NOT inferred from the DOM: it
 *      is handed down from the caller (input.context), because only the
 *      harness knows which surface it actually opened.
 *   4. checkout+total parent = walk up from checkout until the ancestor
 *      contains a money element that is NOT inside a cart item -> that is
 *      the immediate parent of both checkout and total.
 *   5. selector = chain of 3-7 tokens from context root down to target,
 *      then verified with querySelectorAll against the exact expected set.
 */
export function selectorAlgorithm(input) {
  // ---------------------------------------------------------------- BEGIN ---
  const { context, rootSelector, cart } = input;

  // Ground truth from /cart.js, handed down by the harness: one entry per cart
  // LINE. The DOM cannot tell a cart line from a "you may also like" card —
  // both are a product link next to a price — but this can. It also carries
  // each line's real price in cents (and the cart's total), which the
  // algorithm matches against verbatim so it never has to guess a currency
  // symbol or decimal/thousands convention.
  const cartLines = (cart && Array.isArray(cart.lines)) ? cart.lines : [];
  const cartHandles = new Set(cartLines.map(l => l.handle).filter(Boolean));
  const cartLineCount = cartLines.length;
  const cartTotalPrice = cart && Number.isFinite(cart.totalPrice) ? cart.totalPrice : null;

  // first line seen for a handle — good enough to pair a title with its price
  // when the same product appears in more than one line (different variants)
  const lineByHandle = new Map();
  for (const l of cartLines) if (l.handle && !lineByHandle.has(l.handle)) lineByHandle.set(l.handle, l);

  // Fallback only: used when a cart line has no usable finalPrice (older
  // /cart.js responses, zero-cost lines) and there is nothing to match
  // verbatim against. Deliberately loose since it is a last resort, not the
  // primary signal — the primary signal below never needs to know what a
  // currency symbol looks like.
  const MONEY = /(?:[$€£¥₹₩₽₺]|\b(?:USD|EUR|GBP|INR|CAD|AUD|Rs)\b\.?)\s?\d|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}\b/i;
  const KEYWORD = /cart|item|line|product|price|total|checkout|drawer|footer|mini/i;

  const q = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
  // for values inside a quoted attribute selector, where CSS.escape is wrong
  const escStr = s => s.replace(/(["\\])/g, '\\$1');

  // ---- primitives -------------------------------------------------------
  const isMoney = el => {
    const t = (el.textContent || '').trim();
    return t.length > 0 && t.length < 40 && MONEY.test(t);
  };

  // deepest money-bearing elements only (avoid matching every wrapper)
  const moneyIn = root => q('*', root).filter(el => isMoney(el) && !q('*', el).some(isMoney));

  // Every plausible rendering of a cents amount, currency-agnostic: themes
  // format the same number a dozen ways (symbol before/after, comma or dot as
  // the decimal mark, thousands grouping, a trailing ".00" dropped or not),
  // but the digits Shopify actually charged never change. Matching on these
  // instead of a currency-symbol regex is what makes the algorithm work for
  // any currency, not only USD.
  const priceVariants = cents => {
    if (!Number.isFinite(cents)) return [];
    const abs = Math.round(Math.abs(cents));
    const whole = String(Math.floor(abs / 100));
    const frac = String(abs % 100).padStart(2, '0');
    const commaGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const dotGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const variants = new Set([
      `${whole}.${frac}`,
      `${whole},${frac}`,
      `${commaGrouped}.${frac}`,
      `${dotGrouped},${frac}`,
    ]);
    if (frac === '00') for (const w of [whole, commaGrouped, dotGrouped]) variants.add(w);
    return [...variants];
  };

  const isPriceMatch = (el, cents) => {
    const variants = priceVariants(cents);
    if (!variants.length) return false;
    const t = (el.textContent || '').replace(/\u00A0/g, ' ').trim();
    return t.length > 0 && t.length < 60 && variants.some(v => t.includes(v));
  };

  // deepest elements whose text renders `cents`, however the theme formats it
  const priceElsIn = (root, cents) =>
    q('*', root).filter(el => isPriceMatch(el, cents) && !q('*', el).some(d => isPriceMatch(d, cents)));

  // A cart line's price element(s) if its finalPrice is known, else fall back
  // to generic money-shaped text (covers /cart.js responses missing the field).
  const priceElsFor = (root, cents) =>
    Number.isFinite(cents) ? priceElsIn(root, cents) : moneyIn(root);

  const titlesIn = root => q('a[href*="/products/"]', root).filter(a => (a.textContent || '').trim());

  // /products/<handle>?variant=... -> <handle>
  const handleOf = href => String(href || '').split('/products/')[1]?.split(/[?#]/)[0].split('/')[0] || '';

  const cartHandlesIn = root => new Set(
    q('a[href*="/products/"]', root)
      .map(a => handleOf(a.getAttribute('href')))
      .filter(h => cartHandles.has(h))
  );

  // does this element hold a link to EVERY product in the cart?
  const coversAllLines = el => cartHandlesIn(el).size === cartHandles.size;

  const checkoutsIn = root =>
    q('[name="checkout"], a[href*="/checkout"], button[href*="/checkout"]', root)
      .filter(el => !el.closest('[name="checkout"]:not(:scope)'));

  // A closed drawer is still in the DOM on /cart, so "is it rendered" is the
  // test that keeps the two surfaces apart. Covers display:none, visibility,
  // opacity, [hidden]/[inert]/aria-hidden, zero box, and off-canvas drawers
  // that keep their size but sit outside the viewport. Vertical overflow is
  // NOT treated as hidden: a long cart page legitimately runs below the fold,
  // so only fully-left/right/above the viewport counts as off-canvas.
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw) return false;
    return true;
  };

  // Which surface a context root physically belongs to, judged functionally:
  // a drawer has to float over the page to work, so it (or an ancestor) is
  // taken out of normal flow or is a modal dialog. The page cart is in flow.
  const surfaceOf = (el) => {
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

  // ---- step 2: item parent = lowest ancestor holding title + THIS line's
  // final_price (falls back to any money-shaped text if the line's price is
  // unknown) ---------------------------------------------------------------
  function itemParentOf(titleEl, stopAt, cents) {
    let node = titleEl.parentElement;
    while (node && node !== stopAt) {
      if (priceElsFor(node, cents).length) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Rows of one cart share a parent; an upsell carousel has its own. Group by
  // parent and take the group that best matches the real line count.
  function largestCluster(els, want) {
    const groups = new Map();
    for (const el of els) {
      const key = el.parentElement || el;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    const ranked = [...groups.values()].sort((a, b) =>
      ((b.length === want) - (a.length === want)) || (b.length - a.length));
    return ranked[0] && ranked[0].length ? ranked[0] : els;
  }

  // ---- step 3: contexts (page cart vs drawer), found structurally --------
  // `type` is supplied by the caller and stamped onto every context; the DOM
  // is only used to find the roots, never to decide what they are.
  function buildContexts(type) {
    const candidates = [...new Set(
      titlesIn(document).map(t => {
        const line = lineByHandle.get(handleOf(t.getAttribute('href')));
        return itemParentOf(t, document.body, line?.finalPrice);
      }).filter(Boolean)
    )];

    // Two links in the same row (image link + title link, "view details",
    // vendor link) can stop at different depths, so one candidate may contain
    // another. A mixed-depth set is unmatchable by a single chain, so keep
    // only the deepest: drop any candidate that contains another one.
    // Consequence for bundle/gift markup, where a line item really does nest
    // another: the nested child lines win over the parent line.
    const deepest = candidates.filter(p => !candidates.some(o => o !== p && p.contains(o)));

    // Keep only elements that correspond to a real cart line. Without the API
    // a recommendation carousel contributes "items" and poisons the expected
    // set, which either kills the selector or, worse, matches an upsell card.
    const inCart = cartHandles.size
      ? deepest.filter(p => cartHandlesIn(p).size > 0)
      : deepest;

    // NOTE: no line-count reconciliation here. Both surfaces are in the same
    // document, so the global list legitimately holds ~2x the cart's lines;
    // trimming it now would starve one surface of its rows. That happens
    // per-context below, once each row is assigned to a surface.
    const allItemParents = inCart;

    const roots = [];
    for (const co of checkoutsIn(document)) {
      let node = co.parentElement;
      while (node && node !== document.body.parentElement) {
        if (allItemParents.some(p => node.contains(p))) { roots.push({ root: node, checkout: co }); break; }
        node = node.parentElement;
      }
    }
    if (!roots.length) roots.push({ root: document.body, checkout: null });

    // assign each item parent to the SMALLEST context root that contains it
    const contexts = roots.map(r => ({ ...r, type, items: [] }));
    for (const p of allItemParents) {
      const owning = contexts
        .filter(c => c.root.contains(p))
        .sort((a, b) => a.root.querySelectorAll('*').length - b.root.querySelectorAll('*').length)[0];
      if (owning) owning.items.push(p);
    }

    // Now that rows belong to a surface, reconcile each surface against the
    // real line count: anything extra is an upsell card inside the cart
    // container featuring a product that is also in the cart.
    for (const c of contexts) {
      if (cartLineCount && c.items.length > cartLineCount) {
        c.items = largestCluster(c.items, cartLineCount);
      }
    }

    return contexts.filter(c => c.items.length || c.checkout);
  }

  // ---- step 4: immediate parent of checkout + total ----------------------
  // The total is matched against /cart.js's total_price verbatim (see
  // priceVariants), the same way a line's price is — never a currency-symbol
  // guess. Falls back to generic money-shaped text only when total_price
  // wasn't available from the harness.
  function checkoutTotalParent(checkout, items, root) {
    let node = checkout.parentElement;
    while (node && node !== root.parentElement) {
      const total = priceElsFor(node, cartTotalPrice).find(m => !items.some(it => it.contains(m)));
      debugInfo.totalPrice = total;
      if (total) return { parent: node, total };
      node = node.parentElement;
    }
    return null;
  }

  // ---- id stability ------------------------------------------------------
  // Ids carrying variant/product/line numbers ("CartItem-2", "cart-item-
  // 44821399", "shopify-block-a1b2c3d4") differ per merchant and per cart, so
  // they can never appear verbatim in a selector. A segment is volatile when
  // it holds a digit or looks like a generated hash.
  const isVolatileSegment = seg =>
    /\d/.test(seg) || /^[a-f0-9]{8,}$/i.test(seg) || /^[a-z0-9]{12,}$/i.test(seg);

  const idSegments = id => id.split(/[-_:.]+/).filter(Boolean);

  const isVolatileId = id => idSegments(id).some(isVolatileSegment);

  // longest leading run of stable segments, kept with its trailing separator
  // so `[id^="CartItem-"]` still anchors at a segment boundary
  function stablePrefixOf(id) {
    // split keeping the separators so the prefix can be rebuilt verbatim
    const parts = id.split(/([-_:.]+)/).filter(Boolean);
    let prefix = '';
    for (const part of parts) {
      if (/^[-_:.]+$/.test(part)) { prefix += part; continue; }
      if (isVolatileSegment(part)) return prefix || null;
      prefix += part;
    }
    return null; // whole id was stable: caller uses the id itself
  }

  // ---- step 5: build a 3-7 segment selector chain ------------------------
  function token(el, { allowId }) {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const stableIdPrefix = stablePrefixOf(id);

    // a whole id is only usable when nothing in it is merchant/product
    // specific (see isVolatileId); otherwise fall back to the stable prefix
    if (id && !isVolatileId(id)) {
      if (allowId) return { s: `${tag}#${esc(id)}`, strong: 3 };
    } else if (stableIdPrefix) {
      return { s: `${tag}[id^="${escStr(stableIdPrefix)}"]`, strong: 3 };
    }
    const data = [...el.attributes].find(a => a.name.startsWith('data-'));
    if (data) return { s: `${tag}[${data.name}]`, strong: 3 };

    const classes = [...el.classList].filter(c => !/^[a-f0-9]{6,}$/i.test(c) && !/^(css-|sc-|_)/.test(c));
    const best = classes.sort((a, b) => (KEYWORD.test(b) - KEYWORD.test(a)) || b.length - a.length)[0];
    if (best) return { s: `${tag}.${esc(best)}`, strong: KEYWORD.test(best) ? 2 : 1 };

    if (tag.includes('-')) return { s: tag, strong: 2 };
    const role = el.getAttribute('role');
    if (role) return { s: `${tag}[role="${role}"]`, strong: 1 };
    return { s: tag, strong: 0 };
  }

  function chainFor(target, root, expected, { requireAllLines = false } = {}) {
    // full ancestor path, body -> target, so there are always enough
    // ancestors available to reach the required 3-7 segments
    const path = [];
    for (let n = target; n && n !== document.body; n = n.parentElement) path.unshift(n);

    // target is body itself (no checkout found, so buildContexts fell back to
    // document.body) or is detached — there is no chain to build
    if (!path.length) return target === document.body ? 'body' : null;

    // A unique #id is only safe if that element contains EVERY expected
    // element; otherwise it pins the chain to a single cart item. For cart-line
    // targets the /cart.js line-up is the stronger test: the element must hold
    // a link to every product in the cart, so an id on one row is rejected even
    // if `expected` itself came back short.
    const holdsAll = el => expected.every(e => el === e ? expected.length === 1 : el.contains(e));
    const toks = path.map((el, i) => {
      const siblings = el.parentElement ? [...el.parentElement.children] : [];
      return {
        ...token(el, {
          allowId: holdsAll(el) &&
            (!requireAllLines || !cartHandles.size || coversAllLines(el)),
        }),
        depth: i,
        // 1-based position among siblings, for the :nth-child fallback below
        nth: siblings.indexOf(el) + 1,
        // a bare tag (div, span, ...) that shares its tag with a sibling is
        // ambiguous on its own — :nth-child is mandatory for it, not just a
        // fallback tried when everything stronger has failed
        hasSameTagSibling: siblings.filter(s => s.tagName === el.tagName).length > 1,
      };
    });

    const targetTok = toks[toks.length - 1];
    const rest = toks.slice(0, -1).sort((a, b) => b.strong - a.strong || b.depth - a.depth);

    const ok = sel => {
      const got = q(sel);
      return got.length === expected.length && got.every(g => expected.includes(g));
    };

    // A token with nothing to go on ("div") also matches its siblings, so a
    // chain ending in one matches the wrong elements and never verifies. Pin
    // those by position instead. A bare tag with a same-tag sibling is always
    // pinned — there is no round where leaving it ambiguous makes sense.
    // Everything else widens gradually, weakest tokens first, so a
    // positional — and therefore brittle — segment is only introduced once
    // the structural one could not do the job:
    //   -1 as-is (+ mandatory pins) | 1 + generic classes | 3 all
    const variantsOf = (chain) => {
      const seen = new Set();
      return [-1, 1, 3]
        .map(maxStrong => chain
          .map(t => (t.nth && (t.hasSameTagSibling || t.strong <= maxStrong))
            ? `${t.s}:nth-child(${t.nth})`
            : t.s)
          .join(' '))
        .filter(sel => !seen.has(sel) && seen.add(sel));
    };

    // 3 to 7 total segments: take the 2..6 strongest ancestors + the target,
    // strongest first so the chain stays meaningful, then verify
    debugInfo.picked = [];
    for (let n = Math.min(2, rest.length); n <= Math.min(6, rest.length); n++) {
      const picked = rest.slice(0, n).sort((a, b) => a.depth - b.depth);
      debugInfo.picked.push(toks);
      for (const sel of variantsOf([...picked, targetTok])) if (ok(sel)) return sel;
    }
    // fall back to the whole path
    const full = toks.map(t => t.s).join(' ');
    debugInfo.full = full;
    debugInfo.okSelector = ok(full);
    debugInfo.expected = expected;
    debugInfo.got = q(full);
    debugInfo.gotFull = q(full).every(g => expected.includes(g));
    for (const sel of variantsOf(toks)) if (ok(sel)) return sel;
    return null;
  }

  // ---- report ------------------------------------------------------------
  // `currentType` is 'page' | 'drawer', decided by the caller.
  // `rootEl` is the harness' best guess at the surface root, or null.
  function findCartSelectors(currentType, rootEl, debugInfo) {
    const all = buildContexts(currentType);
    debugInfo.contexts = all.map(c => ({
      surface: surfaceOf(c.root),
      visible: visible(c.root),
      items: c.items.length,
      hasCheckout: Boolean(c.checkout),
    }));
    debugInfo.all = all;

    // Scope to the surface the harness actually opened. Themes render the
    // drawer markup on /cart too, so a context is only eligible when it is
    // actually rendered AND sits on the surface we were asked about; picking a
    // closed drawer while on the cart page (or the page cart while the drawer
    // is open) yields a selector that resolves to something nobody can see.
    const scoped = rootEl
      ? all.filter(c => c.root === rootEl || rootEl.contains(c.root) || c.root.contains(rootEl))
      : [];
    const onSurface = all.filter(c => visible(c.root) && surfaceOf(c.root) === currentType);
    const rendered = all.filter(c => visible(c.root));

    // Widen one step at a time; the harness' own root wins wherever it agrees.
    const narrow = (a, b) => a.filter(c => b.includes(c));
    const ladder = [
      ['harness root, rendered on requested surface', narrow(scoped, onSurface)],
      ['rendered on requested surface', onSurface],
      // Only one cart context in the whole document: there is no other
      // surface to confuse it with, so surfaceOf's verdict does not matter.
      ['only context in the document', all.length === 1 ? rendered : []],
      // A rendered context on the WRONG surface is only acceptable when the
      // harness itself pointed at it (it opened the surface, so it outranks
      // surfaceOf); otherwise there is no rung — better no selector than one
      // belonging to the other surface.
      ['harness root, rendered (surface mismatch)', narrow(scoped, rendered)],
      ['harness root only (nothing rendered)', scoped],
    ].find(([, pool]) => pool.length);

    // Nothing rendered on this surface: fail closed rather than hand back a
    // selector pointing into the other surface's hidden markup.
    if (!ladder) { debugInfo.pick = 'no rendered context on this surface'; return []; }
    const [reason, pool] = ladder;
    debugInfo.pick = reason;

    const c = pool
      .slice()
      .sort((a, b) =>
        (b.items.length - a.items.length) ||
        (a.root.querySelectorAll('*').length - b.root.querySelectorAll('*').length))[0];

    const out = [];
    if (!c) return out;

    // Every other context is the opposite surface (or a stale duplicate of
    // this one); no emitted selector may reach into any of them.
    const foreign = all.filter(o => o !== c && !c.root.contains(o.root)).map(o => o.root);
    const clean = sel => sel && !q(sel).some(el => foreign.some(f => f.contains(el) || f === el)) ? sel : null;

    const label = c.type === 'drawer' ? 'CART DRAWER' : 'CART PAGE';
    console.log(`%c=== ${label} ===`, 'font-weight:bold;font-size:13px');

    if (cartLineCount && c.items.length !== cartLineCount) {
      debugInfo.lineCountMismatch = `${c.items.length} item parents vs ${cartLineCount} cart lines`;
      console.warn('cart line count mismatch:', debugInfo.lineCountMismatch);
    }

    // drawer identifier
    if (c.type === 'drawer') {
      const sel = clean(chainFor(c.root, document.body, [c.root]));
      console.log('drawer container :', sel, `-> ${q(sel || ':not(*)').length} match`);
      out.push({ context: label, target: 'drawer container', selector: sel, expected: c.items.length, items: c.items, rootVal: c.root });
    }

    // (a) parent of title + price, all cart items
    if (c.items.length) {
      const sel = clean(chainFor(c.items[0], c.root, c.items, { requireAllLines: true }));
      console.log('(a) item title+price parent :', sel, `-> ${q(sel || ':not(*)').length} of ${c.items.length} items`);
      out.push({ context: label, target: 'cart item parent', selector: sel, expected: c.items.length, items: c.items, rootVal: c.root });
    }

    // (b) immediate parent of checkout + total
    if (c.checkout) {
      const ct = checkoutTotalParent(c.checkout, c.items, c.root);
      debugInfo.ct = ct;
      if (ct) {
        const sel = clean(chainFor(ct.parent, c.root, [ct.parent]));
        console.log('(b) checkout+total parent  ;p :', sel, `-> ${q(sel || ':not(*)').length} match`);
        out.push({ context: label, target: 'checkout+total parent', selector: sel });
      }
    }

    return out;
  }

  // ---- map the finder's report onto the harness contract -----------------
  const currentType = context === 'drawer' ? 'drawer' : 'page';
  const rootEl = rootSelector ? q(rootSelector)[0] || null : null;

  const debugInfo = {};
  const report = findCartSelectors(currentType, rootEl, debugInfo);
  const pick = target => report.find(r => r.target === target && r.selector)?.selector || null;

  return {
    orderLevelGift: pick('checkout+total parent'),
    productLevelGift: pick('cart item parent'),
    debug: {
      context,
      currentType,
      rootSelector,
      rootResolved: Boolean(rootEl),
      cartLines: cartLineCount,
      ...debugInfo,
      drawerContainer: pick('drawer container'),
      report,
    },
  };
  // ------------------------------------------------------------------ END ---
}
