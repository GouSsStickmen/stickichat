import React, { useState } from 'react'
import {
  ALERT_ANIMS,
  AlertAnim,
  ChatOverlayConfig,
  EmoteRainOverlayConfig,
  FollowOverlayConfig,
  GoalOverlayConfig,
  OverlayConfig,
  PlateShape,
  RouletteOverlayConfig,
  WheelSection
} from '../types'
import { useSettingsStore } from '../store/settings'
import { nextId } from '../store/layout'
import { ColorField, FontPicker, NickListArea, Toggle } from './settings/SettingsModal'
import { Row, Num, Sec, FillEditor, readFile } from './OverlayEditorWindow'

/** wedge colours a new section cycles through, so a fresh wheel is not four identical slices */
const PALETTE = ['#9147ff', '#12b886', '#ff5c8a', '#ffd75c', '#5cb2ff', '#c95cff', '#5cffe0', '#ff8a5c']

/** what the editor's own title bar calls the overlay it is editing */
const KIND_CHIP: Record<Exclude<OverlayConfig, ChatOverlayConfig>['type'], string> = {
  emotes: '🎉 Святкування',
  goal: '🎯 Ціль',
  follow: '💜 Алерт фолова',
  roulette: '🎡 Рулетка'
}

/** the ready-made plate outlines, in the order they are offered */
const PLATE_SHAPES: { v: PlateShape; label: string }[] = [
  { v: 'rect', label: '▭ Прямокутник' },
  { v: 'pill', label: '⬭ Капсула' },
  { v: 'circle', label: '◯ Коло' },
  { v: 'notch', label: '⬡ Зрізані кути' },
  { v: 'hexagon', label: '⬢ Шестикутник' },
  { v: 'hexflat', label: '⬣ Витягнутий шестикутник' },
  { v: 'ribbon', label: '🎀 Стрічка' },
  { v: 'ticket', label: '🎟 Квиток' },
  { v: 'banner', label: '🚩 Вимпел' },
  { v: 'shield', label: '🛡 Щит' },
  { v: 'tag', label: '🏷 Бирка' },
  { v: 'slant', label: '⏢ Косий' },
  { v: 'blob', label: '🫧 Пляма' }
]

/** the nine points a freely placed part can be measured from */
const ANCHOR9: { v: string; label: string }[] = [
  { v: 'tl', label: '↖ Згори зліва' },
  { v: 'top', label: '↑ Згори' },
  { v: 'tr', label: '↗ Згори справа' },
  { v: 'left', label: '← Зліва' },
  { v: 'center', label: '· По центру' },
  { v: 'right', label: '→ Справа' },
  { v: 'bl', label: '↙ Знизу зліва' },
  { v: 'bottom', label: '↓ Знизу' },
  { v: 'br', label: '↘ Знизу справа' }
]

/**
 * The editors for the overlay kinds that are not chat.
 *
 * They live beside the chat editor rather than inside it because they share none of its subject
 * matter — no plate, no nick, no message — but all of its frame: the same window, the same live
 * preview, the same OBS url and channel picker. That frame is what `OverlayAltEditor` is; the
 * panels below it are just fields.
 */

export interface AltEditorProps {
  /** every kind except chat, which keeps its own editor */
  ov: Exclude<OverlayConfig, ChatOverlayConfig>
  update: (patch: Partial<OverlayConfig>) => void
  channel: string
  setChannel: (c: string) => void
  channels: string[]
  port: number
}

/** the celebration overlay: what sets it off, how many, how they look and how they move */
function EmoteRainPanel({
  ov,
  update
}: {
  ov: EmoteRainOverlayConfig
  update: (patch: Partial<EmoteRainOverlayConfig>) => void
}): React.JSX.Element {
  return (
    <>
      <Sec title="🎬 Що запускає" defaultOpen>
        <Toggle
          label="Емоути з чату"
          hint="Кожне повідомлення з емоутами влаштовує салют."
          value={ov.onChat}
          onChange={(v) => update({ onChat: v })}
        />
        {ov.onChat && (
          <Row label="Не менше емоутів" hint="Скільки емоутів має бути в повідомленні, щоб воно спрацювало. 1 — будь-яке.">
            <Num v={ov.minEmotes} on={(n) => update({ minEmotes: n })} min={1} max={20} w={54} def={1} />
          </Row>
        )}
        <Toggle label="На бітси" value={ov.onBits} onChange={(v) => update({ onBits: v })} />
        {ov.onBits && (
          <Row label="Від скількох бітсів">
            <Num v={ov.bitsMin} on={(n) => update({ bitsMin: n })} min={1} max={100000} w={80} def={100} />
          </Row>
        )}
        <Toggle label="На підписки" value={ov.onSubs} onChange={(v) => update({ onSubs: v })} />
        <Toggle label="На бали каналу" value={ov.onRedeems} onChange={(v) => update({ onRedeems: v })} />
        <Row label="Слова" hint="По одному в рядок. Повідомлення з таким словом запускає салют незалежно від решти умов.">
          <textarea
            value={ov.words}
            spellCheck={false}
            rows={2}
            style={{ width: '100%', resize: 'vertical', minHeight: 34 }}
            onChange={(e) => update({ words: e.target.value })}
          />
        </Row>
        <Row label="Тільки від" hint="Логіни, по одному в рядок. Порожньо — від усіх.">
          <NickListArea value={ov.allowUsers ? ov.allowUsers.split('\n').filter(Boolean) : []} onCommit={(v) => update({ allowUsers: v.join('\n') })} />
        </Row>
      </Sec>

      <Sec title="🔢 Скільки">
        <Row label="Емоутів з повідомлення" hint="Скільки різних емоутів брати з одного повідомлення.">
          <Num v={ov.perMessage} on={(n) => update({ perMessage: n })} min={1} max={20} w={54} def={3} />
        </Row>
        <Row label="Копій кожного">
          <Num v={ov.copies} on={(n) => update({ copies: n })} min={1} max={20} w={54} def={1} />
        </Row>
        <Row label="Максимум за раз" hint="Стеля на один салют, щоб довге повідомлення не завалило екран.">
          <Num v={ov.burstMax} on={(n) => update({ burstMax: n })} min={1} max={200} w={64} def={12} />
        </Row>
        <Row label="Максимум на екрані" hint="Коли межу досягнуто, найстаріший емоут іде, щоб звільнити місце новому.">
          <Num v={ov.maxOnScreen} on={(n) => update({ maxOnScreen: n })} min={1} max={400} w={64} def={60} />
        </Row>
        <Row label="Час життя, с" hint="0 — доки не вилетить за екран.">
          <Num v={ov.lifetimeS} on={(n) => update({ lifetimeS: n })} min={0} max={120} w={54} def={0} />
        </Row>
      </Sec>

      <Sec title="🎨 Вигляд">
        <Row label="Розмір, px" hint="Кожен емоут бере випадковий розмір з цього діапазону.">
          <Num v={ov.sizeMin} on={(n) => update({ sizeMin: n })} min={8} max={600} w={64} def={48} />
          <span className="hint">–</span>
          <Num v={ov.sizeMax} on={(n) => update({ sizeMax: n })} min={8} max={600} w={64} def={96} />
        </Row>
        <Row label="Прозорість">
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round((ov.opacity ?? 1) * 100)}
            onChange={(e) => update({ opacity: Number(e.target.value) / 100 })}
          />
          <span className="hint">{Math.round((ov.opacity ?? 1) * 100)}%</span>
        </Row>
        <Toggle label="Тінь" hint="Щоб світлі емоути було видно на світлій сцені." value={ov.shadow} onChange={(v) => update({ shadow: v })} />
        <Toggle label="Різнокольорові" hint="Кожному емоуту випадковий зсув відтінку." value={ov.rainbow} onChange={(v) => update({ rainbow: v })} />
      </Sec>

      <Sec title="🌀 Рух">
        <Row label="Тип">
          <select value={ov.motion} onChange={(e) => update({ motion: e.target.value as EmoteRainOverlayConfig['motion'] })}>
            <option value="fall">Падають</option>
            <option value="rise">Здіймаються</option>
            <option value="burst">Вибух</option>
            <option value="float">Дрейф</option>
            <option value="fly">Проліт</option>
            <option value="physics">Фізика</option>
          </select>
        </Row>
        <Row label="Звідки">
          <select value={ov.from} onChange={(e) => update({ from: e.target.value as EmoteRainOverlayConfig['from'] })}>
            <option value="top">Згори</option>
            <option value="bottom">Знизу</option>
            <option value="left">Зліва</option>
            <option value="right">Справа</option>
            <option value="random">Випадково</option>
            <option value="center">З центру</option>
          </select>
        </Row>
        <Row label="Швидкість, px/с">
          <Num v={ov.speedMin} on={(n) => update({ speedMin: n })} min={0} max={3000} w={64} def={60} />
          <span className="hint">–</span>
          <Num v={ov.speedMax} on={(n) => update({ speedMax: n })} min={0} max={3000} w={64} def={160} />
        </Row>
        <Row label="Розкид, °" hint="Наскільки напрямок кожного емоута може відхилятись.">
          <Num v={ov.spread} on={(n) => update({ spread: n })} min={0} max={180} w={54} def={30} />
        </Row>
        {ov.motion === 'physics' && (
          <>
            <Row label="Гравітація">
              <Num v={ov.gravity} on={(n) => update({ gravity: n })} min={0} max={5000} w={72} def={900} />
            </Row>
            <Row label="Пружність" hint="Скільки швидкості лишається після удару об підлогу.">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((ov.bounce ?? 0.55) * 100)}
                onChange={(e) => update({ bounce: Number(e.target.value) / 100 })}
              />
              <span className="hint">{Math.round((ov.bounce ?? 0.55) * 100)}%</span>
            </Row>
          </>
        )}
        <Row label="Обертання, °/с" hint="0 — не крутяться. Напрямок у кожного свій.">
          <Num v={ov.spin} on={(n) => update({ spin: n })} min={0} max={1440} w={64} def={90} />
        </Row>
        {ov.motion !== 'physics' && (
          <Row label="Похитування, px">
            <Num v={ov.wobble} on={(n) => update({ wobble: n })} min={0} max={300} w={64} def={24} />
          </Row>
        )}
        <Toggle label="Виростати на появі" value={ov.scaleIn} onChange={(v) => update({ scaleIn: v })} />
        <Toggle label="Згасати наприкінці" hint="Діє, коли задано час життя." value={ov.fadeOut} onChange={(v) => update({ fadeOut: v })} />
      </Sec>
    </>
  )
}

