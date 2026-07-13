// Canonical DR v1 — vertical (9:16) overlay for Reels / Shorts / Stories.
//
// Three timed phases over the 8-second Grok lifestyle plate:
//
//   0:00–0:03  HOOK      hook headline over scrim, fade in @ 0-0.4s,
//                        fade out @ 2.6-3s
//   0:03–0:06  PROOF     punchy quote snippet + attribution, fade in
//                        @ 3-3.4s, fade out @ 5.6-6s
//   0:06–0:08  END CARD  product-only image dominates the frame with
//                        product name + ★★★★★ proof bar + optional
//                        promo callout; fade in @ 6-6.3s, holds to 8s
//
// meta fields consumed:
//   headline               (hook copy)
//   quoteSnippet | quote   (proof copy — snippet preferred, ≤50 chars)
//   reviewer               (attribution below the quote)
//   productName            (endcard title)
//   productOnlyImagePath   (local file path — parent downloads it)
//   rating, reviewCount    (proof bar)
//   promoText              (optional callout on the endcard)
//   brandName              (small brand mark on the endcard)
//   theme                  (brand colors + font families)
//
// Assumes 24 fps plates from the Grok pipeline (frames 0-191 = 8s).
// Timing calculations use `frameIndex / 24` for time-in-seconds so
// higher/lower fps sources still hit the intended second marks.

const FPS = 24;

// Endcard imagery is loaded lazily and cached across frames. Product
// endcard uses productImage; brand endcard uses brandLogo. Only the
// one relevant to the ad's endcardMode is actually needed, but caching
// both promises keeps the code parallel.
let productImagePromise = null;
let brandLogoPromise    = null;

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const t = frameIndex / FPS;

    const clamp = h?.clamp || ((v, a = 0, b = 1) => Math.max(a, Math.min(b, v)));
    const smooth = h?.smooth || ((x) => { const c = clamp(x); return c * c * (3 - 2 * c); });
    const rgba = h?.rgba || ((rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);

    // ── Draw the base lifestyle plate ──────────────────────────────
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Theme + font resolution ────────────────────────────────────
    const theme = meta.theme || {};
    const colors = {
      hookScrim:     theme.scrimColor || [0, 0, 0],
      hookText:      theme.textPrimary || [255, 255, 255],
      quoteScrim:    theme.scrimColor || [0, 0, 0],
      quoteText:     theme.textPrimary || [255, 255, 255],
      reviewerText:  theme.textSecondary || theme.accentColor || [220, 220, 220],
      endcardBg:     theme.endcardBgColor || theme.scrimColor || [8, 8, 10],
      endcardText:   theme.textPrimary || [255, 255, 255],
      endcardBody:   theme.textSecondary || [200, 200, 210],
      stars:         theme.starColor || theme.accentColor || theme.accentGold || [245, 183, 10],
      promoBg:       theme.promoBgColor || theme.badgeBgColor || theme.accentColor || [245, 183, 10],
      promoText:     theme.promoTextColor || theme.badgeTextColor || [22, 22, 26]
    };
    const fonts = {
      headline: theme.headingFontFamily || theme.productFontFamily || 'PlayfairDisplay',
      body:     theme.bodyFontFamily    || theme.sansFontFamily    || 'Inter',
      quote:    theme.quoteFontFamily   || theme.serifFontFamily   || 'Lora'
    };

    // ── Copy resolution ────────────────────────────────────────────
    const headline     = String(meta.headline || meta.hookHeadline || '').trim();
    const quote        = String(meta.quoteSnippet || meta.quote || '').trim();
    const reviewer     = String(meta.reviewer || 'Verified customer').trim().toUpperCase();
    const productName  = String(meta.productName || meta.product || '').trim();
    const rating       = Number(meta.rating);
    const reviewCount  = Number(meta.reviewCount);
    const promoText    = String(meta.promoText || '').trim();
    const brandName    = String(meta.brandName || '').trim();
    const brandTagline = String(meta.brandTagline || '').trim();
    const brandWebsite = normalizeWebsite(meta.brandWebsiteUrl);
    const endcardMode  = meta.endcardMode === 'brand' ? 'brand' : 'product';

    // ── Phase gating ───────────────────────────────────────────────
    if (t < 3) {
      const alpha = fadeInOut(t, 0, 0.4, 2.6, 3.0, smooth);
      if (alpha > 0.01 && headline) drawHook(ctx, W, H, headline, alpha, colors, fonts, rgba);
    } else if (t < 6) {
      const alpha = fadeInOut(t, 3.0, 3.4, 5.6, 6.0, smooth);
      if (alpha > 0.01 && quote) drawProof(ctx, W, H, quote, reviewer, alpha, colors, fonts, rgba);
    } else {
      const alpha = fadeInOut(t, 6.0, 6.3, 8.0, 8.0, smooth);
      if (alpha > 0.01) {
        if (endcardMode === 'brand') {
          if (meta.brandLogoPath && !brandLogoPromise) {
            brandLogoPromise = canvas.loadImage(meta.brandLogoPath).catch(() => null);
          }
          const brandLogo = brandLogoPromise ? await brandLogoPromise : null;
          drawBrandEndCard(ctx, W, H, {
            brandLogo, brandName, brandTagline, brandWebsite, quote, reviewer
          }, alpha, colors, fonts, rgba);
        } else {
          if (meta.productOnlyImagePath && !productImagePromise) {
            productImagePromise = canvas.loadImage(meta.productOnlyImagePath).catch(() => null);
          }
          const productImage = productImagePromise ? await productImagePromise : null;
          drawEndCard(ctx, W, H, {
            productImage, productName, rating, reviewCount, promoText, brandName
          }, alpha, colors, fonts, rgba);
        }
      }
    }
  }
};

