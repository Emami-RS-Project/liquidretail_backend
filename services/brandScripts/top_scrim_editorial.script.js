// Top-scrim editorial testimonial variant.
//
// Content-anchored at the TOP of the frame (opposite of canonical, which
// pins to the bottom). Layout: badge → one-line product name → compact
// rating row → decorative quote + reviewer attribution. Bottom half of
// the video stays clean.
//
// Design philosophy differs from canonical:
//   - Fewer chrome elements (no brand pill, no CTA, no delivery line,
//     no rating bar) — quieter, editorial feel.
//   - One-line product name (fitFontSize shrinks to fit) vs canonical's
//     2-line wrap. Never breaks the composition height.
//   - Decorative "opening quote mark + single-line quote" replaces the
//     canonical's fixed 2-line block. Punchier for short-form 6-10s reels.
//   - Fast timing: elements enter frames 8-46 (canonical spreads 8-68).
//
// Theme compatibility with our Brand.styleTheme docs:
//   - starColor / accentColor / accentGold (all three checked)
//   - separatorColor / dividerColor (both checked)
//   - reviewerTextColor / accentColor / textSecondary fallback chain
//   - All other keys (textPrimary, textSecondary, badgeBg/Text,
//     quoteMarkColor, scrimColor, fonts) either match canonical's naming
//     or have defaults.
//
// This script is opt-in per brand via Brand.styleScript. Canonical
// remains the default when Brand.styleTheme is set but styleScript is
// empty.

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const FPS = 24;
    const isVertical = H > W;

    // 1. Draw base product video
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Utility fallbacks ──────────────────────────────────────────
    const clamp = (value, min = 0, max = 1) =>
      h?.clamp
        ? h.clamp(value, min, max)
        : Math.max(min, Math.min(max, value));

    const t01 = (frame, start, duration) =>
      h?.t01
        ? h.t01(frame, start, duration)
        : clamp((frame - start) / duration);

    const eoc = (value) =>
      h?.eoc
        ? h.eoc(value)
        : 1 - Math.pow(1 - clamp(value), 3);

    const rgba = (rgb, alpha = 1) =>
      h?.rgba
        ? h.rgba(rgb, alpha)
        : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

    // ── Dynamic content ────────────────────────────────────────────
    const badgeText = String(
      meta.badgeText ||
      meta.callout ||
      'Customer Favorite'
    ).toUpperCase();

    const productName = String(
      meta.productName ||
      meta.product ||
      meta.name ||
      'Desert Rose Arrangement'
    );

    const rating = clamp(
      Number(meta.rating ?? 4.9),
      0,
      5
    );

    const reviewCount = String(
      meta.reviewCount ||
      meta.reviews ||
      '327 reviews'
    );

    const quote = normalizeQuote(
      meta.quote ||
      meta.reviewQuote ||
      'Stunning and lasted all week.'
    );

    const reviewer = String(
      meta.reviewer ||
      meta.customerName ||
      'Verified customer'
    ).toUpperCase();

    // ── Brand-driven theme ─────────────────────────────────────────
    // Fallback chains include our canonical theme key names
    // (accentGold, dividerColor) so brands with an existing styleTheme
    // work without any DB change.
    const theme = meta.theme || {};

    const colors = {
      textPrimary:
        theme.textPrimary ||
        [255, 249, 241],

      textSecondary:
        theme.textSecondary ||
        [230, 215, 195],

      reviewerText:
        theme.reviewerTextColor ||
        theme.accentColor ||
        theme.accentGold ||
        [181, 195, 111],

      star:
        theme.starColor ||
        theme.accentColor ||
        theme.accentGold ||
        [238, 166, 19],

      badgeBg:
        theme.badgeBgColor ||
        theme.calloutBgColor ||
        [190, 202, 130],

      badgeText:
        theme.badgeTextColor ||
        theme.calloutTextColor ||
        [31, 34, 25],

      quoteMark:
        theme.quoteMarkColor ||
        theme.badgeBgColor ||
        [190, 202, 130],

      separator:
        theme.separatorColor ||
        theme.dividerColor ||
        [221, 202, 176],

      scrim:
        theme.scrimColor ||
        [11, 8, 5],
    };

    const fonts = {
      sans:
        theme.sansFontFamily ||
        theme.bodyFontFamily ||
        'Inter',

      product:
        theme.productFontFamily ||
        theme.headingFontFamily ||
        theme.serifFontFamily ||
        'Cormorant Garamond',

      productWeight:
        theme.productFontWeight ||
        theme.headingFontWeight ||
        600,

      quote:
        theme.quoteFontFamily ||
        theme.serifFontFamily ||
        'Lora',

      quoteWeight:
        theme.quoteFontWeight ||
        400,
    };

    // ── Vertical video safe-area layout ────────────────────────────
    // Positioned below typical Reels/TikTok identity controls.
    const leftPad = isVertical
      ? Math.round(W * 0.065)
      : Math.round(W * 0.055);

    const rightPad = isVertical
      ? Math.round(W * 0.08)
      : Math.round(W * 0.055);

    const contentW = W - leftPad - rightPad;

    const contentTop = isVertical
      ? Math.round(H * 0.145)
      : Math.round(H * 0.09);

    // ── Upper-third scrim ──────────────────────────────────────────
    // Darkens the upper-left portion while fading cleanly into video.
    const scrimHeight = isVertical
      ? Math.round(H * 0.39)
      : Math.round(H * 0.52);

    const verticalScrim = ctx.createLinearGradient(
      0,
      0,
      0,
      scrimHeight
    );

    verticalScrim.addColorStop(
      0,
      rgba(colors.scrim, 0.76)
    );

    verticalScrim.addColorStop(
      0.38,
      rgba(colors.scrim, 0.62)
    );

    verticalScrim.addColorStop(
      0.72,
      rgba(colors.scrim, 0.30)
    );

    verticalScrim.addColorStop(
      1,
      rgba(colors.scrim, 0)
    );

    ctx.fillStyle = verticalScrim;
    ctx.fillRect(0, 0, W, scrimHeight);

    const horizontalScrim = ctx.createLinearGradient(
      0,
      0,
      W * 0.9,
      0
    );

    horizontalScrim.addColorStop(
      0,
      rgba(colors.scrim, 0.62)
    );

    horizontalScrim.addColorStop(
      0.56,
      rgba(colors.scrim, 0.28)
    );

    horizontalScrim.addColorStop(
      1,
      rgba(colors.scrim, 0)
    );

    ctx.fillStyle = horizontalScrim;
    ctx.fillRect(
      0,
      0,
      Math.round(W * 0.9),
      scrimHeight
    );

    // ── Fast entrance timing for short-form video ──────────────────
    // 0–8    video establishes
    // 8–20   badge
    // 13–29  product name
    // 20–36  ratings row
    // 28–46  quote and reviewer
    const badgeT = eoc(t01(frameIndex, 8, 12));
    const productT = eoc(t01(frameIndex, 13, 16));
    const ratingT = eoc(t01(frameIndex, 20, 16));
    const quoteT = eoc(t01(frameIndex, 28, 18));

    let cursorY = contentTop;

    // ── 2. Customer-favorite badge ─────────────────────────────────
    if (meta.showBadge !== false && badgeText) {
      ctx.save();
      ctx.globalAlpha = badgeT;

      const badgeFontSize = isVertical
        ? clamp(Math.round(W * 0.022), 19, 25)
        : clamp(Math.round(W * 0.018), 15, 20);

      const badgeH = isVertical
        ? Math.round(W * 0.052)
        : Math.round(H * 0.075);

      const badgePadX = isVertical ? 22 : 17;
      const badgeYOffset = (1 - badgeT) * 10;

      ctx.font =
        `700 ${badgeFontSize}px "${fonts.sans}"`;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const badgeW = Math.min(
        contentW,
        ctx.measureText(badgeText).width +
          badgePadX * 2
      );

      ctx.fillStyle = rgba(colors.badgeBg, 0.97);

      roundedRect(
        ctx,
        leftPad,
        cursorY + badgeYOffset,
        badgeW,
        badgeH,
        badgeH / 2
      );

      ctx.fill();

      ctx.fillStyle = rgba(colors.badgeText, 1);

      drawTrackedText(
        ctx,
        badgeText,
        leftPad + badgePadX,
        cursorY +
          badgeH / 2 +
          badgeYOffset +
          1,
        0.9,
        'left'
      );

      ctx.restore();

      cursorY += badgeH + Math.round(H * 0.018);
    }

    // ── 3. One-line product name ───────────────────────────────────
    ctx.save();
    ctx.globalAlpha = productT;

    const preferredProductSize = isVertical
      ? clamp(Math.round(W * 0.054), 46, 60)
      : clamp(Math.round(H * 0.075), 30, 42);

    const minimumProductSize = isVertical
      ? 34
      : 25;

    const productFontSize = fitFontSize(
      ctx,
      productName,
      contentW,
      preferredProductSize,
      minimumProductSize,
      fonts.product,
      fonts.productWeight
    );

    ctx.font =
      `${fonts.productWeight} ` +
      `${productFontSize}px "${fonts.product}"`;

    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.shadowColor = 'rgba(0,0,0,0.40)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 2;

    const fittedProductName = fitText(
      ctx,
      productName,
      contentW
    );

    const productYOffset =
      (1 - productT) * 12;

    ctx.fillText(
      fittedProductName,
      leftPad,
      cursorY +
        productFontSize +
        productYOffset
    );

    ctx.restore();

    cursorY +=
      productFontSize +
      Math.round(H * 0.019);

    // ── 4. Compact rating/review row ───────────────────────────────
    ctx.save();
    ctx.globalAlpha = ratingT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const ratingYOffset =
      (1 - ratingT) * 8;

    const starFontSize = isVertical
      ? clamp(Math.round(W * 0.028), 25, 32)
      : clamp(Math.round(H * 0.047), 18, 24);

    ctx.font =
      `800 ${starFontSize}px "${fonts.sans}"`;

    ctx.fillStyle = rgba(colors.star, 1);

    const stars = '★★★★★';

    ctx.fillText(
      stars,
      leftPad,
      cursorY + ratingYOffset
    );

    const starsW =
      ctx.measureText(stars).width;

    const scoreFontSize = isVertical
      ? clamp(Math.round(W * 0.024), 21, 27)
      : clamp(Math.round(H * 0.039), 16, 21);

    ctx.font =
      `700 ${scoreFontSize}px "${fonts.sans}"`;

    ctx.fillStyle =
      rgba(colors.textPrimary, 1);

    const scoreText =
      `${rating.toFixed(1)}/5`;

    const scoreX =
      leftPad + starsW + 22;

    ctx.fillText(
      scoreText,
      scoreX,
      cursorY + ratingYOffset + 1
    );

    const scoreW =
      ctx.measureText(scoreText).width;

    // Thin separator rather than a bullet.
    const separatorX =
      scoreX + scoreW + 20;

    const separatorH = isVertical ? 26 : 19;

    ctx.strokeStyle =
      rgba(colors.separator, 0.8);

    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(
      separatorX,
      cursorY -
        separatorH / 2 +
        ratingYOffset
    );

    ctx.lineTo(
      separatorX,
      cursorY +
        separatorH / 2 +
        ratingYOffset
    );

    ctx.stroke();

    const reviewFontSize = isVertical
      ? clamp(Math.round(W * 0.022), 19, 24)
      : clamp(Math.round(H * 0.034), 14, 19);

    ctx.font =
      `500 ${reviewFontSize}px "${fonts.sans}"`;

    ctx.fillStyle =
      rgba(colors.textSecondary, 0.96);

    ctx.fillText(
      reviewCount,
      separatorX + 22,
      cursorY + ratingYOffset + 1
    );

    ctx.restore();

    cursorY +=
      starFontSize +
      Math.round(H * 0.023);

    // ── 5. Short one-line quote ────────────────────────────────────
    if (meta.showQuote !== false && quote) {
      ctx.save();
      ctx.globalAlpha = quoteT;

      const quoteMarkSize = isVertical
        ? clamp(Math.round(W * 0.051), 42, 56)
        : clamp(Math.round(H * 0.07), 29, 40);

      const quoteFontPreferred = isVertical
        ? clamp(Math.round(W * 0.029), 25, 33)
        : clamp(Math.round(H * 0.043), 18, 24);

      const quoteFontMinimum = isVertical
        ? 20
        : 15;

      const quoteMarkW = isVertical ? 54 : 38;
      const quoteTextX = leftPad + quoteMarkW;
      const quoteTextW = contentW - quoteMarkW;

      // Large decorative opening quotation mark.
      ctx.font =
        `700 ${quoteMarkSize}px "${fonts.quote}"`;

      ctx.fillStyle =
        rgba(colors.quoteMark, 0.98);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      const quoteYOffset =
        (1 - quoteT) * 8;

      ctx.fillText(
        '\u201C',
        leftPad,
        cursorY +
          quoteMarkSize * 0.72 +
          quoteYOffset
      );

      const quoteFontSize = fitFontSize(
        ctx,
        quote,
        quoteTextW,
        quoteFontPreferred,
        quoteFontMinimum,
        fonts.quote,
        `italic ${fonts.quoteWeight}`
      );

      ctx.font =
        `italic ${fonts.quoteWeight} ` +
        `${quoteFontSize}px "${fonts.quote}"`;

      ctx.fillStyle =
        rgba(colors.textPrimary, 0.98);

      ctx.shadowColor =
        'rgba(0,0,0,0.42)';

      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;

      const fittedQuote = fitText(
        ctx,
        quote,
        quoteTextW
      );

      ctx.fillText(
        fittedQuote,
        quoteTextX,
        cursorY +
          quoteFontSize +
          quoteYOffset
      );

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Reviewer attribution.
      if (
        meta.showReviewer !== false &&
        reviewer
      ) {
        const reviewerFontSize = isVertical
          ? clamp(Math.round(W * 0.016), 14, 18)
          : clamp(Math.round(H * 0.025), 11, 14);

        ctx.font =
          `700 ${reviewerFontSize}px "${fonts.sans}"`;

        ctx.fillStyle =
          rgba(colors.reviewerText, 0.98);

        ctx.fillText(
          reviewer,
          quoteTextX,
          cursorY +
            quoteFontSize +
            reviewerFontSize +
            Math.round(H * 0.012) +
            quoteYOffset
        );
      }

      ctx.restore();
    }

    // ── 6. Soft left-edge vignette ─────────────────────────────────
    const edgeVignette =
      ctx.createLinearGradient(
        0,
        0,
        W * 0.12,
        0
      );

    edgeVignette.addColorStop(
      0,
      rgba(colors.scrim, 0.22)
    );

    edgeVignette.addColorStop(
      1,
      rgba(colors.scrim, 0)
    );

    ctx.fillStyle = edgeVignette;
    ctx.fillRect(
      0,
      0,
      W * 0.12,
      H
    );
  },
};

