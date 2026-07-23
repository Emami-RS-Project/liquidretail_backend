// Visual renderers for every spec slot. Each receives the normalized slot,
// its resolved content, the merged brand tokens, format + canvas dims, the
// current frame/fps (for micro-animations like the CTA pulse), and the
// slot's visible-window progress (drives accent reveals).

import React from 'react';
import { Img } from 'remotion';
import {
  tokenColor,
  tokenFont,
  fontFamilyCss,
  hexToRgba,
  applyCasing,
  clampPx,
  TEXT_SHADOWS,
  BOX_SHADOWS,
} from '../lib/tokens.js';

// Base text size (px at native canvas) per slot per format — derived from
// the canvas canonicals' clamp() outputs at 1080×1920 / 1080×1350 / 1920×1080.
const BASE_SIZE = {
  headline: { vertical: 68, feed: 44, landscape: 60 },
  quote: { vertical: 56, feed: 30, landscape: 36 },
  reviewer: { vertical: 22, feed: 18, landscape: 22 },
  rating: { vertical: 28, feed: 22, landscape: 30 },
  badge: { vertical: 24, feed: 18, landscape: 22 },
  brandPill: { vertical: 26, feed: 22, landscape: 24 },
  productName: { vertical: 56, feed: 36, landscape: 54 },
  price: { vertical: 36, feed: 28, landscape: 36 },
  deliveryLine: { vertical: 22, feed: 16, landscape: 22 },
  cta: { vertical: 26, feed: 20, landscape: 24 },
  promo: { vertical: 26, feed: 20, landscape: 24 },
};

export function baseSize(slotKey, format, sizeScale) {
  const base = BASE_SIZE[slotKey]?.[format] ?? 24;
  return clampPx(base * (sizeScale || 1), 10, 200);
}

function scrimStyle(treatment, tokens, dims) {
  const { scrim, scrimOpacity, scrimColorToken, shadow } = treatment;
  const color = tokenColor(tokens, scrimColorToken);
  const padY = Math.round(dims.height * 0.011);
  const padX = Math.round(dims.width * 0.02);
  const radius = Math.round(dims.height * 0.014);
  const common = {
    padding: `${padY}px ${padX}px`,
    borderRadius: radius,
    boxShadow: BOX_SHADOWS[shadow === 'none' ? 'none' : 'soft'],
  };
  switch (scrim) {
    case 'frosted':
      return {
        ...common,
        backgroundColor: hexToRgba(color, Math.min(1, scrimOpacity * 0.62)),
        backdropFilter: 'blur(18px) saturate(1.25)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.25)',
        border: '1px solid rgba(255,255,255,0.14)',
      };
    case 'solid':
      return { ...common, backgroundColor: hexToRgba(color, scrimOpacity) };
    case 'card':
      return {
        ...common,
        backgroundColor: color,
        borderRadius: Math.round(radius * 1.4),
        boxShadow: BOX_SHADOWS.layered,
        padding: `${Math.round(padY * 1.5)}px ${Math.round(padX * 1.3)}px`,
      };
    case 'none':
    default:
      return { padding: 0 };
  }
}

function textCoreStyle(slot, tokens, dims, format) {
  const t = slot.treatment;
  const font = tokenFont(tokens, t.fontRole);
  return {
    fontFamily: fontFamilyCss(font),
    fontWeight: t.weight,
    fontSize: baseSize(slot.key, format, t.sizeScale),
    letterSpacing: t.trackingPx ? `${t.trackingPx}px` : 'normal',
    color: tokenColor(tokens, t.colorToken),
    textShadow: t.scrim === 'none' ? TEXT_SHADOWS[t.shadow] : TEXT_SHADOWS[t.shadow === 'layered' ? 'soft' : t.shadow],
    lineHeight: 1.16,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: t.maxLines,
    overflow: 'hidden',
  };
}

const Accent = ({ accent, tokens, progress, dims }) => {
  if (!accent || accent.type === 'none') return null;
  const color = tokenColor(tokens, accent.colorToken);
  const reveal = accent.animate ? Math.min(1, progress * 2.5) : 1;
  if (accent.type === 'underline') {
    return (
      <div
        style={{
          height: Math.max(3, Math.round(dims.height * 0.004)),
          width: `${reveal * 38}%`,
          backgroundColor: color,
          borderRadius: 999,
          marginTop: Math.round(dims.height * 0.008),
        }}
      />
    );
  }
  // bar — vertical accent on the leading edge
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: '12%',
        bottom: '12%',
        width: Math.max(4, Math.round(dims.width * 0.005)),
        transform: `scaleY(${reveal})`,
        transformOrigin: 'top',
        backgroundColor: color,
        borderRadius: 999,
      }}
    />
  );
};

