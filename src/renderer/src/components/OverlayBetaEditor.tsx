import { useState } from 'react'
import { ChatOverlayConfig } from '../types'
import {
  Anchor9,
  BoxNode,
  Fill,
  ImageNode,
  NodeKind,
  OverlayNode,
  OverlayScene,
  TextNode,
  addNode,
  baseNode,
  duplicateNode,
  emptyScene,
  removeNode,
  reorderNode,
  updateNode
} from '../lib/overlayScene'
import { sceneFromConfig, sceneIsEmpty } from '../lib/overlaySceneMigrate'
import OverlaySceneCanvas from './OverlaySceneCanvas'

/**
 * The beta edit mode: layers on the left, the canvas in the middle, the inspector on the right.
 *
 * Three columns because that is the arrangement every editor of this kind has settled on, and
 * people arrive already knowing it. The important part is underneath: all three read and write
 * the same node list, so a property added to the model appears in the inspector without anyone
 * writing a form row for it, and a new element kind is drawn by the canvas without the editor
 * being taught about it.
 */

const KINDS: { kind: NodeKind; label: string }[] = [
  { kind: 'box', label: 'Фігура' },
  { kind: 'text', label: 'Текст' },
  { kind: 'image', label: 'Картинка' },
  { kind: 'badges', label: 'Бейджі' },
  { kind: 'avatar', label: 'Аватар' },
  { kind: 'trigger', label: 'Тригер' },
  { kind: 'group', label: 'Група' }
]

const ANCHORS: Anchor9[] = ['tl', 'top', 'tr', 'left', 'center', 'right', 'bl', 'bottom', 'br']

function makeNode(kind: NodeKind): OverlayNode {
  const base = baseNode(kind, KINDS.find((k) => k.kind === kind)?.label ?? kind)
  switch (kind) {
    case 'box':
      return { ...base, kind, shape: 'rect', w: 160, h: 60, style: { fill: { kind: 'solid', color: '#000000cc' }, radius: 8 } } as BoxNode
    case 'text':
      return { ...base, kind, bind: 'static', text: 'Текст', style: { size: 24, color: '#ffffff', weight: 700 } } as TextNode
    case 'image':
      return { ...base, kind, image: '', w: 120, lockAspect: true } as ImageNode
    case 'badges':
      return { ...base, kind, kinds: [], itemSize: 18, gap: 3, direction: 'row' } as OverlayNode
    case 'avatar':
      return { ...base, kind, shape: 'circle', w: 48, h: 48, lockAspect: true } as OverlayNode
    case 'trigger':
      return { ...base, kind, word: '', image: '', anim: 'pop', durationS: 3, w: 120, lockAspect: true } as OverlayNode
    default:
      return { ...base, kind: 'group' } as OverlayNode
  }
}

interface Props {
  overlay: ChatOverlayConfig
  onChange: (patch: Partial<ChatOverlayConfig>) => void
  /** the running overlay server, so the canvas can sit on the real page rather than a mock-up */
  port: number
  channel: string
  /** the OBS source's size, when the user has set one */
  canvas?: { w: number; h: number } | null
}

