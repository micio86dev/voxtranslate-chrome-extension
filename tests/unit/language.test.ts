import { beforeEach, describe, expect, it } from 'vitest';
import {
  catalogueReady,
  FALLBACK_LANGUAGE,
  hydrateCatalogue,
  isSupported,
  languagesForTier,
  normalizeLocale,
  resolveTargetLanguage,
  setCatalogue,
  type Catalogue,
} from '@/preferences/language';

/**
 * The catalogue is SERVED now, so these tests seed it explicitly instead of leaning on a
 * bundled JSON. That is the point of the change — and it makes the assertions honest,
 * since they now run against a fixture the test states rather than against whatever the
 * real 84-language file happens to contain today.
 */
const LEGACY_8 = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh'];

const FIXTURE: Catalogue = {
  regions: ['Europe', 'Asia'],
  languages: [
    { code: 'it', native: 'Italiano', english: 'Italian', region: 'Europe', rtl: false, flag: '🇮🇹' },
    { code: 'en', native: 'English', english: 'English', region: 'Europe', rtl: false, flag: '🇬🇧' },
    { code: 'es', native: 'Español', english: 'Spanish', region: 'Europe', rtl: false, flag: '🇪🇸' },
    { code: 'fr', native: 'Français', english: 'French', region: 'Europe', rtl: false, flag: '🇫🇷' },
    { code: 'de', native: 'Deutsch', english: 'German', region: 'Europe', rtl: false, flag: '🇩🇪' },
    { code: 'pt', native: 'Português', english: 'Portuguese', region: 'Europe', rtl: false, flag: '🇵🇹' },
    { code: 'ja', native: '日本語', english: 'Japanese', region: 'Asia', rtl: false, flag: '🇯🇵' },
    { code: 'zh', native: '中文', english: 'Chinese', region: 'Asia', rtl: false, flag: '🇨🇳' },
    { code: 'pt-BR', native: 'Português (BR)', english: 'Portuguese (Brazil)', region: 'Europe', rtl: false, flag: '🇧🇷' },
  ],
  tiers: {
    standard: LEGACY_8,
    enhanced: LEGACY_8,
    pro: LEGACY_8,
    premium: [...LEGACY_8, 'pt-BR'],
  },
};

beforeEach(() => setCatalogue(FIXTURE));

describe('catalogue hydration', () => {
  it('starts EMPTY rather than guessing, so a stale list can never be shown', () => {
    setCatalogue({ regions: [], languages: [], tiers: {} });
    expect(catalogueReady()).toBe(false);
    expect(isSupported('it')).toBe(false);
    expect(languagesForTier('standard')).toEqual([]);
  });

  it('paints from cache first, then replaces it with the network answer', async () => {
    setCatalogue({ regions: [], languages: [], tiers: {} });
    const cached: Catalogue = { ...FIXTURE, tiers: { standard: ['it'] } };
    let stored: Record<string, unknown> = {};
    await hydrateCatalogue(async () => FIXTURE, {
      get: async () => ({ 'vox.languageCatalogue': cached }),
      set: async (items) => {
        stored = items as Record<string, unknown>;
      },
    });
    expect(languagesForTier('standard')).toEqual(FIXTURE.tiers.standard);
    expect(stored['vox.languageCatalogue']).toEqual(FIXTURE);
  });

  it('keeps the cached catalogue when the network fails', async () => {
    setCatalogue({ regions: [], languages: [], tiers: {} });
    await hydrateCatalogue(
      async () => {
        throw new Error('offline');
      },
      { get: async () => ({ 'vox.languageCatalogue': FIXTURE }), set: async () => {} },
    );
    // Offline degrades to slightly stale, never to "no languages at all".
    expect(catalogueReady()).toBe(true);
    expect(isSupported('it')).toBe(true);
  });
});

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
    // The REAL invariant is asserted on the Rust side (engine/langmap.rs) against the
    // actual catalogue. It used to be mirrored here because this repo carried a copy of
    // that file; now the catalogue is served, so all this can honestly check is that the
    // reader surfaces a tier list faithfully. Kept because the reader is what the picker
    // depends on.
    const legacy = LEGACY_8;
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
