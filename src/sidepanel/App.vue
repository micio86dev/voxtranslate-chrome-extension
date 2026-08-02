<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useSession } from './store';
import { buyCreditsUrl } from '@/shared/config';
import { userMessageFor } from '@/shared/errors';
import { allLanguages, languagesForTier } from '@/preferences/language';
import { estimateRemainingMinutes, formatDuration, formatUsd } from '@/usage/meter';

const session = useSession();
const state = session.state;

onMounted(async () => {
  await session.init();
  // Returning from a purchase on voxtranslate.app should show the new balance.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') session.refreshAccount();
  });
});

const isActive = computed(() =>
  ['requesting_capture', 'connecting', 'streaming', 'reconnecting'].includes(state.value.session),
);
const isBusy = computed(() =>
  ['authenticating', 'requesting_capture', 'connecting', 'stopping'].includes(state.value.session),
);
const loggedIn = computed(() => state.value.account !== null);

/**
 * Tiers this extension can actually deliver.
 *
 * A `client_direct` tier (Cartesia "Enhanced") runs the provider in the BROWSER — the
 * server never produces its audio, so an extension session silently falls back to the
 * default engine. Offering it here would let the user pick a tier and quietly get a
 * different one, which is worse than not offering it.
 */
const usableEngines = computed(() =>
  (state.value.account?.engines ?? []).filter((e) => !e.capabilities.client_direct),
);

const selectedEngine = computed(() =>
  usableEngines.value.find((e) => e.id === state.value.preferences.engineId),
);

/** Only offer languages the selected tier can actually produce. */
const targetLanguages = computed(() => {
  const tier = selectedEngine.value?.tier;
  const allowed = tier ? new Set(languagesForTier(tier)) : null;
  return allLanguages().filter((l) => !allowed || allowed.has(l.code));
});

/**
 * Whether the SERVER streams the translated voice for this tier.
 *
 * Not the same as "you can hear it". Standard's voice is synthesised on the device — its
 * own description says so — so every tier can speak; they just differ in where the audio
 * comes from, and therefore in how natural it sounds.
 */
const serverSpeaks = computed(() => selectedEngine.value?.capabilities.translated_audio === true);

const remainingMinutes = computed(() => {
  const rate = selectedEngine.value?.rate_per_minute;
  if (rate === undefined || state.value.account === null) return null;
  return estimateRemainingMinutes(state.value.account.balance, rate);
});

const statusLabel = computed(() => {
  switch (state.value.session) {
    case 'requesting_capture':
      return 'Requesting tab audio…';
    case 'connecting':
      return 'Connecting…';
    case 'streaming':
      return state.value.audioMode === 'bypassed' ? 'Already in your language' : 'Translating';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'stopping':
      return 'Stopping…';
    default:
      return '';
  }
});

function confirmReset(): void {
  const ok = window.confirm(
    'Reset the usage counter?\n\n' +
      'This only resets the displayed total. It does not restore credit or delete billing history.',
  );
  if (ok) session.resetCounter();
}

function openBuyCredits(): void {
  void chrome.tabs.create({ url: buyCreditsUrl() });
}
</script>

