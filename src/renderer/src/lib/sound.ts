import { Settings } from '../types'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'

let ctx: AudioContext | null = null
const lastPlayed: Record<string, number> = {}

type Note = { freq: number; start: number; dur: number; type: OscillatorType }

const PRESETS: Record<'ping' | 'pop' | 'bell', Note[]> = {
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
  ]
}

function playPreset(kind: 'ping' | 'pop' | 'bell', volume: number): void {
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
  type: 'ping' | 'pop' | 'bell' | 'custom'
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

export function playWhisperSound(
  s: Pick<Settings, 'whisperSoundType' | 'whisperSoundVolume' | 'whisperSoundCustomId' | 'customSounds'>,
  force = false
): void {
  const data = s.customSounds.find((c) => c.id === s.whisperSoundCustomId)?.data
  playAlertSound({ type: s.whisperSoundType, volume: s.whisperSoundVolume, data }, 'whisper', force)
}
