import { useSettingsStore } from '../store/settings'

/**
 * Twitch API / chat errors arrive as English strings. When the UI language is Ukrainian,
 * map the common ones to a clear Ukrainian explanation; unknown ones are wrapped so it's
 * at least obvious that it IS an error and where it came from.
 */
const RULES: { match: RegExp; uk: string }[] = [
  { match: /invalid oauth|token.*(invalid|expired)|unauthorized|401/i, uk: 'Токен недійсний або протермінований — переавторизуй акаунт у Налаштування → Акаунти' },
  { match: /missing scope|scope/i, uk: 'Бракує дозволу для цієї дії — переавторизуй акаунт у Налаштування → Акаунти' },
  { match: /not.*moderator|insufficient privileges|requires a moderator/i, uk: 'Немає прав модератора на цьому каналі' },
  { match: /msg.duplicate|identical/i, uk: 'Twitch відхилив: однакове повідомлення двічі поспіль' },
  { match: /slow mode/i, uk: 'Повільний режим — зачекай перед наступним повідомленням' },
  { match: /followers.only/i, uk: 'Чат лише для фоловерів' },
  { match: /subscribers.only|subs.only/i, uk: 'Чат лише для сабскрайберів' },
  { match: /emote.only/i, uk: 'Чат лише для емоутів' },
  { match: /banned/i, uk: 'Тебе забанено в цьому чаті' },
  { match: /timed out/i, uk: 'Ти в таймауті в цьому чаті' },
  { match: /rate limit|too many requests|429/i, uk: 'Забагато запитів — Twitch тимчасово обмежив, спробуй за хвилину' },
  { match: /not streaming|is offline/i, uk: 'Стример зараз не в етері' },
  { match: /cooldown/i, uk: 'Дія на кулдауні — спробуй трохи пізніше' },
  { match: /settings prevent.*whisper|whisper.*settings/i, uk: 'Користувач не приймає приватні повідомлення (налаштування приватності)' },
  { match: /verified (phone|email)|phone number/i, uk: 'Twitch вимагає підтверджений телефон/пошту для цієї дії' },
  { match: /may not be raided|raid.*not allowed/i, uk: 'Цей канал не можна рейдити' },
  { match: /user.*not found|no user/i, uk: 'Користувача не знайдено' },
  { match: /network|fetch failed|timeout|ECONN|ENOTFOUND/i, uk: 'Проблема зі зʼєднанням — перевір інтернет' }
]

/** localize a raw API error message according to the UI language */
export function localizeApiError(raw: string): string {
  const lang = useSettingsStore.getState().settings.language
  if (lang !== 'uk' || !raw) return raw
  for (const r of RULES) {
    if (r.match.test(raw)) return r.uk
  }
  // unknown error: label it clearly and keep the original for reporting
  return `Помилка Twitch: ${raw}`
}