// StarRow — inline SVG so the star row never depends on the caller's
// font having U+2605. Brand fonts (Bebas Neue, Antonio, Great Vibes,
// etc.) frequently lack the glyph and the previous text-based rendering
// showed tofu boxes on shipped ads. `size` is the outer diameter of
// each star (matches the previous font-px value); `gap` is horizontal
// spacing between stars.
function StarRow({ color, size, gap, count = 5 }) {
  const points = starPoints(size / 2, (size / 2) * 0.4);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap,
        lineHeight: 1,
        // Non-breaking so a 5-star row never wraps mid-row on tight rating scrims.
        whiteSpace: 'nowrap',
      }}
      aria-label={`${count} out of ${count} stars`}
    >
      {Array.from({ length: count }, (_, i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ display: 'block' }}
        >
          <polygon points={points} fill={color} />
        </svg>
      ))}
    </span>
  );
}

// Build a "cx,cy cx,cy …" polygon points string for a 5-point star of
// the given outer + inner radii, centered at (r, r) so the SVG viewBox
// can be a square of side 2r.
function starPoints(outerR, innerR) {
  const cx = outerR;
  const cy = outerR;
  const verts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = -Math.PI / 2 + i * (Math.PI / 5);
    verts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return verts.join(' ');
}

export const TextSlot = ({ slot, content, tokens, dims, format, progress }) => {
  const t = slot.treatment;
  const text = applyCasing(content, t.casing);
  const quoteWrap = slot.key === 'quote' ? `“${String(text).replace(/^["'“”]+|["'“”]+$/g, '')}”` : text;
  const reviewerWrap = slot.key === 'reviewer' ? `— ${quoteWrap}` : quoteWrap;
  const accent = t.accent || { type: 'none' };
  return (
    <div style={{ position: 'relative', ...scrimStyle(t, tokens, dims), maxWidth: '100%' }}>
      {accent.type === 'bar' ? <Accent accent={accent} tokens={tokens} progress={progress} dims={dims} /> : null}
      <div
        style={{
          ...textCoreStyle(slot, tokens, dims, format),
          fontStyle: slot.key === 'quote' ? 'italic' : 'normal',
          paddingLeft: accent.type === 'bar' ? Math.round(dims.width * 0.015) : 0,
        }}
      >
        {reviewerWrap}
      </div>
      {accent.type === 'underline' ? <Accent accent={accent} tokens={tokens} progress={progress} dims={dims} /> : null}
    </div>
  );
};

export const RatingSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('rating', format, t.sizeScale);
  const { rating, reviewsText } = content;
  const font = tokenFont(tokens, 'body');
  // Secondary color follows the slot's (possibly contrast-flipped) token:
  // when the group flips to on-light colors, the divider + count flip too.
  const secondaryToken = t.colorToken === 'textOnLight' ? 'textSecondaryOnLight' : 'textSecondary';
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-flex', alignItems: 'center', gap: Math.round(dims.width * 0.016) }}>
      <StarRow
        color={tokenColor(tokens, 'stars')}
        size={Math.round(size * 1.15)}
        gap={Math.round(size * 0.15)}
      />
      <span style={{ color: tokenColor(tokens, t.colorToken), fontSize: size, fontWeight: 700, fontFamily: fontFamilyCss(font), textShadow: TEXT_SHADOWS.soft }}>
        {rating.toFixed(1)}/5
      </span>
      {reviewsText ? (
        <>
          <span
            style={{
              width: 2,
              alignSelf: 'stretch',
              margin: `${Math.round(size * 0.2)}px 0`,
              backgroundColor: hexToRgba(tokenColor(tokens, secondaryToken), 0.6),
            }}
          />
          <span style={{ color: tokenColor(tokens, secondaryToken), fontSize: Math.round(size * 0.82), fontWeight: 500, fontFamily: fontFamilyCss(font), textShadow: TEXT_SHADOWS.soft }}>
            {reviewsText}
          </span>
        </>
      ) : null}
    </div>
  );
};

const Pill = ({ children, bg, text, stroke, dims, size, tracking }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: bg,
      color: text,
      border: stroke ? `2px solid ${stroke}` : 'none',
      borderRadius: 999,
      padding: `${Math.round(size * 0.55)}px ${Math.round(size * 1.1)}px`,
      fontSize: size,
      fontWeight: 700,
      letterSpacing: `${tracking ?? 1.5}px`,
      boxShadow: BOX_SHADOWS.soft,
      whiteSpace: 'nowrap',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}
  >
    {children}
  </div>
);

export const BadgeSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('badge', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  return (
    <div style={{ fontFamily: fontFamilyCss(font) }}>
      <Pill
        bg={hexToRgba(tokenColor(tokens, 'badgeBg'), 0.96)}
        text={tokenColor(tokens, 'badgeText')}
        dims={dims}
        size={size}
        tracking={t.trackingPx || 1}
      >
        {applyCasing(content, t.casing === 'none' ? 'upper' : t.casing)}
      </Pill>
    </div>
  );
};

