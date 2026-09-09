'use strict';
//
// copyBudgets — per-surface character budgets for fit-before-write.
//
// Principle (session.d/2026-09-08_director-content-redesign_plan.md §4):
// budgets are INPUTS to copy authorship and quote-variant selection;
// remotion truncateWordSafe / stackFit / applyDensity stay as alerting
// backstops that must no-op when this module did its job.
//
// THIS MODULE CALLS THE REAL GEOMETRY. It does not re-derive numbers by
// hand. Video caps come from remotion/lib/slotContent.js `deriveCharCap`
// (the same function Canonical.jsx uses at paint). Static density comes
// from staticAdIntents.SURFACE_POLICY.maxTextElements. A Remotion geometry
// change therefore cannot silently desync authorship budgets.
//
// The 2026-09-08 plan recorded compiled figures (Stories quote 63, Reels
// quote 58, feed quote 47, PMax 16:9 quote 32, …). Those were design-doc
// estimates. Measured against live deriveCharCap on this tree they are
// WRONG in several slots — see videoBudgets() and scripts/verifyCopyBudgets.js.
// Do not "restore" the plan numbers; restore the CALL to deriveCharCap.
//
// Kill switch: FIT_BEFORE_WRITE === 'true' (unset/false = off). Parser is
// strictly `=== 'true'`. File default is reported for config/defaults.env
// (this module does not edit that file). Flag-off: callers must not rewrite
// copy; telemetry still records a clamp that fires (pixels unchanged).
//
// Two-tree: this file is vendored to adgen/src/services/copyBudgets.js.
// Relative requires (`../remotion/lib/slotContent.js`, `./staticAdIntents`)
// resolve in both trees.

const { deriveCharCap, CANVAS_WIDTH_DEFAULT } = require('../remotion/lib/slotContent.js');
const { completeSentencePrefix, splitSentences, finishesThought } = require('../utils/htmlEntities');
const { scoreSentence } = require('../utils/reviewText');

/** Must stay in lockstep with slotContent.js resolveSlotContentCore `itemCharCap`. */
const BENEFITS_ITEM_CHAR_CAP = 40;

/**
 * Live static quote cap (adgen directImageRenderService.STATIC_QUOTE_DEFAULT_CAP).
 * The plan's 80 for Stories / PMax 1.91:1 is NOT in the live renderer — a
 * single 100 applies to every static surface. copyBudgets reports what the
 * renderer actually enforces, not the design-doc wish.
 */
const STATIC_QUOTE_DEFAULT_CAP = 100;

const VARIANT_KEYS_LONGEST_FIRST = ['full', 'c140', 'c100', 'c80', 'c50'];

/**
 * Canvas format for a platformFormat / surface key. Mirrors
 * brandScriptExecutor.classifyFormat's aspect half + the platformFormat
 * → composition mapping used at titling (vertical > square > landscape >
 * feed). Unknown keys return null so deriveCharCap stays inert rather
 * than inventing a box.
 */
const FORMAT_FOR_SURFACE = Object.freeze({
  meta_stories_9_16: 'vertical',
  meta_reels_9_16: 'vertical',
  pmax_video_9_16: 'vertical',
  pmax_video_16_9: 'landscape',
  pmax_video_1_1: 'square',
  meta_feed_1_1: 'square',
  meta_feed_4_5: 'feed',
  pmax_square_1_1: 'square',
  pmax_portrait_4_5: 'feed',
  pmax_landscape_1_91_1: 'landscape',
  pmax_16_9: 'landscape',
});

/** canonical.json authors a `headline` slot only on vertical + landscape. */
const HEADLINE_SLOT_FORMATS = new Set(['vertical', 'landscape']);

function isFitBeforeWriteEnabled() {
  return process.env.FIT_BEFORE_WRITE === 'true';
}

function formatForSurface(platformFormat, format) {
  if (format && CANVAS_WIDTH_DEFAULT[format] != null) return format;
  const pf = String(platformFormat || '').trim();
  if (pf && FORMAT_FOR_SURFACE[pf]) return FORMAT_FOR_SURFACE[pf];
  return null;
}

