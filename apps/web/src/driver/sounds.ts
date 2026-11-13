// KiriGo's own alert sounds while the driver app is open. Android only plays the KiriGo sounds by itself when the app
// is closed or in the background (the notification channels); while it's open, alerts come straight to the app, so
// the app plays them here. Same files as the Android channels (android-config/res/raw), served from /sounds/.
const FILES = { offer: '/sounds/kirigo_offer.ogg', job: '/sounds/kirigo_job.ogg' } as const;
export type Sound = keyof typeof FILES;

const players: Partial<Record<Sound, HTMLAudioElement>> = {};
const lastRang: Partial<Record<Sound, number>> = {};
const player = (s: Sound) => (players[s] ??= Object.assign(new Audio(FILES[s]), { preload: 'auto' }));

/** Play an alert. One alert can arrive by socket and by Firebase at once, so a sound rings at most once in 3 seconds. */
export function ring(s: Sound) {
  const now = Date.now();
  if (now - (lastRang[s] ?? 0) < 3000) return;
  lastRang[s] = now;
  try { const a = player(s); a.currentTime = 0; void a.play().catch(() => {}); } catch { /* no audio */ }
  try { navigator.vibrate?.(s === 'offer' ? [400, 200, 400, 200, 400] : [250]); } catch { /* no vibration */ }
}

/**
 * Browsers only let a page play sound after the person has tapped it. The first tap anywhere loads both sounds
 * silently, so the first offer that comes in later can ring.
 */
export function unlockSounds() {
  const go = () => {
    window.removeEventListener('pointerdown', go);
    for (const s of Object.keys(FILES) as Sound[]) {
      const a = player(s);
      a.muted = true;
      void a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    }
  };
  window.addEventListener('pointerdown', go);
}