export default function OverlayBetaEditor({ overlay, onChange, port, channel, canvas }: Props): React.JSX.Element {
  const [space, setSpace] = useState<'scene' | 'template'>('scene')
  const [selected, setSelected] = useState<string | null>(null)

  const scene: OverlayScene = overlay.scene ?? emptyScene()
  const setScene = (next: OverlayScene): void => onChange({ scene: next })

  // The drawing area: the screen for scene elements, one plate for template elements. The screen
  // follows the real source size when there is one — placing against a guessed aspect ratio and
  // then finding it different in OBS is the one thing a canvas like this must not do.
  const size = space === 'scene' ? (canvas ?? { w: 640, h: 360 }) : { w: 420, h: 120 }
  const nodes = scene[space]
  const sel = selected ? nodes.find((n) => n.id === selected) ?? null : null

  const patchSel = (patch: Partial<OverlayNode>): void => {
    if (sel) setScene(updateNode(scene, sel.id, patch))
  }

  const startFromCurrent = (): void => setScene(sceneFromConfig(overlay))

  return (
    <div className="obe">
      {/* ---------------- layers ---------------- */}
      <div className="obe-col">
        <header>
          <select value={space} onChange={(e) => { setSpace(e.target.value as 'scene' | 'template'); setSelected(null) }}>
            <option value="scene">Сцена (екран)</option>
            <option value="template">Плашка повідомлення</option>
          </select>
        </header>
        <div className="obe-scroll">
          {/* newest on top, the way a layer panel reads — the list itself is stored back to front */}
          {[...nodes].reverse().map((n) => (
            <div
              key={n.id}
              className={`obe-layer ${n.id === selected ? 'sel' : ''}`}
              onClick={() => setSelected(n.id)}
            >
              <button
                className="icon-btn"
                title={n.hidden ? 'Показати' : 'Сховати'}
                onClick={(e) => { e.stopPropagation(); setScene(updateNode(scene, n.id, { hidden: !n.hidden })) }}
              >
                {n.hidden ? '🚫' : '👁'}
              </button>
              <button
                className="icon-btn"
                title={n.locked ? 'Розблокувати' : 'Заблокувати'}
                onClick={(e) => { e.stopPropagation(); setScene(updateNode(scene, n.id, { locked: !n.locked })) }}
              >
                {n.locked ? '🔒' : '🔓'}
              </button>
              <span className="obe-name">{n.name}</span>
              <span className="obe-mini">{n.kind}</span>
            </div>
          ))}
          {nodes.length === 0 && (
            <div className="obe-empty">
              Порожньо. Додай елемент нижче або перенеси те, що вже налаштовано.
            </div>
          )}
        </div>
        <header style={{ borderTop: '1px solid var(--border)', borderBottom: 'none', flexWrap: 'wrap' }}>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              className="ghost"
              onClick={() => {
                const node = makeNode(k.kind)
                setScene(addNode(scene, space, node))
                setSelected(node.id)
              }}
            >
              + {k.label}
            </button>
          ))}
        </header>
      </div>

      {/* ---------------- canvas ---------------- */}
      <div className="obe-col obe-stage">
        <OverlaySceneCanvas
          scene={scene}
          space={space}
          size={size}
          selected={selected}
          onSelect={setSelected}
          onChange={setScene}
          backdrop={
            space === 'scene' ? (
              // the real overlay page, in demo mode, with its own element layer suppressed:
              // what is behind the handles is exactly what OBS will show
              <iframe
                title="overlay backdrop"
                src={`http://127.0.0.1:${port}/overlay?channel=${encodeURIComponent(channel)}&profile=${encodeURIComponent(overlay.id)}&preview=1&noscene=1`}
                style={{ width: '100%', height: '100%', border: 0 }}
              />
            ) : (
              <div className="obe-plate-hint">Плашка одного повідомлення</div>
            )
          }
        />
      </div>

      {/* ---------------- inspector ---------------- */}
      <div className="obe-col">
        <header>{sel ? sel.name : 'Нічого не вибрано'}</header>
        <div className="obe-scroll">
          {sceneIsEmpty(overlay.scene) && (
            <div className="obe-empty">
              <p>Бета працює з елементами замість фіксованих полів.</p>
              <button className="primary" onClick={startFromCurrent}>
                Перенести поточні декор і тригери
              </button>
            </div>
          )}

          {sel && (
            <>
              <div className="obe-row">
                <label>Назва</label>
                <input value={sel.name} onChange={(e) => patchSel({ name: e.target.value })} />
              </div>

              <div className="obe-row">
                <label>Прив&apos;язка</label>
                <div className="obe-grid9">
                  {ANCHORS.map((a) => (
                    <button
                      key={a}
                      className={sel.anchor === a ? 'on' : ''}
                      title={`Від якої точки контейнера рахувати: ${a}`}
                      onClick={() => patchSel({ anchor: a })}
                    />
                  ))}
                </div>
              </div>
              <div className="obe-row">
                <label>Точка елемента</label>
                <div className="obe-grid9">
                  {ANCHORS.map((a) => (
                    <button
                      key={a}
                      className={sel.origin === a ? 'on' : ''}
                      title={`Яка точка самого елемента туди стає: ${a}`}
                      onClick={() => patchSel({ origin: a })}
                    />
                  ))}
                </div>
              </div>

              <Num label="X" value={sel.x} onChange={(v) => patchSel({ x: v })} />
              <Num label="Y" value={sel.y} onChange={(v) => patchSel({ y: v })} />
              <Num label="Ширина" value={sel.w} onChange={(v) => patchSel({ w: v })} placeholder="авто" />
              <Num label="Висота" value={sel.h} onChange={(v) => patchSel({ h: v })} placeholder="авто" />
              <div className="obe-row">
                <label>Пропорції</label>
                <input
                  type="checkbox"
                  checked={!!sel.lockAspect}
                  onChange={(e) => patchSel({ lockAspect: e.target.checked })}
                />
              </div>
              <Num label="Поворот" value={sel.rotate} onChange={(v) => patchSel({ rotate: v ?? 0 })} />
              <div className="obe-row">
                <label>Масштаб</label>
                <input
                  type="range"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={sel.scale}
                  onChange={(e) => patchSel({ scale: Number(e.target.value) })}
                />
              </div>
              <div className="obe-row">
                <label>Прозорість</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={sel.opacity}
                  onChange={(e) => patchSel({ opacity: Number(e.target.value) })}
                />
              </div>

              {'style' in sel && sel.kind === 'box' && (
                <FillEditor
                  fill={sel.style?.fill}
                  onChange={(fill) => patchSel({ style: { ...sel.style, fill } } as Partial<OverlayNode>)}
                />
              )}
              {sel.kind === 'text' && (
                <>
                  <div className="obe-row">
                    <label>Джерело</label>
                    <select value={sel.bind} onChange={(e) => patchSel({ bind: e.target.value } as Partial<OverlayNode>)}>
                      <option value="static">Свій текст</option>
                      <option value="nick">Нік</option>
                      <option value="message">Повідомлення</option>
                      <option value="timestamp">Час</option>
                      <option value="channel">Канал</option>
                    </select>
                  </div>
                  {sel.bind === 'static' && (
                    <div className="obe-row">
                      <label>Текст</label>
                      <input value={sel.text ?? ''} onChange={(e) => patchSel({ text: e.target.value } as Partial<OverlayNode>)} />
                    </div>
                  )}
                  <Num
                    label="Розмір"
                    value={sel.style?.size}
                    onChange={(v) => patchSel({ style: { ...sel.style, size: v } } as Partial<OverlayNode>)}
                  />
                  <div className="obe-row">
                    <label>Колір</label>
                    <input
                      type="color"
                      value={sel.style?.color ?? '#ffffff'}
                      onChange={(e) => patchSel({ style: { ...sel.style, color: e.target.value } } as Partial<OverlayNode>)}
                    />
                  </div>
                </>
              )}
              {(sel.kind === 'image' || sel.kind === 'trigger') && (
                <div className="obe-row">
                  <label>Файл</label>
                  <input
                    value={sel.image}
                    placeholder="URL або завантажений файл"
                    onChange={(e) => patchSel({ image: e.target.value } as Partial<OverlayNode>)}
                  />
                </div>
              )}
              {sel.kind === 'trigger' && (
                <div className="obe-row">
                  <label>Слово</label>
                  <input value={sel.word} onChange={(e) => patchSel({ word: e.target.value } as Partial<OverlayNode>)} />
                </div>
              )}

              <div className="obe-row" style={{ marginTop: 10, gap: 4 }}>
                <button className="ghost" onClick={() => setScene(duplicateNode(scene, sel.id))}>
                  Дублювати
                </button>
                <button
                  className="ghost"
                  title="Вище в стосі"
                  onClick={() => setScene(reorderNode(scene, space, sel.id, nodes.findIndex((n) => n.id === sel.id) + 1))}
                >
                  ↑
                </button>
                <button
                  className="ghost"
                  title="Нижче в стосі"
                  onClick={() => setScene(reorderNode(scene, space, sel.id, nodes.findIndex((n) => n.id === sel.id) - 1))}
                >
                  ↓
                </button>
                <button
                  className="ghost danger"
                  onClick={() => { setScene(removeNode(scene, sel.id)); setSelected(null) }}
                >
                  Видалити
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Num({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <div className="obe-row">
      <label>{label}</label>
      <input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </div>
  )
}

/** solid and gradient are the same control, because they are the same thing at different lengths */
function FillEditor({
  fill,
  onChange
}: {
  fill: Fill | undefined
  onChange: (fill: Fill) => void
}): React.JSX.Element {
  const f: Fill = fill ?? { kind: 'solid', color: '#000000' }
  const stops = f.stops ?? [
    { at: 0, color: f.color ?? '#000000' },
    { at: 1, color: '#00000000' }
  ]
  return (
    <>
      <div className="obe-row">
        <label>Заливка</label>
        <select value={f.kind} onChange={(e) => onChange({ ...f, kind: e.target.value as Fill['kind'] })}>
          <option value="none">Немає</option>
          <option value="solid">Колір</option>
          <option value="linear">Лінійний градієнт</option>
          <option value="radial">Радіальний градієнт</option>
          <option value="image">Картинка</option>
        </select>
      </div>
      {f.kind === 'solid' && (
        <div className="obe-row">
          <label>Колір</label>
          <input type="color" value={f.color ?? '#000000'} onChange={(e) => onChange({ ...f, color: e.target.value })} />
        </div>
      )}
      {(f.kind === 'linear' || f.kind === 'radial') && (
        <>
          {stops.map((s, i) => (
            <div className="obe-row" key={i}>
              <label>Точка {i + 1}</label>
              <input
                type="color"
                value={s.color.slice(0, 7)}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...s, color: e.target.value }
                  onChange({ ...f, stops: next })
                }}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.at}
                onChange={(e) => {
                  const next = [...stops]
                  next[i] = { ...s, at: Number(e.target.value) }
                  onChange({ ...f, stops: next })
                }}
              />
            </div>
          ))}
          {f.kind === 'linear' && (
            <Num label="Кут" value={f.angle ?? 90} onChange={(v) => onChange({ ...f, angle: v ?? 0 })} />
          )}
          <div className="obe-row">
            <label />
            <button className="ghost" onClick={() => onChange({ ...f, stops: [...stops, { at: 1, color: '#ffffff' }] })}>
              + точка
            </button>
          </div>
        </>
      )}
      {f.kind === 'image' && (
        <div className="obe-row">
          <label>Файл</label>
          <input value={f.image ?? ''} onChange={(e) => onChange({ ...f, image: e.target.value })} />
        </div>
      )}
    </>
  )
}
