import { useEffect, useState } from 'react'
import { Account, PollPreset } from '../types'
import {
  createPoll,
  endPoll,
  getPolls,
  createPrediction,
  endPrediction,
  getPredictions,
  describeHelixError,
  type HelixPoll,
  type HelixPrediction
} from '../lib/helix'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'

interface Props {
  account: Account
  broadcasterId: string
}

/**
 * Starting and finishing polls and predictions from the app.
 *
 * The broadcaster half of both features, and the reason it exists here at all is that it is the
 * half Twitch actually documents: Helix creates, terminates, locks and resolves them with the same
 * scoped token everything else uses. Voting is the other half and is not offered, because it lives
 * only in Twitch's own client.
 *
 * Everything typed here is kept. The draft survives closing the panel or the whole window, and a
 * question worth asking twice can be saved as a preset and run with one click. A stream repeats
 * itself, and retyping the same prediction every match is the entire friction of the feature.
 */
export default function PollPanel({ account, broadcasterId }: Props): React.JSX.Element {
  const t = useT()
  const draft = useSettingsStore((s) => s.settings.pollDraft)
  const presets = useSettingsStore((s) => s.settings.pollPresets)

  const [kind, setKind] = useState<'poll' | 'prediction'>(draft?.kind ?? 'poll')
  const [title, setTitle] = useState(draft?.title ?? '')
  const [options, setOptions] = useState<string[]>(draft?.options ?? ['', ''])
  const [minutes, setMinutes] = useState(draft?.minutes ?? 2)
  const [pointsPerVote, setPointsPerVote] = useState(draft?.pointsPerVote ?? 0)
  const [busy, setBusy] = useState(false)
  const [poll, setPoll] = useState<HelixPoll | null>(null)
  const [pred, setPred] = useState<HelixPrediction | null>(null)
  const [saving, setSaving] = useState(false)
  const [presetName, setPresetName] = useState('')

  /*
   * Every keystroke goes to the settings store, which is what the config writer already watches.
   * Keeping it in component state alone was the bug being fixed: the panel is a popover, and a
   * popover closes for all sorts of reasons that have nothing to do with being finished.
   */
  useEffect(() => {
    useSettingsStore.getState().setSettings({
      pollDraft: { kind, title, options, minutes, pointsPerVote }
    })
  }, [kind, title, options, minutes, pointsPerVote])

  /** what is running right now, refreshed on open and after every action rather than on a timer */
  const refresh = async (): Promise<void> => {
    const [polls, preds] = await Promise.all([
      getPolls(account, broadcasterId),
      getPredictions(account, broadcasterId)
    ])
    setPoll(polls.find((p) => p.status === 'ACTIVE') ?? null)
    setPred(preds.find((p) => p.status === 'ACTIVE' || p.status === 'LOCKED') ?? null)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcasterId])

  const run = async (
    fn: () => Promise<{ ok: boolean; status: number; json: unknown; text: string }>
  ): Promise<void> => {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      useUiStore.getState().toast(describeHelixError(res), 'error')
      return
    }
    await refresh()
  }

  const clean = options.map((o) => o.trim()).filter(Boolean)
  const canStart = title.trim().length > 0 && clean.length >= 2
  const maxOptions = kind === 'poll' ? 5 : 10

  const applyPreset = (p: PollPreset): void => {
    setKind(p.kind)
    setTitle(p.title)
    setOptions(p.options.length >= 2 ? p.options : [...p.options, '', ''].slice(0, 2))
    setMinutes(p.minutes)
    setPointsPerVote(p.pointsPerVote ?? 0)
  }

  const savePreset = (): void => {
    const name = presetName.trim() || title.trim()
    if (!name) return
    const st = useSettingsStore.getState()
    st.setSettings({
      pollPresets: [
        ...st.settings.pollPresets,
        {
          id: `pp-${Date.now().toString(36)}`,
          name,
          kind,
          title: title.trim(),
          options: clean,
          minutes,
          ...(kind === 'poll' && pointsPerVote > 0 ? { pointsPerVote } : {})
        }
      ]
    })
    setPresetName('')
    setSaving(false)
  }

  /*
   * Polls and predictions need two scopes that did not exist when most people signed in, and a
   * token cannot grow new ones. Saying so up front is the whole point: the alternative is a
   * button that looks fine and can only ever answer 401.
   */
  const scopes = account._scopes
  const missingScope =
    scopes !== undefined &&
    !scopes.includes(kind === 'poll' ? 'channel:manage:polls' : 'channel:manage:predictions')

  const running = kind === 'poll' ? poll : pred
  const total =
    kind === 'poll'
      ? (poll?.choices ?? []).reduce((n, c) => n + c.votes, 0)
      : (pred?.outcomes ?? []).reduce((n, o) => n + o.users, 0)

  const mine = presets.filter((p) => p.kind === kind)

  return (
    <div className="poll-panel">
      <div className="poll-tabs">
        <button className={kind === 'poll' ? 'primary' : ''} onClick={() => setKind('poll')}>
          {t('poll.poll')}
        </button>
        <button
          className={kind === 'prediction' ? 'primary' : ''}
          onClick={() => setKind('prediction')}
        >
          {t('poll.prediction')}
        </button>
      </div>

      {missingScope ? (
        <div className="poll-noscope">
          <p>{t('poll.needScope')}</p>
          <button className="primary" onClick={() => useUiStore.getState().setAddAccountOpen(true)}>
            {t('poll.reauth')}
          </button>
        </div>
      ) : running ? (
        <>
          <div className="poll-running-title">{running.title}</div>
          {/* a bar each, so "which way is it going" is answered without reading numbers */}
          {kind === 'poll'
            ? poll!.choices.map((c) => (
                <div key={c.id} className="poll-bar-row">
                  <div
                    className="poll-bar"
                    style={{ width: `${total ? (c.votes / total) * 100 : 0}%` }}
                  />
                  <span className="poll-bar-label">
                    {c.title}: {c.votes}
                  </span>
                </div>
              ))
            : pred!.outcomes.map((o) => (
                <div key={o.id} className="poll-bar-row">
                  <div
                    className="poll-bar"
                    style={{ width: `${total ? (o.users / total) * 100 : 0}%` }}
                  />
                  <span className="poll-bar-label">
                    {o.title}: {o.users} ({o.points})
                  </span>
                </div>
              ))}
          <div className="poll-actions">
            {kind === 'poll' ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => void run(() => endPoll(account, broadcasterId, poll!.id, 'TERMINATED'))}
                >
                  {t('poll.finish')}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => endPoll(account, broadcasterId, poll!.id, 'ARCHIVED'))}
                >
                  {t('poll.archive')}
                </button>
              </>
            ) : (
              <>
                {pred!.status === 'ACTIVE' && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() => endPrediction(account, broadcasterId, pred!.id, 'LOCKED'))
                    }
                  >
                    {t('poll.lock')}
                  </button>
                )}
                {/* resolving needs an outcome, so each one is its own button */}
                {pred!.outcomes.map((o) => (
                  <button
                    key={o.id}
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        endPrediction(account, broadcasterId, pred!.id, 'RESOLVED', o.id)
                      )
                    }
                  >
                    {t('poll.payOut')}: {o.title}
                  </button>
                ))}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => endPrediction(account, broadcasterId, pred!.id, 'CANCELED'))
                  }
                >
                  {t('poll.refund')}
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {mine.length > 0 && (
            <div className="poll-presets">
              {mine.map((p) => (
                <span key={p.id} className="poll-preset">
                  <button className="poll-preset-use" onClick={() => applyPreset(p)} title={p.title}>
                    {p.name}
                  </button>
                  <button
                    className="poll-preset-del"
                    title={t('poll.presetDelete')}
                    onClick={() => {
                      const st = useSettingsStore.getState()
                      st.setSettings({
                        pollPresets: st.settings.pollPresets.filter((x) => x.id !== p.id)
                      })
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            autoFocus
            placeholder={t('poll.title')}
            value={title}
            maxLength={45}
            onChange={(e) => setTitle(e.target.value)}
          />
          {options.map((o, i) => (
            <div key={i} className="poll-option-row">
              <input
                placeholder={`${t('poll.option')} ${i + 1}`}
                value={o}
                maxLength={25}
                onChange={(e) =>
                  setOptions((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
              />
              {/* two is Twitch's floor, so the last pair keeps no remove button */}
              {options.length > 2 && (
                <button
                  className="poll-option-del"
                  title={t('poll.optionDelete')}
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < maxOptions && (
            <button className="ghost" onClick={() => setOptions((p) => [...p, ''])}>
              + {t('poll.option')}
            </button>
          )}

          <div className="poll-duration">
            <label>{kind === 'poll' ? t('poll.duration') : t('poll.window')}</label>
            <input
              type="number"
              min={1}
              max={30}
              value={minutes}
              onChange={(e) =>
                setMinutes(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 2)))
              }
            />
            <span>{t('poll.minutes')}</span>
          </div>

          {/* predictions are paid in points by definition; only a poll has the choice */}
          {kind === 'poll' && (
            <>
              <div className="poll-duration">
                <label>{t('poll.pointsPerVote')}</label>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={pointsPerVote}
                  onChange={(e) => setPointsPerVote(Math.max(0, parseInt(e.target.value, 10) || 0))}
                />
              </div>
              <div className="poll-note">{t('poll.pointsHint')}</div>
            </>
          )}

          <button
            className="primary"
            disabled={!canStart || busy}
            onClick={() =>
              void run(() =>
                kind === 'poll'
                  ? createPoll(account, broadcasterId, title.trim(), clean, minutes * 60, pointsPerVote)
                  : createPrediction(account, broadcasterId, title.trim(), clean, minutes * 60)
              )
            }
          >
            {t('poll.start')}
          </button>

          {saving ? (
            <div className="poll-save-row">
              <input
                autoFocus
                placeholder={t('poll.presetName')}
                value={presetName}
                maxLength={24}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') savePreset()
                  if (e.key === 'Escape') setSaving(false)
                }}
              />
              <button className="primary" onClick={savePreset}>
                {t('misc.save')}
              </button>
            </div>
          ) : (
            <button className="ghost" disabled={!canStart} onClick={() => setSaving(true)}>
              ★ {t('poll.savePreset')}
            </button>
          )}

          <div className="poll-note">{t('poll.noVoting')}</div>
        </>
      )}
    </div>
  )
}
