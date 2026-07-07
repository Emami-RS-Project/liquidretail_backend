// Canonical brand-script renderer.
//
// One shared canvas overlay used by every brand that opts into the
// theme-driven path (Brand.styleTheme). Layout, animation, and which
// elements draw are FIXED here — brands can only influence colors,
// font families, and specific text overrides via meta.theme + meta
// fields. This keeps ad-to-ad, brand-to-brand output visually
// consistent while still letting each brand feel distinct through
// palette + typography choices.
//
// This script is DB-editable via SystemConfig.canonicalScript. When
// the DB copy is empty, brandScriptExecutor loads THIS file as the
// fallback. To change the canonical layout everyone renders against,
// edit the file OR update the SystemConfig doc.
//
// Text vars driving the layout (all via meta):
//   brandName, badgeText, productName, rating, reviewCount, quote,
//   reviewer, deliveryLine, ctaText / cta
//
// Theme keys (via meta.theme):
//   sansFontFamily, serifFontFamily, productFontFamily,
//   productFontWeight, quoteFontFamily,
//   textPrimary, textSecondary, textMuted, accentGold,
//   badgeBgColor, badgeTextColor,
//   ctaBgColor, ctaTextColor, ctaStrokeColor,
//   ratingBarStart, ratingBarMid, ratingBarEnd,
//   dividerColor, brandPillStroke, brandPillText

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const FPS = 24;

    // ── Base frame ────────────────────────────────────────────────
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Helpers / fallback easing ────────────────────────────────
    const clamp = (v, min = 0, max = 1) =>
      h && h.clamp ? h.clamp(v, min, max) : Math.max(min, Math.min(max, v));

    const t01 = (f, start, dur) =>
      h && h.t01 ? h.t01(f, start, dur) : clamp((f - start) / dur);

    const eoc = (t) =>
      h && h.eoc ? h.eoc(t) : 1 - Math.pow(1 - clamp(t), 3);

    const eob = (t) => {
      if (h && h.eob) return h.eob(t);
      t = clamp(t);
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };

    const rgba = (rgb, a = 1) =>
      h && h.rgba
        ? h.rgba(rgb, a)
        : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

    // ── Theme / brand-driven styling ─────────────────────────────
    const theme = meta.theme || {};

    const colors = {
      textPrimary: theme.textPrimary || [250, 244, 236],
      textSecondary: theme.textSecondary || [224, 214, 202],
      textMuted: theme.textMuted || [201, 189, 175],
      accentGold: theme.accentGold || [214, 171, 83],

      badgeBg: theme.badgeBgColor || [194, 209, 173],
      badgeText: theme.badgeTextColor || [66, 94, 54],

      ctaBg: theme.ctaBgColor || [70, 120, 62],
      ctaText: theme.ctaTextColor || [255, 248, 239],
      ctaStroke: theme.ctaStrokeColor || [225, 222, 209],

      ratingBarStart: theme.ratingBarStart || [201, 128, 130],
      ratingBarMid: theme.ratingBarMid || [216, 169, 81],
      ratingBarEnd: theme.ratingBarEnd || [120, 144, 95],

      divider: theme.dividerColor || [213, 199, 183],
      brandPillStroke: theme.brandPillStroke || [255, 247, 239],
      brandPillText: theme.brandPillText || [255, 247, 239],
    };

    const fonts = {
      sans: theme.sansFontFamily || 'Inter',
      serif: theme.serifFontFamily || 'Lora',
      productFamily: theme.productFontFamily || 'Cormorant Garamond',
      productWeight: theme.productFontWeight || 600,
      quoteFamily: theme.quoteFontFamily || theme.serifFontFamily || 'Lora',
    };

    // ── Dynamic content ───────────────────────────────────────────
    const brandName = meta.brandName || 'Camelback Flowers';
    const badgeText = (meta.badgeText || 'Customer Favorite').toUpperCase();
    const productName = meta.productName || 'Desert Rose Arrangement';
    const rating = Number(meta.rating ?? 4.9);
    const reviewCount = meta.reviewCount || '327 reviews';
    const quote = meta.quote || 'The arrangement was stunning and lasted all week.';
    const reviewer = meta.reviewer || 'Verified local customer';
    const deliveryLine = meta.deliveryLine || 'Fresh floral delivery available';
    const ctaText = (meta.ctaText || meta.cta || 'Order Today').toUpperCase();

    const isVertical = H > W;

    // ── Safe areas for IG / TikTok ────────────────────────────────
    const topSafe = isVertical ? Math.round(H * 0.10) : Math.round(H * 0.06);
    const bottomSafe = isVertical ? Math.round(H * 0.10) : Math.round(H * 0.06);
    const rightSafe = isVertical ? Math.round(W * 0.10) : Math.round(W * 0.06);
    const leftPad = Math.round(W * 0.065);
    const contentW = W - leftPad * 2 - rightSafe;

    // ── Background scrims / gradients ─────────────────────────────
    const topGrad = ctx.createLinearGradient(0, 0, 0, H * 0.32);
    topGrad.addColorStop(0, 'rgba(16,10,7,0.48)');
    topGrad.addColorStop(1, 'rgba(16,10,7,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, H * 0.32);

    const scrimStart = Math.round(H * 0.52);
    const botGrad = ctx.createLinearGradient(0, scrimStart, 0, H);
    botGrad.addColorStop(0, 'rgba(22,14,8,0.00)');
    botGrad.addColorStop(0.28, 'rgba(22,14,8,0.24)');
    botGrad.addColorStop(0.55, 'rgba(22,14,8,0.50)');
    botGrad.addColorStop(1, 'rgba(22,14,8,0.78)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, scrimStart, W, H - scrimStart);

    const hazeW = Math.round(W * 0.84);
    const hazeGrad = ctx.createLinearGradient(0, 0, hazeW, 0);
    hazeGrad.addColorStop(0, 'rgba(26,17,10,0.50)');
    hazeGrad.addColorStop(0.46, 'rgba(26,17,10,0.22)');
    hazeGrad.addColorStop(1, 'rgba(26,17,10,0.00)');
    ctx.fillStyle = hazeGrad;
    ctx.fillRect(0, Math.round(H * 0.56), hazeW, Math.round(H * 0.44));

    // ── Timing ────────────────────────────────────────────────────
    const brandT = eoc(t01(frameIndex, 8, 16));
    const badgeT = eoc(t01(frameIndex, 16, 16));
    const titleT = eoc(t01(frameIndex, 22, 20));
    const ratingT = eoc(t01(frameIndex, 30, 18));
    const quoteT = eoc(t01(frameIndex, 38, 20));
    const ctaT = eob(t01(frameIndex, 48, 20));
    const pulseT =
      frameIndex > 72
        ? 1 + 0.018 * Math.sin(((frameIndex - 72) / FPS) * Math.PI * 1.1)
        : 1;

    // ── Top brand pill ────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = brandT;

    const brandFontSize = isVertical ? 30 : 22;
    ctx.font = `700 ${brandFontSize}px "${fonts.sans}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const brandText = brandName.toUpperCase();
    const brandTextW = ctx.measureText(brandText).width;
    const brandPillW = brandTextW + 70;
    const brandPillH = isVertical ? 62 : 48;
    const brandPillX = (W - brandPillW) / 2;
    const brandPillY = topSafe;
    const brandYOffset = (1 - brandT) * 14;

    ctx.strokeStyle = rgba(colors.brandPillStroke, 0.94);
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 12;
    roundedRect(ctx, brandPillX, brandPillY + brandYOffset, brandPillW, brandPillH, brandPillH / 2);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba(colors.brandPillText, 1);
    drawTrackedText(ctx, brandText, W / 2, brandPillY + brandPillH / 2 + brandYOffset + 1, 2.2);

    ctx.restore();

    // ── Layout: single top-down flow inside the scrim ─────────────
    //
    // Everything below flows downward from just inside the top of the
    // bottom scrim. The CTA/delivery row is NOT pinned to the bottom
    // safe area — it flows right after the reviewer with a divider
    // gap. That keeps the whole content block visually contained in
    // the shaded scrim area and eliminates dead space between the
    // reviewer attribution and the CTA row.
    const blockX = leftPad;

    const ctaW = Math.min(Math.round(W * 0.42), 340);
    const ctaH = isVertical ? 76 : 56;
    const ctaX = W - rightSafe - ctaW;
    // Absolute floor — CTA bottom must never fall past this so the
    // player controls / IG safe-area stay clear. If the flow pushes
    // CTA past it, the quote clamp below shrinks to fit.
    const ctaBottomFloor = H - bottomSafe;

    // Content cursor — starts just inside the top of the scrim
    // (scrim begins at 0.52H). At 0.54H the first element (badge)
    // sits on shaded background instead of raw video.
    let cursor = Math.round(H * 0.54);

    // ── Badge ───────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = badgeT;
    ctx.font = `700 ${isVertical ? 21 : 17}px "${fonts.sans}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const badgeW = ctx.measureText(badgeText).width + 34;
    const badgeH = 40;
    const badgeYOffset = (1 - badgeT) * 10;

    ctx.fillStyle = rgba(colors.badgeBg, 0.96);
    roundedRect(ctx, blockX, cursor + badgeYOffset, badgeW, badgeH, badgeH / 2);
    ctx.fill();

    ctx.fillStyle = rgba(colors.badgeText, 1);
    drawTrackedText(ctx, badgeText, blockX + 18, cursor + badgeH / 2 + badgeYOffset + 1, 0.8, 'left');
    ctx.restore();

    cursor += badgeH + 18;

    // ── Product title ───────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = titleT;
    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.20)';
    ctx.shadowBlur = 10;

    const productSize = isVertical ? 44 : 32;
    ctx.font = `${fonts.productWeight} ${productSize}px "${fonts.productFamily}"`;
    const titleLines = wrapLines(ctx, productName, contentW, 2);
    const titleLineH = Math.round(productSize * 1.1);
    const titleYOffset = (1 - titleT) * 12;

    for (let i = 0; i < titleLines.length; i++) {
      ctx.fillText(titleLines[i], blockX, cursor + titleYOffset + i * titleLineH);
    }
    ctx.restore();
    cursor += titleLines.length * titleLineH + 20;

    // ── Rating row (stars + count) ──────────────────────────────
    ctx.save();
    ctx.globalAlpha = ratingT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const ratingRowH = isVertical ? 28 : 22;
    ctx.font = `800 ${ratingRowH}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.accentGold, 1);
    const stars = '\u2605 \u2605 \u2605 \u2605 \u2605';
    const ratingYOffset = (1 - ratingT) * 10;
    const ratingMidY = cursor + ratingRowH / 2 + ratingYOffset;
    ctx.fillText(stars, blockX, ratingMidY);

    const starsW = ctx.measureText(stars).width;

    ctx.font = `700 ${isVertical ? 22 : 18}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.fillText(`${rating.toFixed(1)}/5`, blockX + starsW + 16, ratingMidY);
    const ratingTextW = ctx.measureText(`${rating.toFixed(1)}/5`).width;

    ctx.font = `500 ${isVertical ? 19 : 16}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textSecondary, 0.96);
    ctx.fillText(`\u2022  ${reviewCount}`, blockX + starsW + 16 + ratingTextW + 16, ratingMidY);
    ctx.restore();

    cursor += ratingRowH + 14;

    // ── Rating bar ─────────────────────────────────────────────
    const barW = Math.min(contentW, Math.round(W * 0.62));
    const barH = 10;

    ctx.save();
    ctx.globalAlpha = ratingT;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    roundedRect(ctx, blockX, cursor, barW, barH, barH / 2);
    ctx.fill();
    ctx.stroke();

    const fillW = Math.max(0, Math.min(barW, barW * (rating / 5) * ratingT));
    const barGrad = ctx.createLinearGradient(blockX, 0, blockX + barW, 0);
    barGrad.addColorStop(0, rgba(colors.ratingBarStart, 1));
    barGrad.addColorStop(0.55, rgba(colors.ratingBarMid, 1));
    barGrad.addColorStop(1, rgba(colors.ratingBarEnd, 1));
    ctx.fillStyle = barGrad;
    roundedRect(ctx, blockX, cursor, fillW, barH, barH / 2);
    ctx.fill();
    ctx.restore();

    cursor += barH + 22;

    // ── Quote — FIXED 2-line block so downstream layout is
    // deterministic regardless of quote length. wrapLines caps at 2
    // lines with word-boundary ellipsis if overflow; short quotes
    // render into 1 line + leave the second line empty (the fixed
    // block height reserves space either way so reviewer / CTA don't
    // shift up when the quote is short).
    const QUOTE_LINES_FIXED = 2;
    const quoteFontSize = isVertical ? 26 : 20;
    const quoteLineH = Math.round(quoteFontSize * 1.22);
    const QUOTE_BLOCK_H = QUOTE_LINES_FIXED * quoteLineH;
    const reviewerFontSize = isVertical ? 18 : 15;
    const reviewerLineH = Math.round(reviewerFontSize * 1.3);

    // Fixed margin between the reviewer attribution and the top of
    // the delivery/CTA row. Divider is drawn in the middle of this
    // gap. Was previously a computed sum of reviewerGap + dividerGap
    // + ctaTopGap + a half-slack push-down. Now: one number.
    const AUTHOR_TO_CTA_MARGIN = 40;
    const POST_QUOTE_GAP = 6;

    ctx.save();
    ctx.globalAlpha = quoteT;
    ctx.fillStyle = rgba(colors.textPrimary, 0.98);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 10;
    ctx.font = `italic 400 ${quoteFontSize}px "${fonts.quoteFamily}"`;
    const quoteLines = wrapLines(ctx, `\u201C${quote}\u201D`, contentW, QUOTE_LINES_FIXED);
    const quoteYOffset = (1 - quoteT) * 10;

    for (let i = 0; i < quoteLines.length; i++) {
      ctx.fillText(quoteLines[i], blockX, cursor + quoteYOffset + i * quoteLineH);
    }
    ctx.restore();
    cursor += QUOTE_BLOCK_H + POST_QUOTE_GAP;

    // ── Reviewer attribution ────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = quoteT;
    ctx.font = `500 ${reviewerFontSize}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textSecondary, 0.94);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`\u2014 ${reviewer}`, blockX, cursor + (1 - quoteT) * 10);
    ctx.restore();
    cursor += reviewerLineH;

    // ── Fixed author-to-CTA margin (divider centered inside) ─────
    const dividerY = cursor + AUTHOR_TO_CTA_MARGIN / 2;
    const ctaY = cursor + AUTHOR_TO_CTA_MARGIN;

    ctx.save();
    ctx.strokeStyle = rgba(colors.divider, 0.52);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(blockX, dividerY);
    ctx.lineTo(blockX + Math.min(contentW, Math.round(W * 0.66)), dividerY);
    ctx.stroke();
    ctx.restore();

    // ── Bottom row: delivery line (left) + CTA (right) ──────────
    const bottomRowMid = ctaY + ctaH / 2;

    const deliveryMaxX = ctaX - 20;
    const iconSize = isVertical ? 18 : 14;
    ctx.save();
    ctx.fillStyle = rgba(colors.textSecondary, 0.96);
    ctx.font = `500 ${isVertical ? 18 : 15}px "${fonts.sans}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    drawTruckIcon(ctx, blockX, bottomRowMid - iconSize / 2, iconSize, rgba(colors.textSecondary, 0.92));
    const deliveryTextX = blockX + iconSize * 2 + 8;
    const deliveryFit = fitText(ctx, deliveryLine, Math.max(0, deliveryMaxX - deliveryTextX));
    ctx.fillText(deliveryFit, deliveryTextX, bottomRowMid);
    ctx.restore();

    // CTA
    const ctaScale = ctaT * pulseT;
    ctx.save();
    ctx.translate(ctaX + ctaW / 2, ctaY + ctaH / 2);
    ctx.scale(ctaScale, ctaScale);
    ctx.translate(-(ctaX + ctaW / 2), -(ctaY + ctaH / 2));

    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;

    ctx.fillStyle = rgba(colors.ctaBg, 0.96);
    ctx.strokeStyle = rgba(colors.ctaStroke, 0.72);
    ctx.lineWidth = 1.4;
    roundedRect(ctx, ctaX, ctaY, ctaW, ctaH, ctaH / 2);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = rgba(colors.ctaText, 1);
    ctx.font = `800 ${isVertical ? 22 : 18}px "${fonts.sans}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTrackedText(ctx, ctaText, ctaX + ctaW / 2, ctaY + ctaH / 2 + 1, 1.2);
    ctx.restore();

    // Side vignette
    const leftVig = ctx.createLinearGradient(0, 0, W * 0.18, 0);
    leftVig.addColorStop(0, 'rgba(10,6,3,0.24)');
    leftVig.addColorStop(1, 'rgba(10,6,3,0)');
    ctx.fillStyle = leftVig;
    ctx.fillRect(0, 0, W * 0.18, H);
  }
};