/** the goal overlay: where the number comes from, and what the bar looks like */
function GoalPanel({
  ov,
  update
}: {
  ov: GoalOverlayConfig
  update: (patch: Partial<GoalOverlayConfig>) => void
}): React.JSX.Element {
  const value = Math.max(0, (ov.progress || 0) - (ov.base || 0))
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * A goal that cannot read its number used to just sit at zero, which looks identical to a goal
   * nobody has reached yet. Asking on demand and printing the answer is the difference between
   * "it is broken" and "this account does not moderate that channel".
   */
  const check = async (): Promise<void> => {
    const m = await import('../services/goals')
    setProbe(await m.refreshGoal(ov))
  }
  return (
    <>
      <Sec title="🎯 Ціль" defaultOpen>
        <Row label="Що рахуємо">
          <select value={ov.metric} onChange={(e) => update({ metric: e.target.value as GoalOverlayConfig['metric'] })}>
            <option value="followers">Фоловери</option>
            <option value="subs">Підписки</option>
            <option value="bits">Бітси</option>
            <option value="custom">Вручну</option>
          </select>
        </Row>
        <Row
          label="Джерело"
          hint="«З Twitch» бере справжню суму — так уміють лише фоловери й підписки, і лише для свого каналу. «Події» рахує те, що оголошує чат, від останнього скидання."
        >
          <select
            value={ov.metric === 'bits' || ov.metric === 'custom' ? 'events' : ov.source}
            disabled={ov.metric === 'bits' || ov.metric === 'custom'}
            onChange={(e) => update({ source: e.target.value as GoalOverlayConfig['source'] })}
          >
            <option value="auto">З Twitch</option>
            <option value="events">Події чату</option>
          </select>
        </Row>
        {ov.metric === 'subs' && (
          <Toggle label="Рахувати подаровані" value={ov.countGifts} onChange={(v) => update({ countGifts: v })} />
        )}
        <Row label="Ціль">
          <Num v={ov.target} on={(n) => update({ target: n })} min={1} max={10000000} w={90} def={100} />
        </Row>
        <Row label="Початок відліку" hint="Віднімається від поточного значення. Кнопка поруч ставить сюди те, що зараз.">
          <Num v={ov.base} on={(n) => update({ base: n })} min={0} max={10000000} w={90} def={0} />
          <button onClick={() => update({ base: ov.progress || 0 })} title="Рахувати з цього моменту">
            ↻ Звідси
          </button>
        </Row>
        <div className="set-row">
          <label>Зараз</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>
              {value} / {ov.target}
            </b>
            <button onClick={() => void check()} title="Спитати Twitch просто зараз і показати відповідь">
              ⟳ Перевірити
            </button>
            {(ov.metric === 'bits' || ov.metric === 'custom') && (
              <>
                <button onClick={() => update({ progress: (ov.progress || 0) + 1 })}>+1</button>
                <button onClick={() => update({ progress: Math.max(0, (ov.progress || 0) - 1) })}>−1</button>
                <button className="danger" onClick={() => update({ progress: 0, base: 0 })}>
                  Скинути
                </button>
              </>
            )}
          </div>
        </div>
        {probe && (
          <p className="hint" style={{ margin: '2px 0 0', color: probe.ok ? 'var(--text-faint)' : 'var(--danger, #ff6b6b)' }}>
            {probe.text}
          </p>
        )}
      </Sec>

      <Sec title="✏️ Текст">
        <Toggle label="Заголовок" value={ov.showTitle} onChange={(v) => update({ showTitle: v })} />
        {ov.showTitle && (
          <Row label="Назва">
            <input value={ov.title} onChange={(e) => update({ title: e.target.value })} />
          </Row>
        )}
        <Row label="Числа">
          <select value={ov.numbers} onChange={(e) => update({ numbers: e.target.value as GoalOverlayConfig['numbers'] })}>
            <option value="both">Значення й відсоток</option>
            <option value="value">Значення</option>
            <option value="percent">Відсоток</option>
            <option value="none">Без чисел</option>
          </select>
        </Row>
        <Toggle label="Текст усередині смуги" value={ov.textInside} onChange={(v) => update({ textInside: v })} />
        <Row
          label="Свій текст"
          hint="Заміщає стандартні числа. Підставляються {value} {target} {left} {percent} — наприклад «Ще {left} до цілі!»"
        >
          <input
            value={ov.customText ?? ''}
            placeholder="{value} / {target} · {percent}"
            onChange={(e) => update({ customText: e.target.value })}
          />
        </Row>
        <Row label="Коли досягнуто" hint="Порожньо — просто лишаються числа.">
          <input value={ov.doneText} onChange={(e) => update({ doneText: e.target.value })} />
        </Row>
        <Row label="Шрифт">
          <FontPicker value={ov.font} onChange={(v) => update({ font: v })} />
        </Row>
        <Row label="Розмір">
          <Num v={ov.fontSize} on={(n) => update({ fontSize: n })} min={8} max={120} w={54} def={18} />
        </Row>
        <Row label="Колір тексту">
          <ColorField value={ov.textColor} defaultValue="#ffffff" onChange={(v) => update({ textColor: v })} />
        </Row>
      </Sec>

      <Sec title="📐 Форма">
        <Row label="Вигляд">
          <select value={ov.shape} onChange={(e) => update({ shape: e.target.value as GoalOverlayConfig['shape'] })}>
            <option value="bar">Смуга</option>
            <option value="ring">Кільце</option>
            <option value="text">Тільки текст</option>
          </select>
        </Row>
        {ov.shape !== 'text' && (
          <Row label={ov.shape === 'ring' ? 'Діаметр' : 'Ширина'}>
            <Num v={ov.width} on={(n) => update({ width: n })} min={40} max={2000} w={72} def={420} />
          </Row>
        )}
        {ov.shape === 'bar' && (
          <>
            <Row label="Висота">
              <Num v={ov.height} on={(n) => update({ height: n })} min={4} max={400} w={64} def={34} />
            </Row>
            <Row label="Заокруглення">
              <Num v={ov.radius} on={(n) => update({ radius: n })} min={0} max={200} w={64} def={17} />
            </Row>
          </>
        )}
        {ov.shape === 'ring' && (
          <Row label="Товщина кільця">
            <Num v={ov.ringWidth} on={(n) => update({ ringWidth: n })} min={2} max={120} w={64} def={14} />
          </Row>
        )}
      </Sec>

      <Sec title="🎨 Кольори">
        <Row label="Фон">
          <FillEditor value={ov.trackFill} onChange={(f) => update({ trackFill: f })} />
        </Row>
        <Row label="Заповнення">
          <FillEditor value={ov.barFill} onChange={(f) => update({ barFill: f })} />
        </Row>
        <Row label="Коли досягнуто">
          <FillEditor value={ov.doneFill} onChange={(f) => update({ doneFill: f })} />
        </Row>
        {ov.shape === 'bar' && (
          <>
            <Row label="Рамка">
              <Num v={ov.borderWidth} on={(n) => update({ borderWidth: n })} min={0} max={20} w={54} def={0} />
              <ColorField value={ov.borderColor} defaultValue="#ffffff" onChange={(v) => update({ borderColor: v })} />
            </Row>
          </>
        )}
        <Row label="Сяйво">
          <Num v={ov.glowSize} on={(n) => update({ glowSize: n })} min={0} max={80} w={54} def={0} />
          <ColorField value={ov.glowColor} defaultValue="#9147ff" onChange={(v) => update({ glowColor: v })} />
        </Row>
        <Toggle
          label="Рамка і сяйво за заливкою"
          hint="Якщо смуга градієнтна — рамка і сяйво беруть той самий градієнт замість одного плаского кольору."
          value={!!ov.fxFromFill}
          onChange={(v) => update({ fxFromFill: v })}
        />
        <Row label="Плавність, мс" hint="Скільки часу смуга їде до нового значення.">
          <Num v={ov.animMs} on={(n) => update({ animMs: n })} min={0} max={4000} w={72} def={600} />
        </Row>
      </Sec>

      <Sec title="🖼 Картинка">
        <Row label="Файл" hint="PNG, GIF або WebP. Анімовані лишаються анімованими.">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 3, (url) => update({ image: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.image && <img src={ov.image} alt="" style={{ height: 28, borderRadius: 4 }} />}
            {ov.image && (
              <button className="danger" onClick={() => update({ image: '' })}>
                ✕
              </button>
            )}
          </div>
        </Row>
        {!!ov.image && (
          <>
            <Row label="Де">
              <select
                value={ov.imagePlace}
                onChange={(e) => update({ imagePlace: e.target.value as GoalOverlayConfig['imagePlace'] })}
              >
                <option value="left">Зліва від смуги</option>
                <option value="right">Справа від смуги</option>
                <option value="above">Над смугою</option>
                <option value="below">Під смугою</option>
                <option value="inLeft">Усередині, зліва</option>
                <option value="inRight">Усередині, справа</option>
                <option value="fill">Тлом на всю смугу</option>
              </select>
            </Row>
            {ov.imagePlace !== 'fill' && (
              <Row label="Висота">
                <Num v={ov.imageSize} on={(n) => update({ imageSize: n })} min={8} max={400} w={64} def={56} />
              </Row>
            )}
            <Row label="Прозорість">
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((ov.imageOpacity ?? 1) * 100)}
                onChange={(e) => update({ imageOpacity: Number(e.target.value) / 100 })}
              />
              <span className="hint">{Math.round((ov.imageOpacity ?? 1) * 100)}%</span>
            </Row>
          </>
        )}
        <Row label="Коли досягнуто" hint="Інша картинка на завершену ціль. Порожньо — лишається та сама.">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 3, (url) => update({ doneImage: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.doneImage && <img src={ov.doneImage} alt="" style={{ height: 28, borderRadius: 4 }} />}
            {ov.doneImage && (
              <button className="danger" onClick={() => update({ doneImage: '' })}>
                ✕
              </button>
            )}
          </div>
        </Row>
      </Sec>

      <Sec title="✨ Коли число росте">
        <Row label="Ефект" hint="Спрацьовує на кожен новий фолов, підписку чи бітси — на будь-який приріст.">
          <select value={ov.gainFx ?? (ov.pulseOnGain ? 'pulse' : 'none')} onChange={(e) => update({ gainFx: e.target.value as GoalOverlayConfig['gainFx'] })}>
            <option value="none">Без ефекту</option>
            <option value="pulse">Пульс</option>
            <option value="pop">Підскок</option>
            <option value="shake">Тряска</option>
            <option value="flash">Спалах</option>
          </select>
        </Row>
        <Toggle
          label="Показувати приріст"
          hint="Над смугою спливає «+1» або «+100» і тане."
          value={ov.gainLabel !== false}
          onChange={(v) => update({ gainLabel: v })}
        />
        {ov.gainLabel !== false && (
          <Row label="Колір приросту">
            <ColorField value={ov.gainColor || '#ffe066'} defaultValue="#ffe066" onChange={(v) => update({ gainColor: v })} />
          </Row>
        )}
      </Sec>

      <Sec title="🎛 Власний CSS">
        <textarea
          value={ov.customCss}
          spellCheck={false}
          rows={6}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace' }}
          onChange={(e) => update({ customCss: e.target.value })}
        />
      </Sec>
    </>
  )
}

/**
 * The follow alert's panel.
 *
 * Ordered the way somebody actually builds one: what it says, then how it moves, then the picture,
 * then the plate around it, then the sound. The test button matters more than it looks — an alert is
 * the one overlay you cannot wait for real life to trigger while you are dialling it in.
 */
function FollowPanel({
  ov,
  update,
  port,
  channel
}: {
  ov: FollowOverlayConfig
  update: (patch: Partial<FollowOverlayConfig>) => void
  port: number
  channel: string
}): React.JSX.Element {
  const ANIM_LABEL: Record<AlertAnim, string> = {
    none: 'Без анімації',
    fade: 'Проявлення',
    slideUp: 'Знизу вгору',
    slideDown: 'Згори вниз',
    slideLeft: 'Справа наліво',
    slideRight: 'Зліва направо',
    pop: 'Вискок',
    zoom: 'Наближення',
    bounce: 'Стрибок',
    flip: 'Переворот',
    swing: 'Хитання',
    blur: 'З розмиття',
    glitch: 'Глітч',
    wipe: 'Витирання',
    custom: 'Власна (завантажена)'
  }
  const testUrl = `http://127.0.0.1:${port}/overlay?channel=${encodeURIComponent(channel)}&profile=${encodeURIComponent(ov.id)}&preview=1`
  void testUrl
  const [testMsg, setTestMsg] = useState('')
  /**
   * A real follow, sent down the real pipe.
   *
   * The preview in this window renders the same page, but it is not what OBS is showing, and the
   * only way to know an alert looks right on stream is to make one happen on stream.
   */
  const fireTest = (): void => {
    const names = ['Bobik069', 'Pinuses', 'Mira_Cat', 'n1cole_cat']
    const nick = names[Math.floor(Math.random() * names.length)]
    window.sticki.overlayPush(channel, {
      id: `test-follow-${Date.now()}`,
      user: 'test',
      login: nick.toLowerCase(),
      nick,
      color: '#c7a6ff',
      badges: [],
      body: '',
      kind: 'info',
      ts: Date.now(),
      follow: true
    })
    setTestMsg(`Надіслано: ${nick}`)
    window.setTimeout(() => setTestMsg(''), 4000)
  }
  return (
    <>
      <Sec title="🧪 Перевірка" defaultOpen>
        <div className="set-row">
          <label>Тестове сповіщення</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="primary" onClick={fireTest}>
              💜 Показати в OBS
            </button>
            {!!testMsg && <span className="hint">{testMsg}</span>}
          </div>
        </div>
        <div className="hint" style={{ padding: '0 12px 8px' }}>
          Летить у всі джерела цього оверлея — і в OBS, і в прев&apos;ю тут.
        </div>
      </Sec>

      <Sec title="✏️ Текст" defaultOpen>
        <Row label="Заголовок" hint="{user} — нік фоловера, {channel} — канал.">
          <input value={ov.title} onChange={(e) => update({ title: e.target.value })} />
        </Row>
        <Row label="Другий рядок">
          <input value={ov.subtitle} onChange={(e) => update({ subtitle: e.target.value })} />
        </Row>
        <Row label="Шрифт">
          <FontPicker value={ov.font} onChange={(v) => update({ font: v })} />
        </Row>
        <Row label="Розміри">
          <Num v={ov.titleSize} on={(n) => update({ titleSize: n })} min={8} max={200} w={60} def={30} />
          <Num v={ov.subtitleSize} on={(n) => update({ subtitleSize: n })} min={8} max={200} w={60} def={40} />
        </Row>
        <Row label="Кольори">
          <ColorField value={ov.titleColor} defaultValue="#ffffff" onChange={(v) => update({ titleColor: v })} />
          <ColorField value={ov.subtitleColor} defaultValue="#ffffff" onChange={(v) => update({ subtitleColor: v })} />
        </Row>
        <Row label="Колір ніка" hint="Нік усередині рядка фарбується окремо від решти тексту.">
          <ColorField value={ov.nameColor} defaultValue="#c7a6ff" onChange={(v) => update({ nameColor: v })} />
        </Row>
        <Row label="Обведення">
          <Num v={ov.outlineWidth} on={(n) => update({ outlineWidth: n })} min={0} max={8} w={54} def={0} />
          <ColorField value={ov.outlineColor} defaultValue="#000000" onChange={(v) => update({ outlineColor: v })} />
        </Row>
        <Row label="Тінь">
          <Num v={ov.shadowBlur} on={(n) => update({ shadowBlur: n })} min={0} max={60} w={54} def={14} />
          <ColorField value={ov.shadowColor} defaultValue="#000000" onChange={(v) => update({ shadowColor: v })} />
        </Row>
      </Sec>

      <Sec title="🎬 Рух і час">
        <Row label="Поява">
          <select value={ov.animIn} onChange={(e) => update({ animIn: e.target.value as AlertAnim })}>
            {ALERT_ANIMS.map((a) => (
              <option key={a} value={a}>
                {ANIM_LABEL[a]}
              </option>
            ))}
          </select>
          <Num v={ov.animInMs} on={(n) => update({ animInMs: n })} min={0} max={5000} w={70} def={600} />
        </Row>
        <Row label="Зникнення">
          <select value={ov.animOut} onChange={(e) => update({ animOut: e.target.value as AlertAnim })}>
            {ALERT_ANIMS.map((a) => (
              <option key={a} value={a}>
                {ANIM_LABEL[a]}
              </option>
            ))}
          </select>
          <Num v={ov.animOutMs} on={(n) => update({ animOutMs: n })} min={0} max={5000} w={70} def={500} />
        </Row>
        <Row label="Тримати, с" hint="Скільки алерт стоїть на екрані, не рахуючи анімацій.">
          <Num v={ov.durationS} on={(n) => update({ durationS: n })} min={0} max={60} w={54} def={5} />
        </Row>
        <Row label="Пауза між, мс" hint="Алерти стають у чергу й не накладаються один на одного.">
          <Num v={ov.gapMs} on={(n) => update({ gapMs: n })} min={0} max={10000} w={70} def={400} />
        </Row>
        <Row label="Черга максимум" hint="Під час рейду зайві найстаріші відкидаються, щоб оверлей не завис на десять хвилин.">
          <Num v={ov.queueMax} on={(n) => update({ queueMax: n })} min={1} max={100} w={54} def={8} />
        </Row>
        {(ov.animIn === 'custom' || ov.animOut === 'custom') && (
          <>
            <Row
              label="Власні keyframes"
              hint="CSS вставляється як є. Опиши @keyframes і напиши нижче їхні назви — працює будь-що, що вміє анімувати браузер."
            >
              <textarea
                value={ov.customAnimCss}
                spellCheck={false}
                rows={6}
                style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace' }}
                onChange={(e) => update({ customAnimCss: e.target.value })}
              />
            </Row>
            <Row label="Назва (поява)">
              <input
                value={ov.customAnimInName}
                placeholder="myEntrance"
                onChange={(e) => update({ customAnimInName: e.target.value })}
              />
            </Row>
            <Row label="Назва (зникнення)">
              <input
                value={ov.customAnimOutName}
                placeholder="myExit"
                onChange={(e) => update({ customAnimOutName: e.target.value })}
              />
            </Row>
          </>
        )}
      </Sec>

      <Sec title="🖼 Картинка й маска">
        <Row label="Файл" hint="PNG, GIF, WebP або відео. Анімовані лишаються анімованими.">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 12, (url) => update({ image: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.image && <img src={ov.image} alt="" style={{ height: 28, borderRadius: 4 }} />}
            {ov.image && (
              <button className="danger" onClick={() => update({ image: '' })}>
                ✕
              </button>
            )}
          </div>
        </Row>
        {!!ov.image && (
          <>
            <Row label="Ширина" hint="0 — власний розмір файлу.">
              <Num v={ov.imageWidth} on={(n) => update({ imageWidth: n })} min={0} max={2000} w={70} def={220} />
            </Row>
            <Row label="Форма маски">
              <select
                value={ov.maskShape}
                onChange={(e) => update({ maskShape: e.target.value as FollowOverlayConfig['maskShape'] })}
              >
                <option value="none">Без маски</option>
                <option value="circle">Коло</option>
                <option value="rounded">Заокруглена</option>
                <option value="hexagon">Шестикутник</option>
                <option value="star">Зірка</option>
                <option value="blob">Пляма</option>
              </select>
            </Row>
            {ov.maskShape !== 'none' && !ov.mask && (
              <Row label="М'якість краю" hint="Форму обрізає clip-path, а його край розмити неможливо — це окрема маска поверх.">
                <Num v={ov.maskFeather} on={(n) => update({ maskFeather: n })} min={0} max={80} w={54} def={0} />
              </Row>
            )}
            <Row label="Маска файлом" hint="PNG, чия прозорість вирізає форму картинки. Має перевагу над формою вище.">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="ghost" style={{ cursor: 'pointer' }}>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      readFile(e.target.files?.[0], 3, (url) => update({ mask: url }))
                      e.target.value = ''
                    }}
                  />
                  <span className="hint">📁 Обрати</span>
                </label>
                {ov.mask && <img src={ov.mask} alt="" style={{ height: 28, borderRadius: 4 }} />}
                {ov.mask && (
                  <button className="danger" onClick={() => update({ mask: '' })}>
                    ✕
                  </button>
                )}
              </div>
            </Row>
            <Row label="Власний рух" hint="Картинка живе весь час, поки алерт на екрані.">
              <select
                value={ov.imageLoop}
                onChange={(e) => update({ imageLoop: e.target.value as FollowOverlayConfig['imageLoop'] })}
              >
                <option value="none">Нерухомо</option>
                <option value="float">Погойдування</option>
                <option value="pulse">Пульс</option>
                <option value="spin">Обертання</option>
                <option value="shake">Тряска</option>
              </select>
            </Row>
          </>
        )}
      </Sec>

      <Sec title="👤 Аватар фоловера">
        <Toggle label="Показувати" value={ov.avatarShow} onChange={(v) => update({ avatarShow: v })} />
        {ov.avatarShow && (
          <>
            <Row label="Розмір">
              <Num v={ov.avatarSize} on={(n) => update({ avatarSize: n })} min={16} max={400} w={64} def={84} />
            </Row>
            <Toggle label="Кругом" value={ov.avatarRound} onChange={(v) => update({ avatarRound: v })} />
            <Row label="Обручка">
              <Num v={ov.avatarRing} on={(n) => update({ avatarRing: n })} min={0} max={20} w={54} def={3} />
              <ColorField value={ov.avatarRingColor} defaultValue="#9147ff" onChange={(v) => update({ avatarRingColor: v })} />
            </Row>
          </>
        )}
      </Sec>

      <Sec title="📐 Розташування">
        <Row label="Компонування">
          <select value={ov.layout} onChange={(e) => update({ layout: e.target.value as FollowOverlayConfig['layout'] })}>
            <option value="imageTop">Картинка над текстом</option>
            <option value="imageLeft">Картинка зліва</option>
            <option value="imageRight">Картинка справа</option>
            <option value="imageBehind">Картинка позаду</option>
            <option value="textOnly">Тільки текст</option>
            <option value="free">Вільно (координати)</option>
          </select>
        </Row>
        <Row label="По вертикалі">
          <select value={ov.anchor} onChange={(e) => update({ anchor: e.target.value as FollowOverlayConfig['anchor'] })}>
            <option value="top">Згори</option>
            <option value="center">По центру</option>
            <option value="bottom">Знизу</option>
          </select>
        </Row>
        <Row label="По горизонталі">
          <select value={ov.align} onChange={(e) => update({ align: e.target.value as FollowOverlayConfig['align'] })}>
            <option value="left">Зліва</option>
            <option value="center">По центру</option>
            <option value="right">Справа</option>
          </select>
        </Row>
        <Row label="Зсув">
          <Num v={ov.offsetX} on={(n) => update({ offsetX: n })} min={-2000} max={2000} w={64} def={0} />
          <Num v={ov.offsetY} on={(n) => update({ offsetY: n })} min={-2000} max={2000} w={64} def={0} />
        </Row>
        <Row label="Відступ між частинами">
          <Num v={ov.gap} on={(n) => update({ gap: n })} min={0} max={200} w={54} def={12} />
        </Row>
        <>
          {ov.layout === 'free' && (
            <Row
              label="Картинка: кут"
              hint="Від якого кута екрана рахуються координати. Картинка, прикріплена до кута, лишається там і на іншій роздільності."
            >
              <select
                value={ov.imageAnchor}
                onChange={(e) => update({ imageAnchor: e.target.value as FollowOverlayConfig['imageAnchor'] })}
              >
                {ANCHOR9.map((a) => (
                  <option key={a.v} value={a.v}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <>
            <Row
              label="Картинка: X / Y"
              hint={
                ov.layout === 'free'
                  ? 'Координати від обраного кута.'
                  : 'У звичайних розкладках це зсув від того місця, де картинка стоїть за розкладкою.'
              }
            >
              <Num v={ov.imageX} on={(n) => update({ imageX: n })} min={-4000} max={4000} w={64} def={0} />
              <Num v={ov.imageY} on={(n) => update({ imageY: n })} min={-4000} max={4000} w={64} def={0} />
            </Row>
            <Row label="Картинка: поворот / прозорість">
              <Num v={ov.imageRotate} on={(n) => update({ imageRotate: n })} min={-180} max={180} w={60} def={0} />
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((ov.imageOpacity ?? 1) * 100)}
                onChange={(e) => update({ imageOpacity: Number(e.target.value) / 100 })}
              />
            </Row>
            {ov.layout === 'free' && (
              <Row label="Текст: кут">
                <select
                  value={ov.textAnchor}
                  onChange={(e) => update({ textAnchor: e.target.value as FollowOverlayConfig['textAnchor'] })}
                >
                  {ANCHOR9.map((a) => (
                    <option key={a.v} value={a.v}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            <Row label="Текст: X / Y">
              <Num v={ov.textX} on={(n) => update({ textX: n })} min={-4000} max={4000} w={64} def={0} />
              <Num v={ov.textY} on={(n) => update({ textY: n })} min={-4000} max={4000} w={64} def={0} />
            </Row>
          </>
        </>
      </Sec>

      <Sec title="🎨 Плашка">
        <Toggle label="Плашка позаду" value={ov.plate} onChange={(v) => update({ plate: v })} />
        {ov.plate && (
          <>
            <Row label="Заповнення">
              <FillEditor value={ov.plateFill} onChange={(f) => update({ plateFill: f })} />
            </Row>
            <Row label="Підкладка" hint="Картинка, гіфка або відео замість заливки. Відео важить у рази менше за ту саму гіфку.">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="ghost" style={{ cursor: 'pointer' }}>
                  <input
                    type="file"
                    accept="image/*,video/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      readFile(e.target.files?.[0], 12, (url) => update({ plateMedia: url }))
                      e.target.value = ''
                    }}
                  />
                  <span className="hint">📁 Обрати</span>
                </label>
                {ov.plateMedia && (
                  <button className="danger" onClick={() => update({ plateMedia: '' })}>
                    ✕
                  </button>
                )}
              </div>
            </Row>
            {!!ov.plateMedia && (
              <Row label="Підкладка: вписування">
                <select
                  value={ov.plateMediaFit}
                  onChange={(e) => update({ plateMediaFit: e.target.value as FollowOverlayConfig['plateMediaFit'] })}
                >
                  <option value="cover">Заповнити</option>
                  <option value="contain">Вмістити</option>
                  <option value="stretch">Розтягнути</option>
                </select>
                <input
                  type="range"
                  min={5}
                  max={100}
                  value={Math.round((ov.plateMediaOpacity ?? 1) * 100)}
                  onChange={(e) => update({ plateMediaOpacity: Number(e.target.value) / 100 })}
                />
              </Row>
            )}
            <Row label="Форма" hint="Готові обриси плашки. «Прямокутник» — єдиний, що читає заокруглення нижче.">
              <select
                value={ov.plateShape ?? 'rect'}
                onChange={(e) => update({ plateShape: e.target.value as PlateShape })}
              >
                {PLATE_SHAPES.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Своя маска" hint="PNG: де прозоро — там плашки нема. Замінює форму вище.">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="ghost" style={{ cursor: 'pointer' }}>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      readFile(e.target.files?.[0], 4, (url) => update({ plateMask: url }))
                      e.target.value = ''
                    }}
                  />
                  <span className="hint">{ov.plateMask ? '📁 Замінити' : '📁 Обрати'}</span>
                </label>
                {!!ov.plateMask && (
                  <button className="danger" onClick={() => update({ plateMask: '' })}>
                    ✕
                  </button>
                )}
              </div>
            </Row>
            <Toggle
              label="Обводка і сяйво за заливкою"
              hint="Якщо плашка градієнтна — рамка і сяйво беруть той самий градієнт замість одного плаского кольору."
              value={!!ov.plateFxFromFill}
              onChange={(v) => update({ plateFxFromFill: v })}
            />
            <Row label="Заокруглення">
              <Num v={ov.plateRadius} on={(n) => update({ plateRadius: n })} min={0} max={200} w={64} def={18} />
            </Row>
            <Row label="Відступи">
              <Num v={ov.platePadX} on={(n) => update({ platePadX: n })} min={0} max={200} w={60} def={28} />
              <Num v={ov.platePadY} on={(n) => update({ platePadY: n })} min={0} max={200} w={60} def={20} />
            </Row>
            <Row label="Рамка">
              <Num v={ov.plateBorderWidth} on={(n) => update({ plateBorderWidth: n })} min={0} max={20} w={54} def={0} />
              <ColorField value={ov.plateBorderColor} defaultValue="#9147ff" onChange={(v) => update({ plateBorderColor: v })} />
            </Row>
            <Row label="Сяйво">
              <Num v={ov.plateGlowSize} on={(n) => update({ plateGlowSize: n })} min={0} max={80} w={54} def={0} />
              <ColorField value={ov.plateGlowColor} defaultValue="#9147ff" onChange={(v) => update({ plateGlowColor: v })} />
            </Row>
          </>
        )}
      </Sec>

      <Sec title="🔔 Звук">
        <Row label="Файл">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="audio/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 2, (url) => update({ soundData: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.soundData && (
              <>
                <input
                  type="range"
                  min={0}
                  max={100}
                  style={{ width: 80 }}
                  value={Math.round((ov.soundVolume ?? 0.6) * 100)}
                  onChange={(e) => update({ soundVolume: Number(e.target.value) / 100 })}
                />
                <button
                  onClick={() => {
                    const au = new Audio(ov.soundData)
                    au.volume = ov.soundVolume ?? 0.6
                    au.play().catch(() => {})
                  }}
                >
                  ▶
                </button>
                <button className="danger" onClick={() => update({ soundData: '' })}>
                  ✕
                </button>
              </>
            )}
          </div>
        </Row>
      </Sec>

      <Sec title="🎛 Власний CSS">
        <textarea
          value={ov.customCss}
          spellCheck={false}
          rows={6}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace' }}
          onChange={(e) => update({ customCss: e.target.value })}
        />
      </Sec>
    </>
  )
}

/**
 * The wheel's panel.
 *
 * The section list comes first and stays first: everything else is decoration around what the
 * wheel actually says. Weights are shown as a live percentage next to each row, because a column
 * of raw numbers tells nobody what the odds are — which is the one thing a wheel exists to show.
 */
function RoulettePanel({
  ov,
  update,
  channel
}: {
  ov: RouletteOverlayConfig
  update: (patch: Partial<RouletteOverlayConfig>) => void
  channel: string
}): React.JSX.Element {
  const [spinMsg, setSpinMsg] = useState('')
  const total = ov.sections.reduce((a, s) => a + Math.max(0.0001, s.weight || 1), 0)
  const upd = (id: string, patch: Partial<WheelSection>): void =>
    update({ sections: ov.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const spinNow = async (): Promise<void> => {
    const m = await import('../services/wheel')
    const fresh = useSettingsStore.getState().settings.chatOverlays.find((o) => o.id === ov.id)
    if (!fresh || fresh.type !== 'roulette') return
    const res = m.spinWheel(fresh, channel, true)
    setSpinMsg(res.ok ? `Випало: ${res.label}` : res.reason || '')
    window.setTimeout(() => setSpinMsg(''), 4000)
  }
  return (
    <>
      <Sec title="🎡 Секції" defaultOpen>
        {ov.sections.map((s) => (
          <div key={s.id} className="oe-decor">
            <div className="oe-decor-ctl" style={{ flexWrap: 'wrap' }}>
              <input
                value={s.label}
                placeholder="Текст"
                style={{ width: 150 }}
                onChange={(e) => upd(s.id, { label: e.target.value })}
              />
              <Num v={s.weight} on={(n) => upd(s.id, { weight: n })} min={0} max={1000} w={54} def={1} />
              <span className="hint" style={{ minWidth: 44 }}>
                {Math.round((Math.max(0.0001, s.weight || 1) / total) * 100)}%
              </span>
              <ColorField value={s.color} defaultValue="#9147ff" onChange={(v) => upd(s.id, { color: v })} />
              <ColorField value={s.textColor} defaultValue="#ffffff" onChange={(v) => upd(s.id, { textColor: v })} />
              <label className="ghost" style={{ cursor: 'pointer' }} title="Картинка, гіфка або відео в секторі">
                <input
                  type="file"
                  accept="image/*,video/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    readFile(e.target.files?.[0], 8, (url) => upd(s.id, { media: url }))
                    e.target.value = ''
                  }}
                />
                <span className="hint">{s.media ? '🖼✓' : '🖼'}</span>
              </label>
              {s.media && (
                <button className="ghost" title="Прибрати картинку" onClick={() => upd(s.id, { media: '' })}>
                  ⌫
                </button>
              )}
              <label className="hint" title="Прибрати сектор, коли він виграє — для розіграшів без повторів">
                <input
                  type="checkbox"
                  checked={s.removeOnWin}
                  onChange={(e) => upd(s.id, { removeOnWin: e.target.checked })}
                />{' '}
                −
              </label>
              <button
                className="danger"
                onClick={() => update({ sections: ov.sections.filter((x) => x.id !== s.id) })}
              >
                ✕
              </button>
            </div>
            {!!s.media && (
              <div className="oe-decor-ctl" style={{ flexWrap: 'wrap' }}>
                <span className="hint" title="Розмір картинки у відсотках колеса">
                  🔍
                </span>
                <Num
                  v={s.mediaScale ?? 100}
                  on={(n) => upd(s.id, { mediaScale: n })}
                  min={5}
                  max={400}
                  w={58}
                  def={100}
                />
                <span className="hint" title="Зсув картинки від центра колеса">
                  ✥
                </span>
                <Num v={s.mediaX ?? 0} on={(n) => upd(s.id, { mediaX: n })} min={-2000} max={2000} w={58} def={0} />
                <Num v={s.mediaY ?? 0} on={(n) => upd(s.id, { mediaY: n })} min={-2000} max={2000} w={58} def={0} />
              </div>
            )}
          </div>
        ))}
        <button
          onClick={() =>
            update({
              sections: [
                ...ov.sections,
                {
                  id: nextId('ws'),
                  label: 'Новий сектор',
                  weight: 1,
                  color: PALETTE[ov.sections.length % PALETTE.length],
                  textColor: '#ffffff',
                  media: '',
                  removeOnWin: false
                }
              ]
            })
          }
        >
          + Сектор
        </button>
      </Sec>

      <Sec title="▶ Запуск">
        <Row label="Що крутить">
          <select value={ov.trigger} onChange={(e) => update({ trigger: e.target.value as RouletteOverlayConfig['trigger'] })}>
            <option value="manual">Лише кнопкою тут</option>
            <option value="command">Команда в чаті</option>
            <option value="redeem">Нагорода за бали</option>
          </select>
        </Row>
        {ov.trigger === 'command' && (
          <>
            <Row label="Команда">
              <input value={ov.command} onChange={(e) => update({ command: e.target.value })} />
            </Row>
            <Row label="Кому можна">
              <select value={ov.who} onChange={(e) => update({ who: e.target.value as RouletteOverlayConfig['who'] })}>
                <option value="broadcaster">Тільки мені</option>
                <option value="mods">Модераторам</option>
                <option value="everyone">Усім</option>
              </select>
            </Row>
          </>
        )}
        {ov.trigger === 'redeem' && (
          <Row label="Назва нагороди" hint="Точна назва нагороди за бали каналу.">
            <input value={ov.redeemTitle} onChange={(e) => update({ redeemTitle: e.target.value })} />
          </Row>
        )}
        <Row label="Перезарядка, с" hint="Не стосується кнопки нижче — вона для налаштування.">
          <Num v={ov.cooldownS} on={(n) => update({ cooldownS: n })} min={0} max={3600} w={64} def={30} />
        </Row>
        <Toggle label="Писати результат у чат" value={ov.announce} onChange={(v) => update({ announce: v })} />
        {ov.announce && (
          <Row label="Текст" hint="{result} — те, що випало. Пишеться, коли колесо вже зупинилось.">
            <input value={ov.announceText} onChange={(e) => update({ announceText: e.target.value })} />
          </Row>
        )}
        <div className="set-row">
          <label>Перевірити</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => void spinNow()}>
              🎡 Крутити
            </button>
            {spinMsg && <span className="hint">{spinMsg}</span>}
          </div>
        </div>
      </Sec>

      <Sec title="⏱ Обертання">
        <Row label="Час, с">
          <Num v={ov.spinS} on={(n) => update({ spinS: n })} min={0.5} max={60} w={54} def={6} />
        </Row>
        <Row label="Обертів" hint="Скільки повних кіл до того, як почне сповільнюватись.">
          <Num v={ov.turns} on={(n) => update({ turns: n })} min={0} max={40} w={54} def={5} />
        </Row>
        <Row label="Сповільнення">
          <select value={ov.easing} onChange={(e) => update({ easing: e.target.value as RouletteOverlayConfig['easing'] })}>
            <option value="smooth">Плавне</option>
            <option value="snappy">Різке</option>
            <option value="heavy">Важке</option>
          </select>
        </Row>
        <Row label="Показувати результат, с">
          <Num v={ov.resultS} on={(n) => update({ resultS: n })} min={0} max={60} w={54} def={4} />
        </Row>
      </Sec>

      <Sec title="🎨 Колесо">
        <Row label="Розмір">
          <Num v={ov.size} on={(n) => update({ size: n })} min={80} max={2000} w={72} def={460} />
        </Row>
        <Row label="Обід">
          <Num v={ov.rimWidth} on={(n) => update({ rimWidth: n })} min={0} max={80} w={54} def={10} />
          <ColorField value={ov.rimColor} defaultValue="#ffffff" onChange={(v) => update({ rimColor: v })} />
        </Row>
        <Row label="Розділювачі">
          <Num v={ov.dividerWidth} on={(n) => update({ dividerWidth: n })} min={0} max={20} w={54} def={2} />
          <ColorField value={ov.dividerColor} defaultValue="#000000" onChange={(v) => update({ dividerColor: v })} />
        </Row>
        <Row label="Шрифт">
          <FontPicker value={ov.font} onChange={(v) => update({ font: v })} />
        </Row>
        <Row label="Розмір тексту">
          <Num v={ov.fontSize} on={(n) => update({ fontSize: n })} min={6} max={120} w={54} def={20} />
        </Row>
        <Toggle
          label="Текст вздовж радіуса"
          hint="На вузькому секторі рівний текст перестає читатись значно раніше."
          value={ov.textRadial}
          onChange={(v) => update({ textRadial: v })}
        />
        <Row label="Вказівник">
          <select value={ov.pointer} onChange={(e) => update({ pointer: e.target.value as RouletteOverlayConfig['pointer'] })}>
            <option value="triangle">Трикутник</option>
            <option value="arrow">Стрілка</option>
            <option value="pin">Крапля</option>
            <option value="none">Без нього</option>
          </select>
          <ColorField value={ov.pointerColor} defaultValue="#ffffff" onChange={(v) => update({ pointerColor: v })} />
        </Row>
        <Row label="Центр" hint="Картинка, гіфка або відео в центрі колеса.">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 6, (url) => update({ hubMedia: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.hubMedia && (
              <button className="danger" onClick={() => update({ hubMedia: '' })}>
                ✕
              </button>
            )}
            <Num v={ov.hubSize} on={(n) => update({ hubSize: n })} min={0} max={600} w={60} def={90} />
          </div>
        </Row>
        <Row
          label="Картинка на все колесо"
          hint="Одне зображення на весь диск — обертається разом з колесом. Сектори під ним лишаються, просто їх не видно."
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 12, (url) => update({ faceMedia: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {!!ov.faceMedia && (
              <button className="danger" onClick={() => update({ faceMedia: '' })}>
                ✕
              </button>
            )}
            {!!ov.faceMedia && (
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((ov.faceOpacity ?? 1) * 100)}
                onChange={(e) => update({ faceOpacity: Number(e.target.value) / 100 })}
              />
            )}
          </div>
        </Row>
        <Row label="Зсув">
          <Num v={ov.offsetX} on={(n) => update({ offsetX: n })} min={-2000} max={2000} w={64} def={0} />
          <Num v={ov.offsetY} on={(n) => update({ offsetY: n })} min={-2000} max={2000} w={64} def={0} />
        </Row>
      </Sec>

      <Sec title="🖼 Тло й результат">
        <Row label="Тло" hint="Картинка, гіфка або відео позаду колеса. Воно не обертається разом з ним.">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 12, (url) => update({ backdrop: url }))
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 Обрати</span>
            </label>
            {ov.backdrop && (
              <button className="danger" onClick={() => update({ backdrop: '' })}>
                ✕
              </button>
            )}
          </div>
        </Row>
        {!!ov.backdrop && (
          <>
            <Row label="Вписування">
              <select
                value={ov.backdropFit}
                onChange={(e) => update({ backdropFit: e.target.value as RouletteOverlayConfig['backdropFit'] })}
              >
                <option value="cover">Заповнити</option>
                <option value="contain">Вмістити</option>
                <option value="stretch">Розтягнути</option>
              </select>
            </Row>
            <Row label="Прозорість">
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((ov.backdropOpacity ?? 1) * 100)}
                onChange={(e) => update({ backdropOpacity: Number(e.target.value) / 100 })}
              />
              <span className="hint">{Math.round((ov.backdropOpacity ?? 1) * 100)}%</span>
            </Row>
          </>
        )}
        <Toggle label="Показувати те, що випало" value={ov.resultShow} onChange={(v) => update({ resultShow: v })} />
        {ov.resultShow && (
          <Row label="Розмір і колір">
            <Num v={ov.resultSize} on={(n) => update({ resultSize: n })} min={8} max={200} w={60} def={42} />
            <ColorField value={ov.resultColor} defaultValue="#ffffff" onChange={(v) => update({ resultColor: v })} />
          </Row>
        )}
      </Sec>

      <Sec title="🔔 Звук">
        <Row
          label="Під час обертання"
          hint="«Цокіт» — клац на кожному секторі, що проходить повз вказівник. Він іде за самим колесом, тому не збивається і не закінчується, скільки б воно не крутилось."
        >
          <select
            value={ov.spinSoundKind ?? (ov.spinSound ? 'custom' : 'tick')}
            onChange={(e) => update({ spinSoundKind: e.target.value as RouletteOverlayConfig['spinSoundKind'] })}
          >
            <option value="tick">Цокіт</option>
            <option value="whoosh">Гул</option>
            <option value="drumroll">Барабанний дріб</option>
            <option value="custom">Свій файл</option>
            <option value="none">Без звуку</option>
          </select>
        </Row>
        {(ov.spinSoundKind ?? (ov.spinSound ? 'custom' : 'tick')) === 'custom' && (
          <Row label="Файл обертання" hint="Зациклюється без шва, поки колесо крутиться.">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="ghost" style={{ cursor: 'pointer' }}>
                <input
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    readFile(e.target.files?.[0], 3, (url) => update({ spinSound: url }))
                    e.target.value = ''
                  }}
                />
                <span className="hint">{ov.spinSound ? '📁 Замінити' : '📁 Обрати'}</span>
              </label>
              {ov.spinSound && (
                <button className="danger" onClick={() => update({ spinSound: '' })}>
                  ✕
                </button>
              )}
            </div>
          </Row>
        )}
        <Row label="На результат">
          <select
            value={ov.winSoundKind ?? (ov.winSound ? 'custom' : 'fanfare')}
            onChange={(e) => update({ winSoundKind: e.target.value as RouletteOverlayConfig['winSoundKind'] })}
          >
            <option value="fanfare">Фанфари</option>
            <option value="chime">Дзвіночок</option>
            <option value="coin">Монетка</option>
            <option value="custom">Свій файл</option>
            <option value="none">Без звуку</option>
          </select>
        </Row>
        {(ov.winSoundKind ?? (ov.winSound ? 'custom' : 'fanfare')) === 'custom' && (
          <Row label="Файл результату">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="ghost" style={{ cursor: 'pointer' }}>
                <input
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    readFile(e.target.files?.[0], 3, (url) => update({ winSound: url }))
                    e.target.value = ''
                  }}
                />
                <span className="hint">{ov.winSound ? '📁 Замінити' : '📁 Обрати'}</span>
              </label>
              {ov.winSound && (
                <button className="danger" onClick={() => update({ winSound: '' })}>
                  ✕
                </button>
              )}
            </div>
          </Row>
        )}
        <Row label="Гучність">
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((ov.soundVolume ?? 0.6) * 100)}
            onChange={(e) => update({ soundVolume: Number(e.target.value) / 100 })}
          />
          <span className="hint">{Math.round((ov.soundVolume ?? 0.6) * 100)}%</span>
        </Row>
      </Sec>

      <Sec title="🎛 Власний CSS">
        <textarea
          value={ov.customCss}
          spellCheck={false}
          rows={6}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace' }}
          onChange={(e) => update({ customCss: e.target.value })}
        />
      </Sec>
    </>
  )
}

