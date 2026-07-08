import { en, TranslationKey } from './en'
import { uk } from './uk'
import { useSettingsStore } from '../store/settings'

const dictionaries: Record<'en' | 'uk', Record<TranslationKey, string>> = { en, uk }

export function translate(
  lang: 'en' | 'uk',
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  let s = dictionaries[lang][key] ?? en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}

/** Reactive translation hook */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  const lang = useSettingsStore((s) => s.settings.language)
  return (key, vars) => translate(lang, key, vars)
}

export type { TranslationKey }
