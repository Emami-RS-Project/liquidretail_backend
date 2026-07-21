// Brand token access for compositions. Tokens arrive fully resolved in
// inputProps (built server-side by titleSpecService.buildBrandTokens);
// these helpers only do lookup + last-resort defaults so a partial token
// object can never crash a render.

const COLOR_DEFAULTS = {
  primary: '#0B0F14',
  secondary: '#DCDCDC',
  accent: '#F5B70A',
  ctaBg: '#46783E',
  ctaText: '#FFF8EF',
  scrim: '#0C0906',
  textPrimary: '#FFFFFF',
  textSecondary: '#DCDCDC',
  stars: '#F5B70A',
  badgeBg: '#BEC282',
  badgeText: '#1F2219',
};

export function tokenColor(tokens, key) {
  const c = tokens?.colors?.[key];
  return typeof c === 'string' && c ? c : COLOR_DEFAULTS[key] || '#FFFFFF';
}

export function hexToRgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const FONT_DEFAULTS = {
  heading: { family: 'Playfair Display', fallback: 'serif', weight: 700 },
  body: { family: 'Inter', fallback: 'sans-serif', weight: 500 },
  quote: { family: 'Lora', fallback: 'serif', weight: 400 },
};

export function tokenFont(tokens, role) {
  const f = tokens?.fonts?.[role];
  const d = FONT_DEFAULTS[role] || FONT_DEFAULTS.body;
  if (!f || !f.family) return d;
  return { family: f.family, fallback: f.fallback || d.fallback, weight: f.weight || d.weight, url: f.url || null, style: f.style || 'normal' };
}

export function fontFamilyCss(font) {
  return `"${font.family}", ${font.fallback}`;
}

// Shadow recipes (treatment.shadow). With the no-scrim standard these are
// the ONLY thing separating type from arbitrary footage — layered starts
// with a tight contour pass (reads on light plates) before the cinematic
// falloff; soft carries a contour too, just lighter.
export const TEXT_SHADOWS = {
  layered: '0 0 2px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.55), 0 6px 16px rgba(0,0,0,0.4), 0 20px 48px rgba(0,0,0,0.35)',
  soft: '0 0 1px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.35)',
  none: 'none',
};

export const BOX_SHADOWS = {
  layered: '0 2px 6px rgba(0,0,0,0.25), 0 12px 36px rgba(0,0,0,0.28)',
  soft: '0 4px 14px rgba(0,0,0,0.20)',
  none: 'none',
};

export function applyCasing(text, casing) {
  if (text == null) return text;
  const s = String(text);
  if (casing === 'upper') return s.toUpperCase();
  if (casing === 'title') {
    return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }
  return s;
}

export function clampPx(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