<template>
  <main class="panel">
    <header class="header">
      <h1>VoxTranslate</h1>
      <span v-if="isActive" class="badge" :class="{ bypass: state.audioMode === 'bypassed' }">
        {{ statusLabel }}
      </span>
    </header>

    <!-- Logged out -->
    <section v-if="!loggedIn" class="card">
      <p class="lede">
        Understand any video or podcast in your language. VoxTranslate listens to the audio in your
        current tab and shows live translated subtitles.
      </p>
      <button class="primary" :disabled="isBusy" @click="session.login()">
        {{ state.session === 'authenticating' ? 'Signing in…' : 'Log in with VoxTranslate' }}
      </button>
      <p class="fine">
        Audio is captured only while a session is running, and only from the tab you choose. Nothing
        is captured until you press Start.
      </p>
      <p v-if="state.errorCode" class="error">
        {{ userMessageFor(state.errorCode) }}
      </p>
    </section>

    <template v-else>
      <!-- Account -->
      <section class="card account">
        <div class="who">
          <strong>{{ state.account?.user.name }}</strong>
          <span class="muted">{{ state.account?.user.email }}</span>
        </div>
        <div class="balance">
          <span class="figure">{{ formatUsd(state.account?.balance ?? 0) }}</span>
          <span class="muted">remaining</span>
        </div>
      </section>

      <p v-if="state.lowBalance" class="warn">
        Your balance is running low.
        <template v-if="remainingMinutes !== null">
          About {{ remainingMinutes }} min left at this tier.
        </template>
      </p>

      <!-- Controls -->
      <section class="card">
        <label class="field">
          <span>Translation tier</span>
          <select
            :value="state.preferences.engineId"
            :disabled="isActive"
            @change="
              session.updatePreferences({
                engineId: ($event.target as HTMLSelectElement).value,
              })
            "
          >
            <option v-for="engine in usableEngines" :key="engine.id" :value="engine.id">
              {{ engine.display_name }} — ${{ engine.rate_per_minute.toFixed(3) }}/min{{
                engine.capabilities.translated_audio ? ' · natural voice' : ''
              }}
            </option>
          </select>
        </label>
        <p v-if="isActive" class="fine">Stop the session to change tier.</p>

        <label class="field">
          <span>Spoken language</span>
          <select disabled>
            <option>Auto detect</option>
          </select>
        </label>

        <label class="field">
          <span>Translate into</span>
          <select
            :value="state.preferences.targetLanguage"
            @change="
              session.updatePreferences({
                targetLanguage: ($event.target as HTMLSelectElement).value,
              })
            "
          >
            <option v-for="lang in targetLanguages" :key="lang.code" :value="lang.code">
              {{ lang.flag }} {{ lang.native }}
            </option>
          </select>
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            :checked="state.preferences.subtitlesEnabled"
            @change="
              session.updatePreferences({
                subtitlesEnabled: ($event.target as HTMLInputElement).checked,
              })
            "
          />
          <span>Show subtitles on the page</span>
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            :checked="state.preferences.dualLanguageSubtitles"
            @change="
              session.updatePreferences({
                dualLanguageSubtitles: ($event.target as HTMLInputElement).checked,
              })
            "
          />
          <span>Also show the original language</span>
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="state.preferences.translatedAudioEnabled"
            @change="
              session.updatePreferences({
                translatedAudioEnabled: ($event.target as HTMLInputElement).checked,
              })
            "
          />
          <span>Speak the translation</span>
        </label>
        <p v-if="state.preferences.translatedAudioEnabled && !serverSpeaks" class="fine">
          {{ selectedEngine?.display_name ?? 'This tier' }} speaks with your device's voice. Tiers
          marked “natural voice” are spoken by the translation model itself.
        </p>

        <label class="field">
          <span
            >Original audio volume —
            {{ Math.round(state.preferences.originalAudioVolume * 100) }}%</span
          >
          <input
            type="range"
            min="0"
            max="100"
            :value="Math.round(state.preferences.originalAudioVolume * 100)"
            @input="
              session.updatePreferences({
                originalAudioVolume: Number(($event.target as HTMLInputElement).value) / 100,
              })
            "
          />
        </label>
        <p v-if="state.audioMode === 'bypassed'" class="fine">
          The speaker is already using your language, so the original audio is playing and you are
          not being charged for translation.
        </p>

        <button v-if="!isActive" class="primary" :disabled="isBusy" @click="session.start()">
          Start translating this tab
        </button>
        <button v-else class="danger" @click="session.stop()">Stop</button>
        <p v-if="!isActive && state.errorCode === 'capture_needs_gesture'" class="fine">
          Chrome only lets an extension capture a tab it was opened on — clicking the toolbar icon
          is what grants that, and it has to be done on the tab you want translated.
        </p>
      </section>

      <!-- Usage -->
      <section class="card usage">
        <div class="row">
          <span>This session</span>
          <span>
            <strong>{{ formatUsd(state.usage.sessionSpent) }}</strong>
            <span class="muted"> · {{ formatDuration(state.usage.sessionSeconds) }}</span>
          </span>
        </div>
        <div class="row">
          <span>Since reset</span>
          <strong>{{ formatUsd(state.usage.sinceReset) }}</strong>
        </div>
        <div class="row">
          <span>Remaining</span>
          <strong>{{ formatUsd(state.usage.remaining) }}</strong>
        </div>
        <div class="actions">
          <button class="link" @click="confirmReset()">Reset usage counter</button>
          <button class="link" @click="session.refreshAccount(true)">Refresh</button>
        </div>
      </section>

      <button class="secondary" @click="openBuyCredits()">Buy more credit</button>

      <p v-if="state.errorCode" class="error">
        {{ userMessageFor(state.errorCode) }}
      </p>

      <footer class="footer">
        <button class="link" @click="session.logout()">Log out</button>
      </footer>
    </template>
  </main>
</template>
