import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LANGUAGE,
  isSupported,
  languagesForTier,
  normalizeLocale,
  resolveTargetLanguage,
} from '@/preferences/language';

describe('locale normalisation', () => {
  it('normalises common Chrome UI locales to supported codes', () => {
    expect(normalizeLocale('it-IT')).toBe('it');
    expect(normalizeLocale('es-ES')).toBe('es');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr-CA')).toBe('fr');
  });

  it('is case- and separator-insensitive', () => {
    expect(normalizeLocale('IT_it')).toBe('it');
    expect(normalizeLocale('  DE-de  ')).toBe('de');
  });

  it('handles empty and malformed input without throwing', () => {
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale('   ')).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale('---')).toBeNull();
  });

  it('returns null for a language VoxTranslate does not support', () => {
    expect(normalizeLocale('xx-YY')).toBeNull();
  });

  it('falls back from a script/region subtag to the base language', () => {
    // zh-Hans-CN is not in the catalogue as such; zh is.
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh');
  });
});

describe('target language resolution', () => {
  it('prefers the account preference above everything', () => {
    expect(resolveTargetLanguage({ accountPreference: 'ja', uiLanguage: 'it-IT' })).toBe('ja');
  });

  it('falls back to the browser UI language when no preference is stored', () => {
    expect(resolveTargetLanguage({ accountPreference: null, uiLanguage: 'it-IT' })).toBe('it');
  });

  it('ignores an "auto" preference — auto is a SOURCE mode, never a target', () => {
    expect(resolveTargetLanguage({ accountPreference: 'auto', uiLanguage: 'de-DE' })).toBe('de');
  });

  it('ignores an unsupported stored preference rather than passing it to the backend', () => {
    expect(resolveTargetLanguage({ accountPreference: 'xx', uiLanguage: 'fr-FR' })).toBe('fr');
  });

  it('ends at the documented fallback when nothing resolves', () => {
    expect(resolveTargetLanguage({ accountPreference: null, uiLanguage: 'xx-YY' })).toBe(
      FALLBACK_LANGUAGE,
    );
    expect(resolveTargetLanguage({})).toBe(FALLBACK_LANGUAGE);
  });
});

describe('tier language catalogue', () => {
  it('exposes a non-empty list for every shipped tier', () => {
    for (const tier of ['standard', 'enhanced', 'pro', 'premium']) {
      expect(languagesForTier(tier).length).toBeGreaterThan(0);
    }
  });

  it('returns an empty list for an unknown tier instead of throwing', () => {
    expect(languagesForTier('nope')).toEqual([]);
  });

  it('keeps every tier a superset of the legacy 8 languages', () => {
    // Mirrors the invariant asserted on the Rust side (engine/langmap.rs), so a
    // catalogue re-sync that breaks it fails here too.
    const legacy = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh'];
    for (const tier of ['standard', 'enhanced', 'pro', 'premium']) {
      const langs = languagesForTier(tier);
      for (const code of legacy) {
        expect(langs, `${tier} must contain ${code}`).toContain(code);
      }
    }
  });

  it('agrees with isSupported', () => {
    expect(isSupported('en')).toBe(true);
    expect(isSupported('definitely-not-a-language')).toBe(false);
  });
});

describe('buy-credits link', () => {
  it('deep-links to the app modal, not a non-existent billing page', async () => {
    const { buyCreditsUrl } = await import('@/shared/config');
    const url = new URL(buyCreditsUrl());
    // `/billing` 404s — purchasing is a modal inside the app, opened by `?buy=1`.
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('buy')).toBe('1');
    expect(url.searchParams.get('source')).toBe('chrome-extension');
  });
});
