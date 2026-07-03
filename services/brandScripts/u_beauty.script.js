// U Beauty — canvas overlay script template.
//
// This file is a TEMPLATE for the styleScript stored on Brand.styleScript.
// Paste the contents into the Brand page's Style card (Script tab) for
// U Beauty and save. The runner (services/brandScriptRunner.child.js)
// loads it in a sandbox where `canvas`, `helpers`, `colors` are
// pre-injected — this file will NOT run as a normal Node module.
//
// Sandbox globals (see brandScriptRunner.child.js):
//   canvas   — @napi-rs/canvas namespace (createCanvas, loadImage, GlobalFonts, ...)
//   sharp    — sharp image ops
//   helpers  — { clamp, t01, eoc, eob, smooth, rgba }
//   colors   — { WHITE, BLACK, NAVY, GOLD, HEART, SOFT }
//
// The runner calls renderFrame(frameIndex, ctx, plate, meta, helpers) once
// per plate frame. ctx is a 2D context on a canvas already sized to
// the plate dimensions. Plate is NOT auto-drawn — script draws it
// first if it wants the base video visible.

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const FPS = 24;

    // 1. Draw base video frame.
    ctx.drawImage(plate, 0, 0, W, H);

    // 2. Bottom scrim for lower-third legibility. Gradient from
    //    transparent at ~55% of height down to 65% black at bottom.
    const scrimStart = Math.round(H * 0.55);
    const grad = ctx.createLinearGradient(0, scrimStart, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, scrimStart, W, H - scrimStart);

    // Timing (in frames):
    //   0-12    plate only, scrim fades in
    //   12-30   meta row fades in
    //   30-60   quote lines slide in (staggered)
    //   60-90   CTA scale-in with overshoot
    //   90-N    hold, gentle attention pulse on CTA
    const rowT   = h.eoc(h.t01(frameIndex, 12, 18));
    const quoteT = h.eoc(h.t01(frameIndex, 30, 30));
    const ctaT   = h.eob(h.t01(frameIndex, 60, 30));
    const pulseT = Math.sin((frameIndex - 90) / FPS * Math.PI * 1.2);

    // 3. Meta row: heart + likes + separator + reviews.
    //    Positioned in the top 3/4 of the scrim area (y ≈ 68% H).
    const rowY = Math.round(H * 0.68);
    ctx.globalAlpha = rowT;
    ctx.font = '600 26px "Inter"';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const heartX = Math.round(W * 0.06);
    drawHeart(ctx, heartX, rowY, 14, h.rgba(colors.HEART, 1));

    const likesX = heartX + 26;
    ctx.fillStyle = h.rgba(colors.WHITE, 1);
    const likesText = String(meta.likes ?? 572);
    ctx.fillText(likesText, likesX, rowY);
    const likesWidth = ctx.measureText(likesText).width;

    const dotX = likesX + likesWidth + 18;
    ctx.fillStyle = h.rgba(colors.WHITE, 0.5);
    ctx.beginPath(); ctx.arc(dotX, rowY, 3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = h.rgba(colors.WHITE, 0.85);
    ctx.fillText(meta.reviewsText || '53 reviews', dotX + 12, rowY);
    ctx.globalAlpha = 1;

    // 4. Quote — up to two lines, staggered fade+rise.
    const quote = Array.isArray(meta.quote) ? meta.quote
                : typeof meta.quote === 'string' ? wrapTwoLines(meta.quote, 42)
                : ['Highly rated for comfort, durability,', 'quick-dry stretch, and standout style.'];
    const quoteBaseY = Math.round(H * 0.75);
    const lineH = 40;
    ctx.font = '500 29px "Inter"';
    ctx.textAlign = 'center';
    ctx.fillStyle = h.rgba(colors.WHITE, 1);
    for (let li = 0; li < Math.min(2, quote.length); li++) {
      const lineT = h.eoc(h.t01(frameIndex, 30 + li * 6, 30));
      ctx.globalAlpha = lineT;
      const yOffset = (1 - lineT) * 24;
      ctx.fillText(quote[li], W / 2, quoteBaseY + li * lineH + yOffset);
    }
    ctx.globalAlpha = 1;

    // 5. CTA pill. Scale-in with overshoot, then a subtle attention
    //    pulse after landing so the eye is drawn to it during the
    //    end-card hold.
    const pillW = 320;
    const pillH = 90;
    const pillX = (W - pillW) / 2;
    const pillY = Math.round(H * 0.87) - pillH / 2;
    const holdPulse = frameIndex > 90 ? (1 + 0.02 * pulseT) : 1;
    const s = ctaT * holdPulse;

    ctx.save();
    ctx.translate(pillX + pillW / 2, pillY + pillH / 2);
    ctx.scale(s, s);
    ctx.translate(-(pillX + pillW / 2), -(pillY + pillH / 2));

    // Pill background — soft white with slight warmth.
    ctx.fillStyle = h.rgba([252, 250, 246], 0.98);
    roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();

    // CTA text — deep black.
    ctx.fillStyle = h.rgba([10, 10, 10], 1);
    ctx.font = '700 31px "Montserrat"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.cta || 'SHOP NOW', pillX + pillW / 2, pillY + pillH / 2 + 2);

    ctx.restore();
  }
};

// ── Local drawing helpers ──────────────────────────────────────────
// These live inside module.exports's file scope so brand editors can
// tweak them without touching the shared runner.

function roundedRect(ctx, x, y, w, h, r) {
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

function drawHeart(ctx, cx, cy, size, fill) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.35);
  ctx.bezierCurveTo(
    cx - size, cy - size * 0.5,
    cx - size * 1.5, cy + size * 0.4,
    cx, cy + size * 0.9
  );
  ctx.bezierCurveTo(
    cx + size * 1.5, cy + size * 0.4,
    cx + size, cy - size * 0.5,
    cx, cy + size * 0.35
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function wrapTwoLines(str, maxCharsPerLine) {
  const words = String(str).trim().split(/\s+/);
  const lines = ['', ''];
  let li = 0;
  for (const w of words) {
    if ((lines[li] + ' ' + w).trim().length > maxCharsPerLine && li === 0) li = 1;
    lines[li] = (lines[li] ? lines[li] + ' ' : '') + w;
  }
  return lines[1] ? lines : [lines[0]];
}