function capCtxFor(platformFormat, format) {
  const fmt = formatForSurface(platformFormat, format);
  return {
    format: fmt,
    platformFormat: platformFormat || null,
    canvasWidth: (fmt && CANVAS_WIDTH_DEFAULT[fmt]) || null,
  };
}

/**
 * Video (Remotion) budgets for a surface. Every char cap is deriveCharCap
 * with the same ctx Canonical builds (format + platformFormat + canvasWidth).
 *
 * @returns {{
 *   kind: 'video',
 *   platformFormat: string|null,
 *   format: string|null,
 *   headline: number|null,
 *   quote: number|null,
 *   productName: number|null,
 *   benefitsItem: number,
 *   hasHeadlineSlot: boolean,
 *   maxTextElements: null
 * }}
 */
function videoBudgets(platformFormat, format) {
  const ctx = capCtxFor(platformFormat, format);
  const fmt = ctx.format;
  return {
    kind: 'video',
    platformFormat: platformFormat || null,
    format: fmt,
    headline: deriveCharCap('headline', ctx),
    quote: deriveCharCap('quote', ctx),
    productName: deriveCharCap('productName', ctx),
    benefitsItem: BENEFITS_ITEM_CHAR_CAP,
    hasHeadlineSlot: HEADLINE_SLOT_FORMATS.has(fmt),
    maxTextElements: null,
  };
}

