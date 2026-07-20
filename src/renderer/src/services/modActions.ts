import { Account, ModButton } from '../types'
import {
  banUser,
  deleteChatMessage,
  getUsers,
  sendAnnouncement,
  sendShoutout,
  startRaid,
  unbanUser,
  warnUser
} from '../lib/helix'
import { chatService } from './chatService'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { translate } from '../i18n'
import { HttpResponse } from '../lib/http'
import { localizeApiError } from '../lib/apiErrors'

/** turns a few known raw Twitch API errors into a clearer message */
function friendlyMessage(raw: string): string {
  const lang = useSettingsStore.getState().settings.language
  if (raw.includes('must match the user ID')) return translate(lang, 'mod.raidBroadcasterOnly')
  return localizeApiError(raw)
}

export interface ActionContext {
  account: Account
  channel: string
  channelId: string
  paneId?: string
  targetUserId?: string
  targetLogin?: string
  targetMsgId?: string
  targetText?: string
}

function report(res: HttpResponse, okText: string, login?: string): boolean {
  const toast = useUiStore.getState().toast
  if (res.ok) {
    toast(okText, 'ok')
    return true
  }
  const lang = useSettingsStore.getState().settings.language
  const detail = friendlyMessage((res.json as { message?: string })?.message ?? `HTTP ${res.status}`)
  // ALWAYS say which account the action ran under — with several accounts that's the
  // difference between "broken" and "oh, wrong account selected"
  toast(login ? detail + translate(lang, 'err.account', { login }) : detail, 'error')
  return false
}

function fill(template: string, ctx: ActionContext): string {
  return template
    .replaceAll('{user}', ctx.targetLogin ?? '')
    .replaceAll('{channel}', ctx.channel)
    .trim()
}

/** Executes a configured mod button. Raid/announce without preset text are handled by popovers in the UI, not here. */
export async function runModButton(btn: ModButton, ctx: ActionContext): Promise<void> {
  const toast = useUiStore.getState().toast
  try {
    switch (btn.type) {
      case 'timeout': {
        if (!ctx.targetUserId) return
        report(
          await banUser(ctx.account, ctx.channelId, ctx.targetUserId, btn.seconds ?? 600, btn.text || undefined),
          `⏱ ${ctx.targetLogin}`,
          ctx.account.login
        )
        break
      }
      case 'ban': {
        if (!ctx.targetUserId) return
        report(await banUser(ctx.account, ctx.channelId, ctx.targetUserId, undefined, btn.text || undefined), `🔨 ${ctx.targetLogin}`, ctx.account.login)
        break
      }
      case 'unban': {
        if (!ctx.targetUserId) return
        report(await unbanUser(ctx.account, ctx.channelId, ctx.targetUserId), `✅ ${ctx.targetLogin}`, ctx.account.login)
        break
      }
      case 'delete': {
        if (!ctx.targetMsgId) return
        report(await deleteChatMessage(ctx.account, ctx.channelId, ctx.targetMsgId), '🗑️', ctx.account.login)
        break
      }
      case 'warn': {
        if (!ctx.targetUserId) return
        report(
          await warnUser(ctx.account, ctx.channelId, ctx.targetUserId, btn.text || 'Rule violation'),
          `⚠️ ${ctx.targetLogin}`,
          ctx.account.login
        )
        break
      }
      case 'shoutout': {
        const target = ctx.targetUserId
        if (!target) return
        const lang = useSettingsStore.getState().settings.language
        if (report(await sendShoutout(ctx.account, ctx.channelId, target), `📣 ${ctx.targetLogin}`, ctx.account.login)) {
          // shoutouts don't come back through IRC — show the event in chat ourselves
          chatService.localInfo(ctx.channel, translate(lang, 'mod.shoutoutGiven', { user: ctx.targetLogin ?? '' }))
        }
        break
      }
      case 'raid': {
        // message-scope raid: raid the clicked user's channel
        if (!ctx.targetUserId) return
        report(await startRaid(ctx.account, ctx.channelId, ctx.targetUserId), `🚀 ${ctx.targetLogin}`, ctx.account.login)
        break
      }
      case 'announce': {
        if (!btn.text) return
        report(await sendAnnouncement(ctx.account, ctx.channelId, fill(btn.text, ctx), btn.color), '📢', ctx.account.login)
        break
      }
      case 'snippet': {
        if (!btn.text) return
        await chatService.sendMessage(ctx.account, ctx.channel, fill(btn.text, ctx))
        break
      }
      case 'link': {
        if (!btn.text) return
        await chatService.sendMessage(ctx.account, ctx.channel, fill(btn.text, ctx))
        break
      }
      case 'copy': {
        if (ctx.targetText) {
          await navigator.clipboard.writeText(ctx.targetText)
          toast('📋', 'ok')
        }
        break
      }
      case 'resend': {
        // echo the clicked message as your own
        if (!ctx.targetText) return
        await chatService.sendMessage(ctx.account, ctx.channel, ctx.targetText)
        break
      }
      case 'msgToInput': {
        if (!ctx.targetText || !ctx.paneId) return
        window.dispatchEvent(
          new CustomEvent('sticki:insert', { detail: { paneId: ctx.paneId, text: ctx.targetText } })
        )
        break
      }
      case 'fill': {
        if (!btn.text || !ctx.paneId) return
        // fill goes straight into the input — keep spaces exactly as typed (no trim),
        // so templates like "!команда " with a trailing space stay intact
        const text = btn.text.replaceAll('{user}', ctx.targetLogin ?? '').replaceAll('{channel}', ctx.channel)
        window.dispatchEvent(new CustomEvent('sticki:insert', { detail: { paneId: ctx.paneId, text } }))
        break
      }
    }
  } catch (e) {
    toast(String(e), 'error')
  }
}

/** Resolve a login to a user id (for raid/shoutout by name). */
export async function resolveUserId(account: Account, login: string): Promise<string | null> {
  const clean = login.trim().replace(/^@/, '').toLowerCase()
  if (!clean) return null
  const [u] = await getUsers(account, { logins: [clean] })
  return u?.id ?? null
}