// ── Drawing helpers ────────────────────────────────────────────────

function roundedRect(ctx, x, y, w, h, radius) {
  if (w <= 0 || h <= 0) return;

  const r = Math.max(
    0,
    Math.min(radius, w / 2, h / 2)
  );

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(
    x + w,
    y,
    x + w,
    y + r
  );
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(
    x + w,
    y + h,
    x + w - r,
    y + h
  );
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(
    x,
    y + h,
    x,
    y + h - r
  );
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(
    x,
    y,
    x + r,
    y
  );
  ctx.closePath();
}

function drawTrackedText(
  ctx,
  text,
  x,
  y,
  tracking = 0,
  align = 'center'
) {
  const characters =
    Array.from(String(text || ''));

  let totalWidth = 0;

  for (
    let i = 0;
    i < characters.length;
    i++
  ) {
    totalWidth +=
      ctx.measureText(characters[i]).width;

    if (i < characters.length - 1) {
      totalWidth += tracking;
    }
  }

  let cursorX =
    align === 'left'
      ? x
      : x - totalWidth / 2;

  for (const character of characters) {
    ctx.fillText(character, cursorX, y);

    cursorX +=
      ctx.measureText(character).width +
      tracking;
  }
}

function fitFontSize(
  ctx,
  text,
  maxWidth,
  preferredSize,
  minimumSize,
  fontFamily,
  fontWeight = 400
) {
  const value = String(text || '');

  let size = preferredSize;

  while (size > minimumSize) {
    ctx.font =
      `${fontWeight} ${size}px "${fontFamily}"`;

    if (
      ctx.measureText(value).width <= maxWidth
    ) {
      return size;
    }

    size -= 1;
  }

  return minimumSize;
}

function fitText(ctx, text, maxWidth) {
  const value =
    String(text || '').trim();

  if (
    ctx.measureText(value).width <= maxWidth
  ) {
    return value;
  }

  let output = value;

  while (
    output.length > 3 &&
    ctx.measureText(`${output}\u2026`).width >
      maxWidth
  ) {
    output = output.slice(0, -1);
  }

  return `${output.trim()}\u2026`;
}

function normalizeQuote(value) {
  return String(value || '')
    .trim()
    .replace(/^[\u201C\u201D"'\u2018\u2019]+/, '')
    .replace(/[\u201C\u201D"'\u2018\u2019]+$/, '')
    .trim();
}