function maxTextElementsFor(surface) {
  // Lazy: staticAdIntents is a heavy module and this file must not create
  // a load-order cycle with it (buildPrompt lazily requires us too).
  const { SURFACE_POLICY } = require('./staticAdIntents');
  const policy = SURFACE_POLICY[surface];
  if (!policy || policy.static !== true) return null;
  const n = policy.maxTextElements;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Static (gpt-image-2) budgets. Character caps do NOT bind the image model
 * — it typesets from exact strings and sometimes ignores them. What IS
 * enforceable here: maxTextElements (applyDensity) and the quote-selection
 * cap used by selectStaticQuoteText (drop-don't-mangle, never ellipsis).
 *
 * headline is null: there is no live static headline char cap in
 * staticAdIntents.js. The plan's 48/40 figures are authorship targets for
 * a future copy-fitter, not something this renderer currently cuts to.
 */
function staticBudgets(surface) {
  return {
    kind: 'static',
    platformFormat: surface || null,
    format: formatForSurface(surface, null),
    surface: surface || null,
    headline: null,
    quote: STATIC_QUOTE_DEFAULT_CAP,
    productName: null,
    benefitsItem: BENEFITS_ITEM_CHAR_CAP,
    hasHeadlineSlot: true,
    maxTextElements: maxTextElementsFor(surface),
  };
}

function budgetsFor({ platformFormat, format, kind, surface } = {}) {
  const key = surface || platformFormat || null;
  if (kind === 'static') return staticBudgets(key);
  if (kind === 'video') return videoBudgets(platformFormat || key, format);
  // Infer: SURFACE_POLICY.static surfaces are static; everything else video.
  if (key) {
    try {
      const { SURFACE_POLICY } = require('./staticAdIntents');
      if (SURFACE_POLICY[key] && SURFACE_POLICY[key].static === true) {
        return staticBudgets(key);
      }
    } catch (_) { /* SURFACE_POLICY unavailable — treat as video */ }
  }
  return videoBudgets(platformFormat || key, format);
}

function collapseWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function introducedEllipsis(source, text) {
  if (!text) return false;
  const src = String(source == null ? '' : source);
  if (text.includes('…') && !src.includes('…')) return true;
  if (text.includes('...') && !src.includes('...')) return true;
  return false;
}

/**
 * Longest whole-sentence/clause substring that fits `cap`. No ellipsis
 * is ever added. Same contract as contentCompiler.variantForCap (this
 * module cannot require contentCompiler — it is not vendored to adgen).
 *
 * @returns {{ text: string|null, chars: number, method: 'full'|'sentence_prefix'|'extractive_span'|'none' }}
 */
function variantForCap(text, cap) {
  const full = collapseWs(text);
  const n = Number(cap);
  if (!full) return { text: null, chars: 0, method: 'none' };
  if (!Number.isFinite(n) || n < 1) return { text: null, chars: 0, method: 'none' };
  if (full.length <= n) return { text: full, chars: full.length, method: 'full' };
  const prefix = completeSentencePrefix(full, n);
  if (prefix && prefix.length > 0 && prefix.length <= n && full.includes(prefix)) {
    return { text: prefix, chars: prefix.length, method: 'sentence_prefix' };
  }
  let best = null;
  let bestScore = -Infinity;
  for (const part of splitSentences(full)) {
    const candidate = collapseWs(part);
    if (!candidate || candidate.length > n) continue;
    if (!full.includes(candidate)) continue;
    const score = scoreSentence(candidate);
    if (
      score > bestScore
      || (score === bestScore && best && candidate.length > best.text.length)
    ) {
      bestScore = score;
      best = { text: candidate, chars: candidate.length, method: 'extractive_span' };
    }
  }
  return best || { text: null, chars: 0, method: 'none' };
}

function pushCandidate(list, source, text, method, cap, variantKey) {
  const t = collapseWs(text);
  if (!t) return;
  if (t.length > cap) return;
  if (introducedEllipsis(source, t)) return;
  if (source && t !== source && !source.includes(t)) return;
  list.push({ text: t, chars: t.length, method, cap, variantKey });
}

/**
 * Pick the longest pre-fitted (or just-computed) variant that fits `cap`.
 * Never introduces `…` / `...` that was not in the source. Returns null
 * when nothing complete fits — callers DROP, they do not clip.
 *
 * `source` may be a string or `{ text, snippet, variants }`.
 */
function pickQuoteVariant(source, cap) {
  const n = Number(cap);
  if (!Number.isFinite(n) || n < 1) return null;
  const obj = (source && typeof source === 'object' && !Array.isArray(source))
    ? source
    : { text: source };
  const full = collapseWs(obj.text || (obj.variants && obj.variants.full && obj.variants.full.text) || '');
  const candidates = [];

  if (obj.variants && typeof obj.variants === 'object') {
    for (const key of VARIANT_KEYS_LONGEST_FIRST) {
      const v = obj.variants[key];
      const t = v && typeof v.text === 'string' ? v.text : '';
      pushCandidate(candidates, full, t, (v && v.method) || key, n, key);
    }
  }
  if (full) pushCandidate(candidates, full, full, 'full', n, 'full');
  if (obj.snippet) pushCandidate(candidates, full || collapseWs(obj.snippet), obj.snippet, 'snippet', n, 'snippet');

  if (full && full.length > n) {
    const computed = variantForCap(full, n);
    if (computed && computed.text) {
      pushCandidate(candidates, full, computed.text, computed.method, n, 'computed');
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.chars - a.chars || String(a.variantKey).localeCompare(String(b.variantKey)));
  return candidates[0];
}

/**
 * Static drop-don't-mangle: a variant `selectStaticQuoteText` would accept
 * (fits cap, finishes its thought, no introduced ellipsis), or null to drop.
 */
function pickStaticQuote(source, cap) {
  const n = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Number(cap) : STATIC_QUOTE_DEFAULT_CAP;
  const picked = pickQuoteVariant(source, n);
  if (!picked || !picked.text) return null;
  if (!finishesThought(picked.text)) return null;
  return picked;
}

function fitBenefitItem(text, cap = BENEFITS_ITEM_CHAR_CAP) {
  const s = collapseWs(text);
  if (!s) return null;
  if (s.length <= cap) return s;
  const v = variantForCap(s, cap);
  if (v && v.text && !introducedEllipsis(s, v.text)) return v.text;
  return null;
}

/**
 * Flag-on rewrite of video meta copy. Flag-off callers must not invoke this
 * (or must ignore the result) so rendered pixels stay byte-identical.
 *
 * Quote: pick a variant that fits the surface quote cap, or drop the quote.
 * Snippet is forced to the SAME string so the Remotion bind
 * `['quoteSnippet','quote']` cannot re-introduce a longer/shorter clip.
 * Benefits items over 40 chars are fitted without ellipsis or dropped.
 */
function quoteSourceFromMeta(meta) {
  if (!meta) return null;
  if (meta.quote && typeof meta.quote === 'object') return meta.quote;
  const text = typeof meta.quote === 'string' ? meta.quote : '';
  const snippet = meta.quoteSnippet;
  const variants = meta.variants || meta.quoteVariants || null;
  if (!text && !snippet && !variants) return null;
  return { text, snippet, variants };
}

function applyFitBeforeWriteToVideoMeta(meta, { platformFormat, format } = {}) {
  const budgets = videoBudgets(platformFormat, format);
  const events = [];
  const sacrificed = [];
  const quoteCap = budgets.quote;
  const source = quoteSourceFromMeta(meta);

  let quote = collapseWs(source && source.text);
  let quoteSnippet = collapseWs(meta && meta.quoteSnippet);
  const originalQuote = quote || quoteSnippet;

  if (originalQuote && Number.isFinite(quoteCap)) {
    const picked = pickQuoteVariant(source || { text: originalQuote, snippet: quoteSnippet }, quoteCap);
    if (picked && picked.text) {
      if (picked.text !== originalQuote) {
        events.push({
          slot: 'quote',
          kind: 'fit',
          fromChars: originalQuote.length,
          toChars: picked.text.length,
          cap: quoteCap,
          method: picked.method,
        });
      }
      quote = picked.text;
      quoteSnippet = picked.text;
    } else {
      events.push({
        slot: 'quote',
        kind: 'drop',
        fromChars: originalQuote.length,
        toChars: 0,
        cap: quoteCap,
        method: 'none',
      });
      sacrificed.push('quote');
      quote = '';
      quoteSnippet = '';
    }
  }

  const benefitsIn = Array.isArray(meta.benefits) ? meta.benefits : [];
  const benefits = [];
  for (const item of benefitsIn) {
    const fitted = fitBenefitItem(item, budgets.benefitsItem);
    if (fitted) {
      if (fitted !== collapseWs(item) && collapseWs(item).length > budgets.benefitsItem) {
        events.push({
          slot: 'benefits',
          kind: 'fit',
          fromChars: collapseWs(item).length,
          toChars: fitted.length,
          cap: budgets.benefitsItem,
          method: 'variantForCap',
        });
      }
      benefits.push(fitted);
    } else if (collapseWs(item)) {
      events.push({
        slot: 'benefits',
        kind: 'drop',
        fromChars: collapseWs(item).length,
        toChars: 0,
        cap: budgets.benefitsItem,
        method: 'none',
      });
      sacrificed.push('benefits-item');
    }
  }

  return {
    quote: quote || null,
    quoteSnippet: quoteSnippet || null,
    benefits,
    budgets,
    clampFired: events,
    sacrificedRoles: sacrificed,
  };
}

/**
 * Flag-on rewrite of static intent `data`. Quote is drop-don't-mangle
 * (pickStaticQuote, or empty). Does not invent a headline cap.
 */
function applyFitBeforeWriteToStaticData(data, surface) {
  const budgets = staticBudgets(surface);
  const events = [];
  const sacrificed = [];
  const next = { ...(data || {}) };
  const rawQuote = next.quote;
  if (rawQuote) {
    const picked = pickStaticQuote(
      typeof rawQuote === 'object' ? rawQuote : { text: rawQuote, snippet: next.quoteSnippet, variants: next.quoteVariants },
      budgets.quote
    );
    const original = collapseWs(typeof rawQuote === 'object' ? (rawQuote.text || rawQuote.snippet) : rawQuote);
    if (picked && picked.text) {
      if (picked.text !== original) {
        events.push({
          slot: 'quote',
          kind: 'fit',
          fromChars: original.length,
          toChars: picked.text.length,
          cap: budgets.quote,
          method: picked.method,
        });
      }
      next.quote = picked.text;
    } else {
      events.push({
        slot: 'quote',
        kind: 'drop',
        fromChars: original.length,
        toChars: 0,
        cap: budgets.quote,
        method: 'none',
      });
      sacrificed.push('CUSTOMER QUOTE');
      next.quote = '';
    }
  }
  return { data: next, clampFired: events, sacrificedRoles: sacrificed, budgets };
}

/**
 * Fire-and-forget clamp telemetry. NEVER awaited. A Mongo/Slack blip must
 * not fail a paid render — same contract as services/adStage.js.
 *
 * Writes Ad.clampTelemetry (declared Mixed on both trees). Slack via
 * alertService.notifyAsync only for clip events (the "Your answer to warm
 * weather…" class). Density drops are recorded, not paged.
 */
function recordClamp(adId, { clampFired, sacrificedRoles } = {}) {
  if (adId == null) return;
  const events = Array.isArray(clampFired) ? clampFired.filter(Boolean) : (clampFired ? [clampFired] : []);
  const roles = Array.isArray(sacrificedRoles) ? sacrificedRoles.filter(Boolean) : [];
  if (!events.length && !roles.length) return;
  const id = String(adId);
  const at = new Date();
  const stamped = events.map((e) => ({
    slot: e.slot || null,
    kind: e.kind || 'clip',
    fromChars: e.fromChars != null ? e.fromChars : null,
    toChars: e.toChars != null ? e.toChars : null,
    cap: e.cap != null ? e.cap : null,
    method: e.method || null,
    at,
  }));

  Promise.resolve().then(() => {
    const Ad = require('../models/Ad');
    return Ad.updateOne(
      { _id: id },
      [{
        $set: {
          clampTelemetry: {
            clampFired: {
              $concatArrays: [
                { $ifNull: ['$clampTelemetry.clampFired', []] },
                stamped,
              ],
            },
            sacrificedRoles: {
              $concatArrays: [
                { $ifNull: ['$clampTelemetry.sacrificedRoles', []] },
                roles,
              ],
            },
            updatedAt: at,
          },
        },
      }]
    );
  }).catch(() => {});

  const hasClip = stamped.some((e) => e.kind === 'clip' || e.kind === 'ellipsis');
  if (hasClip) {
    try {
      require('./alertService').notifyAsync({
        level: 'warn',
        title: 'titling clamp fired (budgeting miss)',
        key: `clamp:${id}`,
        fields: {
          adId: id,
          slots: stamped.map((e) => e.slot).filter(Boolean).join(',') || '(none)',
        },
        detail: JSON.stringify(stamped).slice(0, 1500),
      });
    } catch (_) { /* never escape to a render path */ }
  }
}

function noteIfExceedsCap(adId, slot, text, cap) {
  const s = collapseWs(text);
  if (!s || !Number.isFinite(cap) || cap < 1) return false;
  if (s.length <= cap) return false;
  recordClamp(adId, {
    clampFired: [{
      slot,
      kind: 'clip',
      fromChars: s.length,
      toChars: cap,
      cap,
      method: 'exceeds-deriveCharCap',
    }],
  });
  return true;
}

module.exports = {
  BENEFITS_ITEM_CHAR_CAP,
  STATIC_QUOTE_DEFAULT_CAP,
  FORMAT_FOR_SURFACE,
  isFitBeforeWriteEnabled,
  formatForSurface,
  capCtxFor,
  videoBudgets,
  staticBudgets,
  budgetsFor,
  maxTextElementsFor,
  variantForCap,
  pickQuoteVariant,
  pickStaticQuote,
  fitBenefitItem,
  introducedEllipsis,
  applyFitBeforeWriteToVideoMeta,
  applyFitBeforeWriteToStaticData,
  recordClamp,
  noteIfExceedsCap,
};
