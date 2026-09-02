import { useEffect, useState } from 'react'
import { Account } from '../types'
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
 * scoped token everything else uses. VOTING is the other half and is not offered — it lives only
 * in Twitch's own client, behind the same wall as GIF messages.
 *
 * The two new scopes mean an account authorized before this existed will get a 401 with "missing
 * scope" until it signs in again; that message is shown rather than swallowed.
 */
export default function PollPanel({ account, broadcasterId }: Props): React.JSX.Element {
  const t = useT()
  const [kind, setKind] = useState<'poll' | 'prediction'>('poll')
  const [title, setTitle] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [minutes, setMinutes] = useState(2)
  const [busy, setBusy] = useState(false)
  const [poll, setPoll] = useState<HelixPoll | null>(null)
  const [pred, setPred] = useState<HelixPrediction | null>(null)

  /** what is running right now — refreshed on open and after every action, not on a timer */
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

  const run = async (fn: () => Promise<{ ok: boolean; status: number; json: unknown; text: string }>): Promise<void> => {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      useUiStore.getState().toast(describeHelixError(res), 'error')
      return
    }
    setTitle('')
    setOptions(['', ''])
    await refresh()
  }

  const clean = options.map((o) => o.trim()).filter(Boolean)
  const canStart = title.trim().length > 0 && clean.length >= 2

  const running = kind === 'poll' ? poll : pred
  const total =
    kind === 'poll'
      ? (poll?.choices ?? []).reduce((n, c) => n + c.votes, 0)
      : (pred?.outcomes ?? []).reduce((n, o) => n + o.users, 0)

  return (
    <div className="poll-panel">
      <div className="poll-tabs">
        <button className={kind === 'poll' ? 'primary' : ''} onClick={() => setKind('poll')}>
          {t('poll.poll')}
        </button>
        <button className={kind === 'prediction' ? 'primary' : ''} onClick={() => setKind('prediction')}>
          {t('poll.prediction')}
        </button>
      </div>

      {running ? (
        <>
          <div className="poll-running-title">{running.title}</div>
          {/* a bar each, so "which way is it going" is answered without reading numbers */}
          {kind === 'poll'
            ? poll!.choices.map((c) => (
                <div key={c.id} className="poll-bar-row">
                  <div className="poll-bar" style={{ width: `${total ? (c.votes / total) * 100 : 0}%` }} />
                  <span className="poll-bar-label">
                    {c.title} — {c.votes}
                  </span>
                </div>
              ))
            : pred!.outcomes.map((o) => (
                <div key={o.id} className="poll-bar-row">
                  <div className="poll-bar" style={{ width: `${total ? (o.users / total) * 100 : 0}%` }} />
                  <span className="poll-bar-label">
                    {o.title} — {o.users} · {o.points}
                  </span>
                </div>
              ))}
          <div className="poll-actions">
            {kind === 'poll' ? (
              <>
                <button disabled={busy} onClick={() => void run(() => endPoll(account, broadcasterId, poll!.id, 'TERMINATED'))}>
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
                    onClick={() => void run(() => endPrediction(account, broadcasterId, pred!.id, 'LOCKED'))}
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
                      void run(() => endPrediction(account, broadcasterId, pred!.id, 'RESOLVED', o.id))
                    }
                  >
                    {t('poll.payOut')}: {o.title}
                  </button>
                ))}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => endPrediction(account, broadcasterId, pred!.id, 'CANCELED'))}
                >
                  {t('poll.refund')}
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <input
            autoFocus
            placeholder={t('poll.title')}
            value={title}
            maxLength={45}
            onChange={(e) => setTitle(e.target.value)}
          />
          {options.map((o, i) => (
            <input
              key={i}
              placeholder={`${t('poll.option')} ${i + 1}`}
              value={o}
              maxLength={25}
              onChange={(e) => setOptions((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          ))}
          {/* Twitch caps polls at five choices and predictions at ten */}
          {options.length < (kind === 'poll' ? 5 : 10) && (
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
              onChange={(e) => setMinutes(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 2)))}
            />
            <span>{t('poll.minutes')}</span>
          </div>
          <button
            className="primary"
            disabled={!canStart || busy}
            onClick={() =>
              void run(() =>
                kind === 'poll'
                  ? createPoll(account, broadcasterId, title.trim(), clean, minutes * 60)
                  : createPrediction(account, broadcasterId, title.trim(), clean, minutes * 60)
              )
            }
          >
            {t('poll.start')}
          </button>
          <div className="poll-note">{t('poll.noVoting')}</div>
        </>
      )}
    </div>
  )
}