// ── Helpers ───────────────────────────────────────────────────────

function roundedRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTrackedText(ctx, text, x, y, tracking = 0, align = 'center') {
  const chars = Array.from(String(text || ''));
  let total = 0;

  for (let i = 0; i < chars.length; i++) {
    total += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) total += tracking;
  }

  let cursor = align === 'left' ? x : x - total / 2;

  for (const ch of chars) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

function fitText(ctx, text, maxWidth) {
  const str = String(text || '').trim();
  if (ctx.measureText(str).width <= maxWidth) return str;

  // Word-boundary truncation — pop the last word until the string
  // + ellipsis fits. Never breaks in the middle of a word.
  const words = str.split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ') + '\u2026';
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  // Single-word overflow (edge case: 30-char product name, narrow
  // canvas). Fall back to character truncation only as a last
  // resort — better than rendering nothing.
  let out = words[0] || str;
  while (out.length > 3 && ctx.measureText(out + '\u2026').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '\u2026';
}

function wrapLines(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '')
    .replace(/\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const lines = [];
  let line = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const test = line ? `${line} ${word}` : word;

    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;

      if (lines.length === maxLines - 1) {
        const remaining = [line, ...words.slice(i + 1)].join(' ');
        lines.push(fitText(ctx, remaining, maxWidth));
        return lines;
      }
    } else {
      line = test;
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function drawTruckIcon(ctx, x, y, s, stroke) {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.rect(x, y + s * 0.25, s * 1.15, s * 0.55);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + s * 1.15, y + s * 0.80);
  ctx.lineTo(x + s * 1.15, y + s * 0.42);
  ctx.lineTo(x + s * 1.55, y + s * 0.42);
  ctx.lineTo(x + s * 1.82, y + s * 0.62);
  ctx.lineTo(x + s * 1.82, y + s * 0.80);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x + s * 0.38, y + s * 0.95, s * 0.14, 0, Math.PI * 2);
  ctx.arc(x + s * 1.45, y + s * 0.95, s * 0.14, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}
