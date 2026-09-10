'use strict';
//
// Single owner of the Google Ads REST API version.
//
// REST URLs are major-only: https://googleads.googleapis.com/v25/...
// Minor releases (v25.1) share that path automatically — do NOT put
// `v25.1` in the URL. See
// https://developers.google.com/google-ads/api/docs/concepts/versioning
//
// Chosen default: v25 (released 2026-07-22, sunset August 2027). v19
// sunset 2026-02-11; v20 2026-06-10; v21 2026-08-05; v22 2026-10-07.
// Callers MUST import this module — never inline
// `process.env.GOOGLE_ADS_API_VERSION || 'v…'`.

const DEFAULT_GOOGLE_ADS_API_VERSION = 'v25';
const GOOGLE_ADS_API_VERSION_RE = /^v\d+$/;

// Tripwire only. If the RESOLVED version is listed here, still proceed
// (fail-open) but fire an optional callback so boot can page.
const KNOWN_SUNSET_GOOGLE_ADS = Object.freeze({
  v19: { sunset: '2026-02-11', level: 'fatal' },
  v20: { sunset: '2026-06-10', level: 'fatal' },
  v21: { sunset: '2026-08-05', level: 'fatal' },
  v22: { sunset: '2026-10-07', level: 'warn' },
});

/**
 * Resolve a Google Ads REST major (vN). Malformed env fails OPEN onto
 * the default — a typo must not crash boot. A malformed DEFAULT throws
 * (developer error). Minor-looking values (`v25.1`, `v25_1`) coerce to
 * the major because REST has no minor in the path.
 *
 * @param {string|null|undefined} raw
 * @param {{ defaultVersion?: string, onInvalidEnv?: Function, onKnownSunset?: Function }} [opts]
 * @returns {string}
 */
function resolveGoogleAdsApiVersion(raw, opts = {}) {
  const defaultVersion = (opts.defaultVersion != null)
    ? String(opts.defaultVersion)
    : DEFAULT_GOOGLE_ADS_API_VERSION;

  if (!GOOGLE_ADS_API_VERSION_RE.test(defaultVersion)) {
    throw new Error(
      `Invalid DEFAULT_GOOGLE_ADS_API_VERSION "${defaultVersion}". Expected format vN ` +
      `(e.g. v25). Fix services/googleAdsApiVersion.js — this is a developer error, ` +
      `not a config typo.`
    );
  }

  const trimmed = (raw == null) ? '' : String(raw).trim();
  let version;

  if (trimmed === '') {
    version = defaultVersion;
  } else {
    const minor = trimmed.match(/^v(\d+)[._]\d+$/);
    if (GOOGLE_ADS_API_VERSION_RE.test(trimmed)) {
      version = trimmed;
    } else if (minor) {
      version = `v${minor[1]}`;
    } else {
      if (typeof opts.onInvalidEnv === 'function') {
        try { opts.onInvalidEnv(trimmed, defaultVersion); } catch { /* never block */ }
      }
      version = defaultVersion;
    }
  }

  const sunsetMeta = KNOWN_SUNSET_GOOGLE_ADS[version];
  if (sunsetMeta && typeof opts.onKnownSunset === 'function') {
    try { opts.onKnownSunset(version, sunsetMeta); } catch { /* never block */ }
  }

  return version;
}

function googleAdsApiRoot(version) {
  const v = version || GOOGLE_ADS_API_VERSION;
  return `https://googleads.googleapis.com/${v}`;
}

function alertInvalidEnv(raw, fallback) {
  try {
    const { notifyAsync } = require('./alertService');
    notifyAsync({
      level: 'fatal',
      title: 'GOOGLE_ADS_API_VERSION is malformed — falling back to default',
      detail: `env=${JSON.stringify(raw)} fallback=${fallback}`,
      key: 'google-ads-api-version:invalid-env',
    });
  } catch { /* never block boot */ }
}

function alertKnownSunset(version, meta) {
  try {
    const { notifyAsync } = require('./alertService');
    notifyAsync({
      level: meta.level === 'fatal' ? 'fatal' : 'warn',
      title: `Google Ads API ${version} is sunset or near sunset`,
      detail: `sunset=${meta.sunset}. Bump services/googleAdsApiVersion.js DEFAULT (and GOOGLE_ADS_API_VERSION in config/defaults.env).`,
      fields: { version, sunset: meta.sunset },
      key: `google-ads-api-version:sunset:${version}`,
    });
  } catch { /* never block boot */ }
}

const GOOGLE_ADS_API_VERSION = resolveGoogleAdsApiVersion(
  process.env.GOOGLE_ADS_API_VERSION,
  { onInvalidEnv: alertInvalidEnv, onKnownSunset: alertKnownSunset }
);

module.exports = {
  DEFAULT_GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_API_VERSION_RE,
  KNOWN_SUNSET_GOOGLE_ADS,
  resolveGoogleAdsApiVersion,
  googleAdsApiRoot,
  GOOGLE_ADS_API_VERSION,
};
