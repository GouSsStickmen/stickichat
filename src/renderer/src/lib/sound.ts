import { Settings, SoundChoice } from '../types'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'

let ctx: AudioContext | null = null
const lastPlayed: Record<string, number> = {}

type Note = { freq: number; start: number; dur: number; type: OscillatorType }

import { SoundPreset } from '../types'

const PRESETS: Record<SoundPreset, Note[]> = {
  ping: [
    { freq: 660, start: 0, dur: 0.25, type: 'sine' },
    { freq: 880, start: 0.09, dur: 0.25, type: 'sine' }
  ],
  pop: [
    { freq: 520, start: 0, dur: 0.09, type: 'sine' },
    { freq: 300, start: 0.05, dur: 0.12, type: 'sine' }
  ],
  bell: [
    { freq: 1318, start: 0, dur: 0.55, type: 'triangle' },
    { freq: 1976, start: 0.02, dur: 0.4, type: 'triangle' },
    { freq: 659, start: 0, dur: 0.6, type: 'sine' }
  ],
  // gentle ascending three-note chime
  chime: [
    { freq: 784, start: 0, dur: 0.3, type: 'sine' },
    { freq: 1047, start: 0.1, dur: 0.3, type: 'sine' },
    { freq: 1319, start: 0.2, dur: 0.42, type: 'sine' }
  ],
  // one short high blip
  blip: [{ freq: 1200, start: 0, dur: 0.08, type: 'sine' }],
  // two low wooden thuds
  knock: [
    { freq: 180, start: 0, dur: 0.09, type: 'square' },
    { freq: 150, start: 0.13, dur: 0.11, type: 'square' }
  ],
  // classic two-note coin pickup
  coin: [
    { freq: 988, start: 0, dur: 0.08, type: 'square' },
    { freq: 1319, start: 0.07, dur: 0.3, type: 'square' }
  ],
  // quick upward chirp
  chirp: [
    { freq: 900, start: 0, dur: 0.06, type: 'sine' },
    { freq: 1500, start: 0.05, dur: 0.12, type: 'sine' }
  ],
  // low buzzy alert (good for errors)
  buzz: [
    { freq: 220, start: 0, dur: 0.18, type: 'sawtooth' },
    { freq: 175, start: 0.07, dur: 0.2, type: 'sawtooth' }
  ]
}

function playPreset(kind: SoundPreset, volume: number): void {
  ctx ??= new AudioContext()
  const t0 = ctx.currentTime
  const peak = 0.02 + 0.16 * volume
  for (const n of PRESETS[kind]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = n.type
    osc.frequency.value = n.freq
    gain.gain.setValueAtTime(0, t0 + n.start)
    gain.gain.linearRampToValueAtTime(peak, t0 + n.start + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0 + n.start)
    osc.stop(t0 + n.start + n.dur + 0.05)
  }
}

interface AlertSoundOpts {
  type: SoundChoice
  volume: number
  data?: string
}

/** Plays an alert sound. Each `throttleKey` gets its own 2s anti-spam cooldown. `force` skips it (for previews). */
function playAlertSound(opts: AlertSoundOpts, throttleKey: string, force = false): void {
  // global mute (except explicit previews from the settings UI)
  if (!force && useSettingsStore.getState().settings.muted) return
  const now = Date.now()
  if (!force && now - (lastPlayed[throttleKey] ?? 0) < 2000) return
  lastPlayed[throttleKey] = now
  const volume = Math.max(0, Math.min(1, opts.volume ?? 0.5))
  if (volume === 0) return
  try {
    if (opts.type === 'custom' && opts.data) {
      const audio = new Audio(opts.data)
      audio.volume = volume
      audio.addEventListener('error', () => {
        useUiStore.getState().toast('Не вдалося відтворити звук — файл пошкоджений або формат не підтримується', 'error')
      })
      audio.play().catch((err) => {
        useUiStore.getState().toast(`Не вдалося відтворити звук: ${String(err?.message ?? err)}`, 'error')
      })
      return
    }
    playPreset(opts.type === 'custom' ? 'ping' : opts.type, volume)
  } catch {
    /* audio unavailable */
  }
}

export function playMentionSound(
  s: Pick<Settings, 'mentionSoundType' | 'mentionSoundVolume' | 'mentionSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.mentionSoundCustomId)?.data
  playAlertSound({ type: s.mentionSoundType, volume: s.mentionSoundVolume, data }, 'mention', force)
}

export function playFirstMessageSound(
  s: Pick<Settings, 'firstMessageSoundType' | 'firstMessageSoundVolume' | 'firstMessageSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.firstMessageSoundCustomId)?.data
  playAlertSound({ type: s.firstMessageSoundType, volume: s.firstMessageSoundVolume, data }, 'first-message', force)
}

export function playKeywordSound(
  s: Pick<Settings, 'keywordSoundType' | 'keywordSoundVolume' | 'keywordSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.keywordSoundCustomId)?.data
  playAlertSound({ type: s.keywordSoundType, volume: s.keywordSoundVolume, data }, 'keyword', force)
}

export function playStreamUpSound(
  s: Pick<Settings, 'streamUpSoundType' | 'streamUpSoundVolume' | 'streamUpSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.streamUpSoundCustomId)?.data
  playAlertSound({ type: s.streamUpSoundType, volume: s.streamUpSoundVolume, data }, 'stream-up', force)
}

export function playRaidSound(
  s: Pick<Settings, 'raidSoundType' | 'raidSoundVolume' | 'raidSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.raidSoundCustomId)?.data
  playAlertSound({ type: s.raidSoundType, volume: s.raidSoundVolume, data }, 'raid', force)
}

export function playWhisperSound(
  s: Pick<Settings, 'whisperSoundType' | 'whisperSoundVolume' | 'whisperSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.whisperSoundCustomId)?.data
  playAlertSound({ type: s.whisperSoundType, volume: s.whisperSoundVolume, data }, 'whisper', force)
}

/**
 * Plays the error-notification sound. Reads settings itself (called from the toast dispatcher,
 * which has no settings in scope) and no-ops unless `errorSound` is on. The 2s throttle on the
 * 'error' key also stops a failed error sound from looping via its own error toast.
 */
export function playErrorSound(force = false): void {
  const s = useSettingsStore.getState().settings
  if (!force && !s.errorSound) return
  const data = s.customSounds.find((c) => c.id === s.errorSoundCustomId)?.data
  playAlertSound({ type: s.errorSoundType, volume: s.errorSoundVolume, data }, 'error', force)
}
