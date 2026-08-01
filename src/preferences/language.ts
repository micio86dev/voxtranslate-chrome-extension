/**
 * Target-language selection.
 *
 * Source of truth for the catalogue is `server/src/engine/languages.json` in the main
 * VoxTranslate repo; `src/types/languages.json` is a synced copy (see `bun run sync:langs`).
 * Duplicating the *list* would let the picker drift from what the engines can produce, so
 * the file is copied verbatim rather than re-typed.
 */

import catalogue from '@/types/languages.json';
import { AUTO_LANGUAGE, type LanguageCode } from '@/types/protocol';

export interface Language {
  code: string;
  native: string;
  english: string;
  region: string;
  rtl: boolean;
  flag: string;
}

interface Catalogue {
  regions: string[];
  languages: Language[];
  tiers: Record<string, string[]>;
}

const CATALOGUE = catalogue as Catalogue;

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
