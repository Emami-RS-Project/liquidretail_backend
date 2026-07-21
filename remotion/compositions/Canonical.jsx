// The spec interpreter: renders a normalized title style spec (validated
// server-side by services/titleSpecValidator.js) over the base plate.
// Canonical looks and brand looks are both just specs — this component is
// the only rendering path.
//
// Layout model: slots are grouped by (phase, anchor). Each group is a
// flex column pinned inside the format's safe zones; slots occupy their
// stack position for the whole clip and animate opacity/transform only,
// so staggered entrances never reflow neighbors (same behavior as the
// canvas canonicals). Slots sharing position.row within a group render
// side by side (space-between).

import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { BasePlate } from '../components/BasePlate.jsx';
import { useBrandFonts } from '../components/FontLoader.jsx';
import { SLOT_RENDERERS } from '../components/slotRenderers.jsx';
import { slotEnvelope, slotProgress } from '../lib/timing.js';
import { stackContainerStyle, SAFE_ZONES } from '../lib/safeZones.js';

function resolveSlotContent(slot, meta) {
  const brandMode = meta?.endcardMode === 'brand';
  if (!slot.visible) return null;
  if (brandMode && slot.brandMode === 'hide') return null;

  if (slot.key === 'rating') {
    const rating = Number(meta?.rating);
    if (!Number.isFinite(rating) || rating <= 0) return null;
    return {
      rating: Math.min(5, Math.max(0, rating)),
      reviewsText: meta?.reviewsText || (meta?.reviewCount ? `${meta.reviewCount} reviews` : ''),
    };
  }

  const chain = brandMode && slot.brandModeBind ? slot.brandModeBind : slot.bind;
  for (const field of chain) {
    const v = meta?.[field];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function groupSlots(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = `${slot.phase}|${slot.position.anchor}`;
    if (!groups.has(key)) groups.set(key, { anchor: slot.position.anchor, phase: slot.phase, items: [] });
    groups.get(key).items.push(slot);
  }
  return [...groups.values()];
}

// Within a group, fold consecutive slots that share position.row into one
// side-by-side row.
function foldRows(items) {
  const out = [];
  for (const slot of items) {
    const prev = out[out.length - 1];
    if (slot.position.row && prev && prev.row === slot.position.row) {
      prev.slots.push(slot);
    } else {
      out.push({ row: slot.position.row, slots: [slot] });
    }
  }
  return out;
}

const ALIGN_TO_FLEX = { left: 'flex-start', center: 'center', right: 'flex-end' };

export const Canonical = ({ format = 'feed', plate, meta = {}, tokens = {}, spec, debugLayout = false }) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  useBrandFonts(tokens?.fonts);

  // Spec color overrides win over resolved brand tokens (font overrides are
  // resolved server-side because they may need new font files).
  const mergedTokens = useMemo(() => {
    const colors = { ...(tokens?.colors || {}), ...(spec?.tokenOverrides?.colors || {}) };
    return { ...tokens, colors };
  }, [tokens, spec]);

  const dims = { width, height };
  const groups = useMemo(() => (spec?.slots ? groupSlots(spec.slots) : []), [spec]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <BasePlate plate={plate} />
      {groups.map((group) => {
        const rows = foldRows(group.items);
        const first = group.items[0];
        const container = stackContainerStyle({
          format,
          anchor: group.anchor,
          offsetX: first.position.offsetX,
          offsetY: first.position.offsetY,
          width,
          height,
        });
        return (
          <div key={`${group.phase}|${group.anchor}`} style={{ ...container, gap: Math.round((spec.stack?.rowGapPct ?? 0.018) * height) }}>
            {rows.map((row, ri) => {
              const rendered = row.slots.map((slot) => {
                const content = resolveSlotContent(slot, meta);
                if (content == null) return null;
                const Renderer = SLOT_RENDERERS[slot.key];
                if (!Renderer) return null;
                const env = slotEnvelope({ frame, fps, timing: slot.timing, transition: slot.transition, durationInFrames });
                const progress = slotProgress({ frame, fps, timing: slot.timing, durationInFrames });
                return (
                  <div
                    key={slot.key}
                    style={{
                      opacity: env.opacity,
                      transform: env.transform,
                      clipPath: env.clipPath === 'none' ? undefined : env.clipPath,
                      alignSelf: ALIGN_TO_FLEX[slot.position.align] || 'flex-start',
                      maxWidth: `${slot.position.maxWidthPct * 100}%`,
                    }}
                  >
                    <Renderer
                      slot={slot}
                      content={content}
                      tokens={mergedTokens}
                      dims={dims}
                      format={format}
                      meta={meta}
                      frame={frame}
                      fps={fps}
                      progress={progress}
                    />
                  </div>
                );
              }).filter(Boolean);
              if (!rendered.length) return null;
              if (row.slots.length > 1) {
                return (
                  <div key={`row-${ri}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Math.round(width * 0.02) }}>
                    {rendered}
                  </div>
                );
              }
              return <React.Fragment key={`row-${ri}`}>{rendered}</React.Fragment>;
            })}
          </div>
        );
      })}
      {debugLayout ? <SafeZoneOverlay format={format} width={width} height={height} /> : null}
    </AbsoluteFill>
  );
};

const SafeZoneOverlay = ({ format, width, height }) => {
  const safe = SAFE_ZONES[format] || SAFE_ZONES.feed;
  return (
    <div
      style={{
        position: 'absolute',
        left: safe.left * width,
        right: safe.right * width,
        top: safe.top * height,
        bottom: safe.bottom * height,
        border: '2px dashed rgba(255,0,0,0.7)',
        pointerEvents: 'none',
      }}
    />
  );
};