// Strip protocol + trailing slash for compact display: "reach-social.io"
// reads cleaner than "https://reach-social.io/" on a small footer line.
function normalizeWebsite(url) {
  if (!url) return '';
  return String(url).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

// ── Timing ─────────────────────────────────────────────────────────

// Fade envelope over four time markers:
//   fadeIn: 0 → 1 between (tStart, tHoldStart)
//   hold:   1 between (tHoldStart, tHoldEnd)
//   fadeOut: 1 → 0 between (tHoldEnd, tEnd)
// Passing tHoldEnd === tEnd disables the fade-out (final-frame hold).
function fadeInOut(t, tStart, tHoldStart, tHoldEnd, tEnd, smooth) {
  if (t < tStart || t > tEnd) return 0;
  if (t < tHoldStart) return smooth((t - tStart) / Math.max(0.001, tHoldStart - tStart));
  if (t <= tHoldEnd)  return 1;
  if (tEnd === tHoldEnd) return 1;
  return 1 - smooth((t - tHoldEnd) / Math.max(0.001, tEnd - tHoldEnd));
}

// ── Phase renderers ────────────────────────────────────────────────

// HOOK: headline anchored in the lower-third, over a soft bottom-up
// scrim. Vertical Reels UI reserves ~220px top + ~240px bottom on
// 1080×1920; lower-third at y ≈ 0.55–0.75 keeps text within the
// visible strip below the safe zones.
function drawHook(ctx, W, H, headline, alpha, colors, fonts, rgba) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Bottom-up scrim gradient over the lower half — keeps hero motion
  // above readable, gives headline a legibility floor.
  const scrimTop = H * 0.42;
  const grad = ctx.createLinearGradient(0, scrimTop, 0, H);
  grad.addColorStop(0, rgba(colors.hookScrim, 0));
  grad.addColorStop(1, rgba(colors.hookScrim, 0.72));
  ctx.fillStyle = grad;
  ctx.fillRect(0, scrimTop, W, H - scrimTop);

  // Headline typography — hero scale, wrapped to 2 lines max.
  const fontSize = clampNum(Math.round(H * 0.055), 60, 96);
  ctx.font = `700 ${fontSize}px "${fonts.headline}"`;
  ctx.fillStyle = rgba(colors.hookText, 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;

  const padX = Math.round(W * 0.075);
  const wrapW = W - padX * 2;
  const lines = wrapLines(ctx, headline, wrapW, 2);
  const lineH = Math.round(fontSize * 1.12);
  const blockH = lines.length * lineH;
  const yStart = H * 0.68 - blockH / 2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padX, yStart + i * lineH);
  }
  ctx.restore();
}

