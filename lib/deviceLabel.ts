/**
 * Device label — friendly browser-identity string shown on the paired phone's
 * Accept dialog ("ComputerCaller is trying to connect from [label]").
 *
 * Two sources, in priority order:
 *   1. localStorage override (`cc_device_label`) — set by user via Settings.
 *   2. Auto-derived from navigator.userAgentData (UA-CH) when available,
 *      with navigator.userAgent regex as fallback.
 *
 * The async path (UA-CH high-entropy hints) is preferred because it returns
 * a more accurate platform version (e.g. "Windows 11" vs the UA string's
 * "Windows NT 10.0" which is identical for Win 10 and Win 11). We prime the
 * cache on hook mount; the sync read at click time hits the cache if it's
 * resolved, falls back to UA parsing otherwise.
 *
 * SSR-safe: every function guards `typeof window === 'undefined'` and
 * `typeof navigator === 'undefined'`. localStorage access wrapped in
 * try/catch for private-mode SecurityError tolerance.
 */

export const DEVICE_LABEL_KEY = 'cc_device_label';

/** Max length stored / sent. Notification UI on most Android OEMs truncates
 *  beyond ~60 chars in the body, so we cap at the source. */
const MAX_LABEL_LEN = 60;

/** Cached UA-CH result. Populated by the first getDeviceLabel() call. */
let cachedAsyncLabel: string | null = null;

interface UADataBrand {
  brand: string;
  version: string;
}
interface UserAgentData {
  brands?: UADataBrand[];
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platform?: string;
    platformVersion?: string;
    architecture?: string;
    model?: string;
    fullVersionList?: UADataBrand[];
  }>;
}

/** Strip control chars + trim + cap length. Never returns empty: caller decides
 *  whether empty input falls through to auto-detect or generic fallback. */
function sanitize(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  return stripped.length > MAX_LABEL_LEN ? stripped.slice(0, MAX_LABEL_LEN) : stripped;
}

/** Read the user's stored override, or null if unset/empty/inaccessible. */
export function getDeviceLabelOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_LABEL_KEY);
    if (!raw) return null;
    const cleaned = sanitize(raw);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/** Persist a user-supplied label. Empty/whitespace input clears the override. */
export function setDeviceLabelOverride(label: string): void {
  if (typeof window === 'undefined') return;
  const cleaned = sanitize(label);
  try {
    if (cleaned.length === 0) {
      window.localStorage.removeItem(DEVICE_LABEL_KEY);
    } else {
      window.localStorage.setItem(DEVICE_LABEL_KEY, cleaned);
    }
  } catch {
    // Private-mode / disabled storage — swallow. The next pairing will use
    // the auto-detected label, which is the same UX as if save had worked
    // but the user came back and never reopened the override.
  }
}

/** Explicit clear — distinct from setDeviceLabelOverride('') only for clarity
 *  at call sites. */
export function clearDeviceLabelOverride(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DEVICE_LABEL_KEY);
  } catch {
    // ignore
  }
}

/** Parse a User-Agent string into "Browser on Platform". Best-effort regex
 *  pattern matching — covers Chrome / Edge / Firefox / Safari on the four
 *  major desktop platforms + iOS + Android. Unknown combinations fall back
 *  to "Browser on Unknown" rather than throwing. */
function deriveFromUserAgent(ua: string): string {
  if (!ua) return 'This computer';

  // Browser — order matters: Edge ships an Edg/ token AND a Chrome/ token,
  // so check Edge before Chrome. Same for Opera (OPR/), but we don't bother
  // splitting Opera out — falls through to Chrome.
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';

  // Platform — iPad-on-iOS-13+ reports as Macintosh, but we don't have
  // enough signal here to disambiguate; treat as macOS, which is harmless.
  let platform = 'Unknown';
  if (/Windows NT/.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) platform = 'macOS';
  else if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/iPad/.test(ua)) platform = 'iPad';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/Linux/.test(ua)) platform = 'Linux';

  return sanitize(`${browser} on ${platform}`);
}

/**
 * Synchronous label getter — safe to call from a click handler. Returns:
 *   - cached UA-CH result if getDeviceLabel() has resolved
 *   - else UA-string fallback
 *   - never empty / never throws
 *
 * Does NOT consult the localStorage override — callers that want override
 * precedence must check getDeviceLabelOverride() first. We keep this split
 * so the Settings UI can show "(auto-detected: X)" while the override is
 * being edited.
 */
export function getDeviceLabelSync(): string {
  if (cachedAsyncLabel) return cachedAsyncLabel;
  if (typeof navigator === 'undefined') return 'This computer';
  return deriveFromUserAgent(navigator.userAgent || '');
}

/**
 * Async label getter — preferred when called early (hook mount). Resolves
 * the cache so subsequent sync reads hit it. Always resolves to a non-empty
 * string. Idempotent.
 */
export async function getDeviceLabel(): Promise<string> {
  if (cachedAsyncLabel) return cachedAsyncLabel;
  if (typeof navigator === 'undefined') return 'This computer';

  const nav = navigator as Navigator & { userAgentData?: UserAgentData };
  const uaData = nav.userAgentData;

  // UA-CH path. Browsers without UA-CH (Firefox, Safari) leave userAgentData
  // undefined — fall through to UA string.
  if (uaData?.getHighEntropyValues && uaData.brands) {
    try {
      const hints = await uaData.getHighEntropyValues(['platform', 'platformVersion']);
      const platform = hints.platform || uaData.platform || '';
      const platformVersion = hints.platformVersion || '';
      // Pick a "primary" brand — UA-CH lists all three (browser, Chromium,
      // Not A Brand) in randomized order. Skip the GREASE entries.
      const primaryBrand = uaData.brands.find(
        (b) => !/Not.*Brand|Chromium/i.test(b.brand)
      )?.brand;

      if (primaryBrand) {
        let platformLabel = platform || 'Unknown';
        // Windows 11 detection — UA-CH reports platformVersion >= 13.0.0
        // for Windows 11 (the major version 13 corresponds to NT 10.0
        // build 22000+). See https://learn.microsoft.com/en-us/microsoft-edge/web-platform/user-agent-guidance
        if (platform === 'Windows' && platformVersion) {
          const major = parseInt(platformVersion.split('.')[0] || '0', 10);
          platformLabel = major >= 13 ? 'Windows 11' : 'Windows 10';
        } else if (platform && platformVersion) {
          const majorVer = platformVersion.split('.')[0];
          if (majorVer && majorVer !== '0') {
            platformLabel = `${platform} ${majorVer}`;
          }
        }
        cachedAsyncLabel = sanitize(`${primaryBrand} on ${platformLabel}`);
        return cachedAsyncLabel;
      }
    } catch {
      // getHighEntropyValues may reject if the user-agent reduction policy
      // blocks high-entropy hints. Fall through to UA-string path.
    }
  }

  cachedAsyncLabel = deriveFromUserAgent(navigator.userAgent || '');
  return cachedAsyncLabel;
}

/**
 * Convenience — the value the pairing handshake should send. Override beats
 * sync auto-detected. Always non-empty.
 */
export function getEffectiveDeviceLabel(): string {
  return getDeviceLabelOverride() ?? getDeviceLabelSync();
}
