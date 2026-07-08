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

/** turns a few known raw Twitch API errors into a clearer message */
function friendlyMessage(raw: string): string {
  const lang = useSettingsStore.getState().settings.language
  if (raw.includes('must match the user ID')) return translate(lang, 'mod.raidBroadcasterOnly')
  return raw
}

export interface ActionContext {
  account: Account
  channel: string
  channelId: string
  paneId?: string
  targetUserId?: string
  targetLogin?: string
  targetMsgId?: string
}

function report(res: HttpResponse, okText: string): boolean {
  const toast = useUiStore.getState().toast
  if (res.ok) {
    toast(okText, 'ok')
    return true
  }
  const detail = friendlyMessage((res.json as { message?: string })?.message ?? `HTTP ${res.status}`)
  toast(detail, 'error')
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
          `⏱ ${ctx.targetLogin}`
        )
        break
      }
      case 'ban': {
        if (!ctx.targetUserId) return
        report(await banUser(ctx.account, ctx.channelId, ctx.targetUserId, undefined, btn.text || undefined), `🔨 ${ctx.targetLogin}`)
        break
      }
      case 'unban': {
        if (!ctx.targetUserId) return
        report(await unbanUser(ctx.account, ctx.channelId, ctx.targetUserId), `✅ ${ctx.targetLogin}`)
        break
      }
      case 'delete': {
        if (!ctx.targetMsgId) return
        report(await deleteChatMessage(ctx.account, ctx.channelId, ctx.targetMsgId), '🗑️')
        break
      }
      case 'warn': {
        if (!ctx.targetUserId) return
        report(
          await warnUser(ctx.account, ctx.channelId, ctx.targetUserId, btn.text || 'Rule violation'),
          `⚠️ ${ctx.targetLogin}`
        )
        break
      }
      case 'shoutout': {
        const target = ctx.targetUserId
        if (!target) return
        report(await sendShoutout(ctx.account, ctx.channelId, target), `📣 ${ctx.targetLogin}`)
        break
      }
      case 'raid': {
        // message-scope raid: raid the clicked user's channel
        if (!ctx.targetUserId) return
        report(await startRaid(ctx.account, ctx.channelId, ctx.targetUserId), `🚀 ${ctx.targetLogin}`)
        break
      }
      case 'announce': {
        if (!btn.text) return
        report(await sendAnnouncement(ctx.account, ctx.channelId, fill(btn.text, ctx), btn.color), '📢')
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
      case 'fill': {
        if (!btn.text || !ctx.paneId) return
        window.dispatchEvent(
          new CustomEvent('sticki:insert', { detail: { paneId: ctx.paneId, text: fill(btn.text, ctx) } })
        )
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
