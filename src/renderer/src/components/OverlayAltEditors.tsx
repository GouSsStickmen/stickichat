import React, { useState } from 'react'
import { EmoteRainOverlayConfig, GoalOverlayConfig, OverlayConfig } from '../types'
import { ColorField, FontPicker, NickListArea, Toggle } from './settings/SettingsModal'
import { Row, Num, Sec, FillEditor, readFile } from './OverlayEditorWindow'

/**
 * The editors for the overlay kinds that are not chat.
 *
 * They live beside the chat editor rather than inside it because they share none of its subject
 * matter — no plate, no nick, no message — but all of its frame: the same window, the same live
 * preview, the same OBS url and channel picker. That frame is what `OverlayAltEditor` is; the
 * panels below it are just fields.
 */

export interface AltEditorProps {
  ov: EmoteRainOverlayConfig | GoalOverlayConfig
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
        {ov.type === 'emotes' ? '🎉 Святкування' : '🎯 Ціль'}
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
          ) : (
            <GoalPanel ov={ov} update={update} />
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