export default function OverlayAltEditor({
  ov,
  update,
  channel,
  setChannel,
  channels,
  port
}: AltEditorProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const obsUrl = `http://127.0.0.1:${port}/overlay?channel=${encodeURIComponent(channel)}&profile=${encodeURIComponent(ov.id)}`
  const previewUrl = `${obsUrl}&preview=1`
  return (
    <div className="app oe-root">
      <div className="modal-header">
        {KIND_CHIP[ov.type]}
        <input className="oe-name" value={ov.name} onChange={(e) => update({ name: e.target.value })} />
        <div className="spacer" />
        <button className="ghost" onClick={() => window.close()}>
          ✕
        </button>
      </div>
      <div className="oe-body">
        <div className="oe-side">
          {ov.type === 'emotes' ? (
            <EmoteRainPanel ov={ov} update={update} />
          ) : ov.type === 'goal' ? (
            <GoalPanel ov={ov} update={update} />
          ) : ov.type === 'follow' ? (
            <FollowPanel ov={ov} update={update} port={port} channel={channel} />
          ) : (
            <RoulettePanel ov={ov} update={update} channel={channel} />
          )}
        </div>
        <div className="oe-main">
          <div className="oe-toolbar">
            <label className="hint">Канал</label>
            <select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value)
                update({ channel: e.target.value })
              }}
            >
              {!channels.length && <option value="">—</option>}
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label
              className="hint"
              style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}
              title="Прев'ю саме програє події, щоб було видно рух. Вимкни, щоб воно просто стояло, поки налаштовуєш."
            >
              <input
                type="checkbox"
                checked={ov.previewDemo !== false}
                onChange={(e) => update({ previewDemo: e.target.checked })}
              />
              ▶ Демо
            </label>
            <code className="oe-note" title={obsUrl} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {obsUrl}
            </code>
            <button
              onClick={() => {
                window.sticki.copyText(obsUrl)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? '✓' : '⧉ Копіювати URL'}
            </button>
          </div>
          <div className="oe-preview checker">
            <iframe key={previewUrl} src={previewUrl} title="preview" />
          </div>
        </div>
      </div>
    </div>
  )
}