// PROOF: snippet quote + reviewer attribution. Same lower-third
// anchor as the hook so the eye doesn't have to relocate mid-video.
function drawProof(ctx, W, H, quote, reviewer, alpha, colors, fonts, rgba) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Same soft bottom-up scrim as HOOK phase for continuity.
  const scrimTop = H * 0.42;
  const grad = ctx.createLinearGradient(0, scrimTop, 0, H);
  grad.addColorStop(0, rgba(colors.quoteScrim, 0));
  grad.addColorStop(1, rgba(colors.quoteScrim, 0.72));
  ctx.fillStyle = grad;
  ctx.fillRect(0, scrimTop, W, H - scrimTop);

  const padX = Math.round(W * 0.075);
  const wrapW = W - padX * 2;

  // Quote — larger than a subheadline, smaller than a hero. Serif
  // reads as testimonial by default; brand can override via theme.
  const quoteSize = clampNum(Math.round(H * 0.048), 52, 84);
  ctx.font = `italic 500 ${quoteSize}px "${fonts.quote}"`;
  ctx.fillStyle = rgba(colors.quoteText, 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;

  const quoteWithQuotes = `“${quote}”`;
  const quoteLines = wrapLines(ctx, quoteWithQuotes, wrapW, 3);
  const quoteLineH = Math.round(quoteSize * 1.18);
  const quoteBlockH = quoteLines.length * quoteLineH;

  const attribSize = clampNum(Math.round(H * 0.018), 18, 30);
  const attribGap  = Math.round(H * 0.020);

  const totalH = quoteBlockH + attribGap + attribSize;
  const yStart = H * 0.68 - totalH / 2;

  for (let i = 0; i < quoteLines.length; i++) {
    ctx.fillText(quoteLines[i], padX, yStart + i * quoteLineH);
  }

  // Attribution — small caps sans, dimmer color.
  ctx.font = `600 ${attribSize}px "${fonts.body}"`;
  ctx.fillStyle = rgba(colors.reviewerText, 1);
  ctx.shadowBlur = 8;
  ctx.fillText(`— ${reviewer}`, padX, yStart + quoteBlockH + attribGap);

  ctx.restore();
}

