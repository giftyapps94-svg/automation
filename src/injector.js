/** Injects the visual "Theme injector" marker button next to each discovered selector. */

/**
 * Runs in the page. For every {key, selector} pair it inserts a labelled button
 * at the matched element(s), so the snapshot shows exactly where a gift block
 * would land.
 *
 * productLevelGift marks EVERY match — its selector is verified against the
 * full set of cart lines, so one marker per line item. orderLevelGift marks
 * only the first, since it anchors the cart as a whole.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{key: string, selector: string}>} targets
 * @returns {Promise<Array<{key: string, selector: string, injected: boolean, count: number}>>}
 */
export async function injectMarkers(page, targets) {
  return page.evaluate((items) => {
    const PALETTE = {
      orderLevelGift: '#d72638',
      productLevelGift: '#1b6ca8',
    };

    // Clear markers from a previous pass so re-runs don't stack up.
    document.querySelectorAll('[data-theme-injector]').forEach((el) => el.remove());

    return items.map(({ key, selector }) => {
      if (!selector) return { key, selector, injected: false, count: 0 };

      let targets = [];
      try {
        // The product-level selector is built to match EVERY cart line, so mark
        // them all. Order-level anchors the cart as a whole — one marker only.
        const all = [...document.querySelectorAll(selector)];
        targets = key === 'productLevelGift' ? all : all.slice(0, 1);
      } catch {
        return { key, selector, injected: false, count: 0 };
      }
      if (!targets.length) return { key, selector, injected: false, count: 0 };

      const color = PALETTE[key] || '#6b21a8';

      targets.forEach((target, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.themeInjector = key;
        button.textContent =
          targets.length > 1
            ? `Theme injector — ${key} (${i + 1}/${targets.length})`
            : `Theme injector — ${key}`;
        Object.assign(button.style, {
          display: 'block',
          width: '100%',
          margin: '8px 0',
          padding: '10px 12px',
          font: '600 13px/1.2 system-ui, sans-serif',
          color: '#fff',
          background: color,
          border: `2px solid ${color}`,
          borderRadius: '6px',
          cursor: 'pointer',
          position: 'relative',
          zIndex: '2147483647',
          boxSizing: 'border-box',
        });

        // Outline the anchor itself so the snapshot shows what was matched.
        target.style.outline = `2px dashed ${color}`;
        target.style.outlineOffset = '2px';

        // Insert inside the anchor when it can hold children, otherwise sit beside it.
        // Order-level gifts go at the top of the cart block; product-level ones go
        // after the line item's own content, so the marker reads as belonging to
        // that item rather than pushing its title and price down.
        if (target.children.length > 0 || /DIV|SECTION|FORM|UL|LI|TD|TR/.test(target.tagName)) {
          if (key === 'productLevelGift') target.append(button);
          else target.prepend(button);
        } else {
          target.insertAdjacentElement('afterend', button);
        }
      });

      return { key, selector, injected: true, count: targets.length };
    });
  }, targets);
}