export const BrandPillSlot = ({ slot, content, tokens, dims, format, meta }) => {
  const t = slot.treatment;
  const size = baseSize('brandPill', format, t.sizeScale);
  // The brand's real logo wins over the text pill whenever the ad meta
  // carries one (logoMode 'text' opts back into the pill). Drop-shadow
  // only — no box, matching the no-scrim standard.
  if (t.logoMode !== 'text' && meta?.brandLogoUrl) {
    // Remotion <Img> blocks the frame capture until the logo is decoded —
    // a native <img> can race the screenshot on the first frames.
    return (
      <Img
        src={meta.brandLogoUrl}
        alt={content || 'brand logo'}
        pauseWhenLoading
        style={{
          height: Math.round(size * 2.4),
          maxWidth: Math.round(dims.width * 0.4),
          objectFit: 'contain',
          filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5)) drop-shadow(0 4px 12px rgba(0,0,0,0.35))',
        }}
      />
    );
  }
  const font = tokenFont(tokens, 'body');
  const color = tokenColor(tokens, t.colorToken);
  return (
    <div style={{ fontFamily: fontFamilyCss(font) }}>
      <Pill bg="transparent" text={color} stroke={hexToRgba(color, 0.94)} dims={dims} size={size} tracking={t.trackingPx || 2.2}>
        {applyCasing(content, 'upper')}
      </Pill>
    </div>
  );
};

export const CtaSlot = ({ slot, content, tokens, dims, format, frame, fps, timeScale = 1 }) => {
  const t = slot.treatment;
  const size = baseSize('cta', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  // Gentle attention pulse anchored to the (time-scaled) moment the button
  // finishes entering — sin starts at 0 so there is no scale snap, and the
  // onset doesn't drift with plate length.
  const enterEnd = slot.timing.enterAtSec * timeScale + slot.timing.enterDurationSec + 0.4;
  const tSec = frame / fps;
  const pulse = tSec > enterEnd ? 1 + 0.018 * Math.sin((tSec - enterEnd) * Math.PI * 1.1) : 1;
  return (
    <div style={{ fontFamily: fontFamilyCss(font), transform: `scale(${pulse})` }}>
      <Pill
        bg={hexToRgba(tokenColor(tokens, 'ctaBg'), 0.97)}
        text={tokenColor(tokens, 'ctaText')}
        stroke={hexToRgba('#FFFFFF', 0.25)}
        dims={dims}
        size={size}
        tracking={t.trackingPx || 1.2}
      >
        {applyCasing(content, t.casing === 'none' ? 'upper' : t.casing)}
      </Pill>
    </div>
  );
};

export const PromoSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('promo', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  return (
    <div style={{ fontFamily: fontFamilyCss(font) }}>
      <Pill bg={hexToRgba(tokenColor(tokens, 'promoBg'), 0.97)} text={tokenColor(tokens, 'promoText')} dims={dims} size={size} tracking={t.trackingPx || 1}>
        {applyCasing(content, t.casing)}
      </Pill>
    </div>
  );
};

const TruckIcon = ({ size, color }) => (
  <svg width={size * 1.3} height={size} viewBox="0 0 24 18" fill="none" style={{ flexShrink: 0 }}>
    <path
      d="M1 3h12v10H1zM13 6h5l4 4v3h-9zM6 16.5a2 2 0 100-4 2 2 0 000 4zM17.5 16.5a2 2 0 100-4 2 2 0 000 4z"
      stroke={color}
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

export const DeliverySlot = ({ slot, content, tokens, dims, format, meta }) => {
  const t = slot.treatment;
  const size = baseSize('deliveryLine', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  const color = tokenColor(tokens, t.colorToken === 'textPrimary' ? 'textSecondary' : t.colorToken);
  const showTruck = meta?.endcardMode !== 'brand';
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.5) }}>
      {showTruck ? <TruckIcon size={size} color={color} /> : null}
      <span
        style={{
          fontFamily: fontFamilyCss(font),
          fontWeight: 500,
          fontSize: size,
          color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textShadow: TEXT_SHADOWS.soft,
        }}
      >
        {applyCasing(content, t.casing)}
      </span>
    </div>
  );
};

export const PriceSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('price', format, t.sizeScale);
  const font = tokenFont(tokens, t.fontRole === 'body' ? 'heading' : t.fontRole);
  const raw = String(content);
  // Only prefix a bare number — anything already carrying a currency
  // marker anywhere ('From $48', '£29', '48 USD') passes through.
  const text = /[$€£¥]|usd|eur|gbp/i.test(raw) ? raw : `$${raw}`;
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-block' }}>
      <span style={{ fontFamily: fontFamilyCss(font), fontWeight: Math.max(t.weight, 700), fontSize: size, color: tokenColor(tokens, t.colorToken), textShadow: TEXT_SHADOWS.soft }}>
        {text}
      </span>
    </div>
  );
};

export const SLOT_RENDERERS = {
  headline: TextSlot,
  quote: TextSlot,
  reviewer: TextSlot,
  productName: TextSlot,
  rating: RatingSlot,
  badge: BadgeSlot,
  brandPill: BrandPillSlot,
  cta: CtaSlot,
  promo: PromoSlot,
  deliveryLine: DeliverySlot,
  price: PriceSlot,
};