// END CARD: product-only image dominates the frame; below it the
// product name, star + reviews proof bar, and an optional promo pill.
// Falls back to a text-only endcard when the product image failed to
// load (data hole surfaced upstream).
function drawEndCard(ctx, W, H, data, alpha, colors, fonts, rgba) {
  const { productImage, productName, rating, reviewCount, promoText, brandName } = data;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Full-frame endcard background — solid brand tone over the plate.
  ctx.fillStyle = rgba(colors.endcardBg, 0.94);
  ctx.fillRect(0, 0, W, H);

  const padX = Math.round(W * 0.08);

  // Product image slot (60% of canvas height, aspect-fit, centered).
  const imageMaxW = W - padX * 2;
  const imageMaxH = Math.round(H * 0.52);
  const imageCenterY = Math.round(H * 0.35);

  if (productImage && productImage.width && productImage.height) {
    const scale = Math.min(imageMaxW / productImage.width, imageMaxH / productImage.height);
    const drawW = Math.round(productImage.width * scale);
    const drawH = Math.round(productImage.height * scale);
    const drawX = Math.round((W - drawW) / 2);
    const drawY = Math.round(imageCenterY - drawH / 2);
    ctx.drawImage(productImage, drawX, drawY, drawW, drawH);
  }

  // Divider — thin line under the product image.
  const dividerY = imageCenterY + Math.round(imageMaxH / 2) + Math.round(H * 0.02);
  ctx.strokeStyle = rgba(colors.endcardBody, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, dividerY);
  ctx.lineTo(W - padX, dividerY);
  ctx.stroke();

  // Product name — bold, centered, below the divider.
  const nameY = dividerY + Math.round(H * 0.028);
  const nameSize = clampNum(Math.round(H * 0.038), 44, 72);
  ctx.font = `700 ${nameSize}px "${fonts.headline}"`;
  ctx.fillStyle = rgba(colors.endcardText, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const nameLines = wrapLines(ctx, productName || '', W - padX * 2, 2);
  const nameLineH = Math.round(nameSize * 1.12);
  for (let i = 0; i < nameLines.length; i++) {
    ctx.fillText(nameLines[i], W / 2, nameY + i * nameLineH);
  }
  const nameBlockH = nameLines.length * nameLineH;

  // Proof bar — stars + rating + review count, on one row.
  let cursorY = nameY + nameBlockH + Math.round(H * 0.018);
  if (isFinite(rating) && rating > 0) {
    drawProofBar(ctx, W, cursorY, {
      rating, reviewCount, starColor: colors.stars,
      textColor: colors.endcardBody, fontFamily: fonts.body
    }, H, rgba);
    cursorY += Math.round(H * 0.038);
  }

  // Promo callout — pill, only if present.
  if (promoText) {
    cursorY += Math.round(H * 0.018);
    drawPromoPill(ctx, W, cursorY, promoText, {
      bg: colors.promoBg, text: colors.promoText, fontFamily: fonts.body
    }, H, rgba);
    cursorY += Math.round(H * 0.048);
  }

  // Brand mark — small, at the very bottom, if provided.
  if (brandName) {
    const brandSize = clampNum(Math.round(H * 0.014), 16, 24);
    ctx.font = `600 ${brandSize}px "${fonts.body}"`;
    ctx.fillStyle = rgba(colors.endcardBody, 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(brandName.toUpperCase(), W / 2, H - Math.round(H * 0.04));
  }

  ctx.restore();
}

// BRAND END CARD (0:06-0:08 brand-mode variant): brand logo dominates
// the upper half; tagline sits below on a divider-separated row; small
// brand-mark + website footer anchors the bottom. Composition mirrors
// the product endcard's rhythm but reads as identity rather than a
// transactional product moment.
function drawBrandEndCard(ctx, W, H, data, alpha, colors, fonts, rgba) {
  const { brandLogo, brandName, brandTagline, brandWebsite } = data;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Full-frame background wash — same treatment as product endcard.
  ctx.fillStyle = rgba(colors.endcardBg, 0.94);
  ctx.fillRect(0, 0, W, H);

  const padX = Math.round(W * 0.08);

  // Brand logo slot — smaller than product endcard's product image
  // (logos are simpler shapes and don't need to dominate 60% of the
  // frame the way a product does). ~35% frame height, centered above
  // the tagline.
  const logoMaxW = W - padX * 2;
  const logoMaxH = Math.round(H * 0.32);
  const logoCenterY = Math.round(H * 0.34);

  if (brandLogo && brandLogo.width && brandLogo.height) {
    const scale = Math.min(logoMaxW / brandLogo.width, logoMaxH / brandLogo.height);
    const drawW = Math.round(brandLogo.width * scale);
    const drawH = Math.round(brandLogo.height * scale);
    const drawX = Math.round((W - drawW) / 2);
    const drawY = Math.round(logoCenterY - drawH / 2);
    ctx.drawImage(brandLogo, drawX, drawY, drawW, drawH);
  } else if (brandName) {
    // No logo image — fall back to the brand name at hero scale as
    // the identity anchor. Same slot, same y-anchor.
    const wordmarkSize = clampNum(Math.round(H * 0.052), 60, 96);
    ctx.font = `700 ${wordmarkSize}px "${fonts.headline}"`;
    ctx.fillStyle = rgba(colors.endcardText, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(brandName.toUpperCase(), W / 2, logoCenterY);
  }

  // Divider under the logo slot.
  const dividerY = logoCenterY + Math.round(logoMaxH / 2) + Math.round(H * 0.03);
  ctx.strokeStyle = rgba(colors.endcardBody, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, dividerY);
  ctx.lineTo(W - padX, dividerY);
  ctx.stroke();

  // Brand tagline — editorial serif at a larger scale than the product
  // endcard's product name. Positions the tagline as the primary line
  // the viewer reads on the endcard.
  let cursorY = dividerY + Math.round(H * 0.036);
  if (brandTagline) {
    const taglineSize = clampNum(Math.round(H * 0.034), 40, 64);
    ctx.font = `500 ${taglineSize}px "${fonts.quote}"`;
    ctx.fillStyle = rgba(colors.endcardText, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const lines = wrapLines(ctx, brandTagline, W - padX * 2, 3);
    const lineH = Math.round(taglineSize * 1.18);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W / 2, cursorY + i * lineH);
    }
    cursorY += lines.length * lineH;
  }

  // Footer row — brand name (small caps) + website. Only renders when
  // there's a logo image (otherwise the wordmark above already carries
  // the name and repeating it would be noisy). Website reads compact:
  // "reach-social.io" not "https://www.reach-social.io/".
  const footerY = H - Math.round(H * 0.04);
  if (brandLogo && (brandName || brandWebsite)) {
    const footerSize = clampNum(Math.round(H * 0.014), 16, 24);
    ctx.font = `600 ${footerSize}px "${fonts.body}"`;
    ctx.fillStyle = rgba(colors.endcardBody, 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const footerLine = [brandName ? brandName.toUpperCase() : null, brandWebsite]
      .filter(Boolean)
      .join('  ·  ');
    if (footerLine) ctx.fillText(footerLine, W / 2, footerY);
  } else if (brandWebsite) {
    // Logo missing (wordmark on top) — footer becomes just the website.
    const footerSize = clampNum(Math.round(H * 0.014), 16, 24);
    ctx.font = `600 ${footerSize}px "${fonts.body}"`;
    ctx.fillStyle = rgba(colors.endcardBody, 0.85);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(brandWebsite, W / 2, footerY);
  }

  ctx.restore();
}

// ── Endcard sub-renderers ──────────────────────────────────────────

function drawProofBar(ctx, W, y, { rating, reviewCount, starColor, textColor, fontFamily }, H, rgba) {
  const starSize   = clampNum(Math.round(H * 0.024), 26, 42);
  const scoreSize  = clampNum(Math.round(H * 0.020), 22, 34);
  const reviewSize = clampNum(Math.round(H * 0.017), 18, 28);
  const gapAfterStars = Math.round(W * 0.020);
  const gapAroundSep  = Math.round(W * 0.016);

  const stars = '\u2605\u2605\u2605\u2605\u2605';
  const scoreText   = `${(rating || 0).toFixed(1)}/5`;
  const reviewsText = isFinite(reviewCount) && reviewCount > 0
    ? `${formatCount(reviewCount)} reviews` : '';

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  ctx.font = `800 ${starSize}px "${fontFamily}"`;
  const starsW = ctx.measureText(stars).width;
  ctx.font = `700 ${scoreSize}px "${fontFamily}"`;
  const scoreW = ctx.measureText(scoreText).width;
  ctx.font = `500 ${reviewSize}px "${fontFamily}"`;
  const reviewsW = reviewsText ? ctx.measureText(reviewsText).width : 0;

  const totalW = starsW + gapAfterStars + scoreW +
                 (reviewsText ? gapAroundSep * 2 + 2 + reviewsW : 0);
  let cursor = (W - totalW) / 2;
  const centerY = y + starSize / 2;

  ctx.font = `800 ${starSize}px "${fontFamily}"`;
  ctx.fillStyle = rgba(starColor, 1);
  ctx.fillText(stars, cursor, centerY);
  cursor += starsW + gapAfterStars;

  ctx.font = `700 ${scoreSize}px "${fontFamily}"`;
  ctx.fillStyle = rgba(textColor, 1);
  ctx.fillText(scoreText, cursor, centerY);
  cursor += scoreW;

  if (reviewsText) {
    cursor += gapAroundSep;
    const sepH = starSize * 0.5;
    ctx.strokeStyle = rgba(textColor, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursor, centerY - sepH / 2);
    ctx.lineTo(cursor, centerY + sepH / 2);
    ctx.stroke();
    cursor += gapAroundSep;
    ctx.font = `500 ${reviewSize}px "${fontFamily}"`;
    ctx.fillStyle = rgba(textColor, 0.95);
    ctx.fillText(reviewsText, cursor, centerY);
  }
}

function drawPromoPill(ctx, W, y, text, { bg, text: textColor, fontFamily }, H, rgba) {
  const fontSize = clampNum(Math.round(H * 0.020), 22, 34);
  const padX = Math.round(fontSize * 0.9);
  const pillH = Math.round(fontSize * 1.9);

  ctx.font = `700 ${fontSize}px "${fontFamily}"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textW = ctx.measureText(text).width;
  const pillW = textW + padX * 2;
  const pillX = Math.round((W - pillW) / 2);

  ctx.fillStyle = rgba(bg, 1);
  roundedRect(ctx, pillX, y, pillW, pillH, pillH / 2);
  ctx.fill();

  ctx.fillStyle = rgba(textColor, 1);
  ctx.fillText(text, pillX + padX, y + pillH / 2 + 1);
}

// ── Text utilities ─────────────────────────────────────────────────

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Ellipsize the last line if text overflowed the maxLines cap.
  if (lines.length === maxLines) {
    const remaining = words.slice(lines.join(' ').split(/\s+/).length).join(' ');
    if (remaining) {
      let last = lines[lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = last + '…';
    }
  }
  return lines;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}

function clampNum(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatCount(n) {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}
