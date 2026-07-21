// Loads the resolved brand fonts (URLs provided by the server-side font
// resolver) before any frame renders. Families without a URL are assumed
// pre-installed in the render browser (system fallbacks) and skipped.
// A font that fails to load logs and falls back to the role's generic
// stack — a render must never fail because a webfont 404'd.

import { useEffect, useState } from 'react';
import { continueRender, delayRender, cancelRender } from 'remotion';
import { loadFont } from '@remotion/fonts';

export function useBrandFonts(fonts) {
  const [handle] = useState(() => delayRender('brand fonts'));

  useEffect(() => {
    let cancelled = false;
    const entries = Object.values(fonts || {}).filter((f) => f && f.family && f.url);
    // dedupe by family+weight+url
    const seen = new Set();
    const unique = entries.filter((f) => {
      const k = `${f.family}|${f.weight || ''}|${f.url}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    Promise.all(
      unique.map((f) =>
        loadFont({
          family: f.family,
          url: f.url,
          weight: f.weight ? String(f.weight) : undefined,
          style: f.style || 'normal',
        }).catch((e) => {
          // eslint-disable-next-line no-console
          console.warn(`font load failed for ${f.family}: ${e.message} — using fallback stack`);
        })
      )
    )
      .then(() => {
        if (!cancelled) continueRender(handle);
      })
      .catch((e) => cancelRender(e));
    return () => {
      cancelled = true;
    };
  }, [fonts, handle]);
}
