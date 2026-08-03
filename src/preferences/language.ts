/**
 * Target-language selection.
 *
 * The catalogue is SERVED, not shipped. It used to be a copy of the main repo's
 * `languages.json`, kept in step by a `sync:langs` script — and a copy maintained by
 * ritual drifts the moment someone forgets to run it. The tier lists decide which
 * languages a user is offered, so a stale copy either offers languages the engine cannot
 * speak or hides ones it can. Both failures are silent.
 *
 * `GET /api/languages` is now the single authority. It is fetched once and cached in
 * `chrome.storage.local`, so the getters below stay synchronous for their callers; a
 * cache is not a copy, because it can only ever be a stale render of the same source and
 * is replaced on the next hydrate.
 *
 * Before the first successful hydrate the catalogue is EMPTY rather than guessed. An
 * empty picker is visibly broken; a bundled fallback would be invisibly wrong.
 */

import { AUTO_LANGUAGE, type LanguageCode } from '@/types/protocol';

export interface Language {
  code: string;
  native: string;
  english: string;
  region: string;
  rtl: boolean;
  flag: string;
}

export interface Catalogue {
  regions: string[];
  languages: Language[];
  tiers: Record<string, string[]>;
}

const EMPTY: Catalogue = { regions: [], languages: [], tiers: {} };
const STORAGE_KEY = 'vox.languageCatalogue';

let CATALOGUE: Catalogue = EMPTY;

/** True once a catalogue is in memory, from the network or the cache. */
export function catalogueReady(): boolean {
  return CATALOGUE.languages.length > 0;
}

/** Replace the in-memory catalogue. Exported for tests and for the cache load. */
export function setCatalogue(next: Catalogue): void {
  CATALOGUE = next;
}

/**
 * Load the catalogue: cached copy first so the picker paints immediately, then the
 * network to refresh it. A failed fetch leaves whatever the cache had, so going offline
 * degrades to "slightly stale" rather than "no languages".
 */
export async function hydrateCatalogue(
  fetchCatalogue: () => Promise<Catalogue>,
  storage: { get(key: string): Promise<Record<string, unknown>>; set(items: object): Promise<void> },
): Promise<void> {
  try {
    const cached = (await storage.get(STORAGE_KEY))[STORAGE_KEY] as Catalogue | undefined;
    if (cached?.languages?.length) CATALOGUE = cached;
  } catch {
    /* an unreadable cache is not a reason to skip the fetch */
  }
  try {
    const fresh = await fetchCatalogue();
    if (fresh?.languages?.length) {
      CATALOGUE = fresh;
      await storage.set({ [STORAGE_KEY]: fresh });
    }
  } catch {
    /* keep the cached catalogue; the next start tries again */
  }
}

/** Final fallback when nothing else resolves. Matches the web client's behaviour. */
export const FALLBACK_LANGUAGE = 'en';

export function allLanguages(): readonly Language[] {
  return CATALOGUE.languages;
}

export function regions(): readonly string[] {
  return CATALOGUE.regions;
}

/** Output languages a given tier can produce (`standard` | `enhanced` | `pro` | `premium`). */
export function languagesForTier(tier: string): readonly string[] {
  return CATALOGUE.tiers[tier] ?? [];
}

export function isSupported(code: string): boolean {
  return CATALOGUE.languages.some((l) => l.code === code);
}

/**
 * Normalise a browser locale to a supported VoxTranslate code.
 *
 * Chrome's `chrome.i18n.getUILanguage()` returns things like `it-IT`, `es-419`, `zh-Hans-CN`.
 * The catalogue is mostly base codes, so we try progressively shorter prefixes: the full
 * tag first (a regional variant may genuinely be listed, e.g. `pt-BR`), then the base.
 *
 * Returns null when nothing matches, so callers decide the fallback explicitly rather
 * than silently receiving English.
 */
export function normalizeLocale(raw: string | null | undefined): LanguageCode | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned) return null;

  const parts = cleaned.split('-').filter(Boolean);
  if (parts.length === 0) return null;

  // Longest match first: `zh-hans-cn` → `zh-hans-cn`, `zh-hans`, `zh`.
  for (let end = parts.length; end >= 1; end--) {
    const candidate = parts.slice(0, end).join('-');
    const hit = CATALOGUE.languages.find((l) => l.code.toLowerCase() === candidate);
    if (hit) return hit.code;
  }
  return null;
}

/**
 * Resolve the target language to use, in priority order:
 *   1. the account preference stored on the backend (cross-device source of truth),
 *   2. the browser UI language, normalised,
 *   3. `en`.
 *
 * Anything unsupported at any step is skipped rather than passed through, so we never
 * ask the backend to translate into a language no engine can produce.
 */
export function resolveTargetLanguage(input: {
  accountPreference?: string | null;
  uiLanguage?: string | null;
}): LanguageCode {
  const pref = input.accountPreference?.trim();
  if (pref && pref !== AUTO_LANGUAGE && isSupported(pref)) return pref;

  const fromBrowser = normalizeLocale(input.uiLanguage);
  if (fromBrowser) return fromBrowser;

  return FALLBACK_LANGUAGE;
}
