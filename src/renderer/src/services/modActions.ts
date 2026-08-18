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
import { runSlashCommand } from '../lib/slashCommands'
import { confirmDestructive } from '../lib/confirmMod'
import { formatDuration } from '../lib/tokenize'

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

/**
 * Send a button's text the way the input bar would.
 *
 * A button whose text starts with "/" used to go out as a raw PRIVMSG, and Twitch answered
 * "Unrecognized command" — because most of what people think of as chat commands are not chat
 * at all, they are Helix calls the client is expected to make. The input bar has always known
 * that; buttons did not, so the same text worked when typed and failed when clicked. They now
 * take the same path. A leading SPACE still opts out, exactly as it does when typing, for the
 * rare button that really does want to post a literal slash.
 */
async function sendOrRun(text: string, ctx: ActionContext): Promise<void> {
  const msg = text.trim()
  if (!msg) return
  if (msg.startsWith('/') && !text.startsWith(' ')) {
    await runSlashCommand(msg, {
      account: ctx.account,
      channel: ctx.channel,
      channelId: ctx.channelId,
      toast: useUiStore.getState().toast
    })
    return
  }
  await chatService.sendMessage(ctx.account, ctx.channel, text.startsWith(' ') ? ` ${msg}` : text)
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
        // same gate as the swipe: on touch these two ask first, on the desktop they never do
        if (!(await confirmDestructive('timeout', ctx.targetLogin ?? '', formatDuration(btn.seconds ?? 600))))
          return
        report(
          await banUser(ctx.account, ctx.channelId, ctx.targetUserId, btn.seconds ?? 600, btn.text || undefined),
          `⏱ ${ctx.targetLogin}`,
          ctx.account.login
        )
        break
      }
      case 'ban': {
        if (!ctx.targetUserId) return
        if (!(await confirmDestructive('ban', ctx.targetLogin ?? ''))) return
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
        if (!(await confirmDestructive('delete', ctx.targetLogin ?? ''))) return
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
      case 'snippet':
      case 'link': {
        if (!btn.text) return
        await sendOrRun(fill(btn.text, ctx), ctx)
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
