import { Account } from '../types'
import {
  banUser,
  cancelRaid,
  deleteChatMessage,
  sendAnnouncement,
  sendShoutout,
  sendWhisper,
  setModerator,
  setVip,
  startRaid,
  unbanUser,
  updateChatSettings,
  warnUser
} from './helix'
import { resolveUserId } from '../services/modActions'
import { chatService } from '../services/chatService'
import { HttpResponse } from './http'

export interface SlashContext {
  account: Account
  channel: string
  channelId: string
  toast: (text: string, kind?: 'ok' | 'error') => void
}

export interface SlashCommand {
  name: string
  usage: string
  /** short description shown in the suggestion list (uk) */
  desc: string
  run: (args: string[], rest: string, ctx: SlashContext) => Promise<void>
}

function ok(res: HttpResponse, ctx: SlashContext, label: string): void {
  if (res.ok) ctx.toast(label, 'ok')
  else ctx.toast((res.json as { message?: string })?.message ?? `HTTP ${res.status}`, 'error')
}

async function userId(ctx: SlashContext, login: string | undefined): Promise<string | null> {
  if (!login) {
    ctx.toast('Вкажи нік користувача', 'error')
    return null
  }
  const id = await resolveUserId(ctx.account, login)
  if (!id) ctx.toast(`Користувача "${login}" не знайдено`, 'error')
  return id
}

function parseDuration(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const m = /^(\d+)([smhd]?)$/.exec(s.trim())
  if (!m) return fallback
  const n = parseInt(m[1], 10)
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 1
  return n * mult
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'me',
    usage: '/me <текст>',
    desc: 'Повідомлення-дія (курсивом)',
    run: async (_a, rest, ctx) => {
      if (rest) await chatService.sendMessage(ctx.account, ctx.channel, `\x01ACTION ${rest}\x01`)
    }
  },
  {
    name: 'timeout',
    usage: '/timeout <нік> [час: 30s 10m 1h 1d] [причина]',
    desc: 'Таймаут користувача',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      const secs = parseDuration(args[1], 600)
      const reason = args.slice(2).join(' ') || undefined
      ok(await banUser(ctx.account, ctx.channelId, id, secs, reason), ctx, `⏱ ${args[0]}`)
    }
  },
  {
    name: 'ban',
    usage: '/ban <нік> [причина]',
    desc: 'Забанити користувача',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      const reason = args.slice(1).join(' ') || undefined
      ok(await banUser(ctx.account, ctx.channelId, id, undefined, reason), ctx, `🔨 ${args[0]}`)
    }
  },
  {
    name: 'unban',
    usage: '/unban <нік>',
    desc: 'Розбанити / зняти таймаут',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await unbanUser(ctx.account, ctx.channelId, id), ctx, `✅ ${args[0]}`)
    }
  },
  {
    name: 'untimeout',
    usage: '/untimeout <нік>',
    desc: 'Зняти таймаут',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await unbanUser(ctx.account, ctx.channelId, id), ctx, `✅ ${args[0]}`)
    }
  },
  {
    name: 'warn',
    usage: '/warn <нік> <причина>',
    desc: 'Офіційне попередження',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      const reason = args.slice(1).join(' ') || 'Rule violation'
      ok(await warnUser(ctx.account, ctx.channelId, id, reason), ctx, `⚠️ ${args[0]}`)
    }
  },
  {
    name: 'clear',
    usage: '/clear',
    desc: 'Очистити весь чат',
    run: async (_a, _r, ctx) => {
      ok(await deleteChatMessage(ctx.account, ctx.channelId), ctx, '🧹')
    }
  },
  {
    name: 'raid',
    usage: '/raid <канал>',
    desc: 'Почати рейд',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await startRaid(ctx.account, ctx.channelId, id), ctx, `🚀 ${args[0]}`)
    }
  },
  {
    name: 'unraid',
    usage: '/unraid',
    desc: 'Скасувати рейд',
    run: async (_a, _r, ctx) => {
      ok(await cancelRaid(ctx.account, ctx.channelId), ctx, '↩️')
    }
  },
  {
    name: 'shoutout',
    usage: '/shoutout <нік>',
    desc: 'Шатаут каналу',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await sendShoutout(ctx.account, ctx.channelId, id), ctx, `📣 ${args[0]}`)
    }
  },
  {
    name: 'announce',
    usage: '/announce <текст>',
    desc: 'Надіслати анонс',
    run: async (_a, rest, ctx) => {
      if (rest) ok(await sendAnnouncement(ctx.account, ctx.channelId, rest), ctx, '📢')
    }
  },
  {
    name: 'announceblue',
    usage: '/announceblue <текст>',
    desc: 'Анонс (синій)',
    run: async (_a, rest, ctx) => {
      if (rest) ok(await sendAnnouncement(ctx.account, ctx.channelId, rest, 'blue'), ctx, '📢')
    }
  },
  {
    name: 'announcegreen',
    usage: '/announcegreen <текст>',
    desc: 'Анонс (зелений)',
    run: async (_a, rest, ctx) => {
      if (rest) ok(await sendAnnouncement(ctx.account, ctx.channelId, rest, 'green'), ctx, '📢')
    }
  },
  {
    name: 'announceorange',
    usage: '/announceorange <текст>',
    desc: 'Анонс (помаранчевий)',
    run: async (_a, rest, ctx) => {
      if (rest) ok(await sendAnnouncement(ctx.account, ctx.channelId, rest, 'orange'), ctx, '📢')
    }
  },
  {
    name: 'announcepurple',
    usage: '/announcepurple <текст>',
    desc: 'Анонс (фіолетовий)',
    run: async (_a, rest, ctx) => {
      if (rest) ok(await sendAnnouncement(ctx.account, ctx.channelId, rest, 'purple'), ctx, '📢')
    }
  },
  {
    name: 'slow',
    usage: '/slow [секунди]',
    desc: 'Повільний режим',
    run: async (args, _r, ctx) => {
      const secs = parseInt(args[0] ?? '30', 10) || 30
      ok(
        await updateChatSettings(ctx.account, ctx.channelId, { slow_mode: true, slow_mode_wait_time: secs }),
        ctx,
        `🐢 ${secs}s`
      )
    }
  },
  {
    name: 'slowoff',
    usage: '/slowoff',
    desc: 'Вимкнути повільний режим',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { slow_mode: false }), ctx, '🐢✕')
    }
  },
  {
    name: 'followers',
    usage: '/followers [хвилини]',
    desc: 'Режим лише для фоловерів',
    run: async (args, _r, ctx) => {
      const mins = parseInt(args[0] ?? '0', 10) || 0
      ok(
        await updateChatSettings(ctx.account, ctx.channelId, {
          follower_mode: true,
          follower_mode_duration: mins
        }),
        ctx,
        '💜'
      )
    }
  },
  {
    name: 'followersoff',
    usage: '/followersoff',
    desc: 'Вимкнути followers-режим',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { follower_mode: false }), ctx, '💜✕')
    }
  },
  {
    name: 'subscribers',
    usage: '/subscribers',
    desc: 'Чат лише для сабів',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { subscriber_mode: true }), ctx, '⭐')
    }
  },
  {
    name: 'subscribersoff',
    usage: '/subscribersoff',
    desc: 'Вимкнути saby-режим',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { subscriber_mode: false }), ctx, '⭐✕')
    }
  },
  {
    name: 'emoteonly',
    usage: '/emoteonly',
    desc: 'Чат лише емоутами',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { emote_mode: true }), ctx, '😀')
    }
  },
  {
    name: 'emoteonlyoff',
    usage: '/emoteonlyoff',
    desc: 'Вимкнути emote-only',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { emote_mode: false }), ctx, '😀✕')
    }
  },
  {
    name: 'uniquechat',
    usage: '/uniquechat',
    desc: 'Режим унікальних повідомлень',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { unique_chat_mode: true }), ctx, '🔁')
    }
  },
  {
    name: 'uniquechatoff',
    usage: '/uniquechatoff',
    desc: 'Вимкнути унікальні повідомлення',
    run: async (_a, _r, ctx) => {
      ok(await updateChatSettings(ctx.account, ctx.channelId, { unique_chat_mode: false }), ctx, '🔁✕')
    }
  },
  {
    name: 'mod',
    usage: '/mod <нік>',
    desc: 'Видати модерку (лише стрімер)',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await setModerator(ctx.account, ctx.channelId, id, true), ctx, `🛡 ${args[0]}`)
    }
  },
  {
    name: 'unmod',
    usage: '/unmod <нік>',
    desc: 'Забрати модерку (лише стрімер)',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await setModerator(ctx.account, ctx.channelId, id, false), ctx, `🛡✕ ${args[0]}`)
    }
  },
  {
    name: 'vip',
    usage: '/vip <нік>',
    desc: 'Видати VIP (лише стрімер)',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await setVip(ctx.account, ctx.channelId, id, true), ctx, `💎 ${args[0]}`)
    }
  },
  {
    name: 'unvip',
    usage: '/unvip <нік>',
    desc: 'Забрати VIP (лише стрімер)',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      ok(await setVip(ctx.account, ctx.channelId, id, false), ctx, `💎✕ ${args[0]}`)
    }
  },
  {
    name: 'w',
    usage: '/w <нік> <текст>',
    desc: 'Особисте повідомлення (whisper)',
    run: async (args, _r, ctx) => {
      const id = await userId(ctx, args[0])
      if (!id) return
      const text = args.slice(1).join(' ')
      if (!text) return
      ok(await sendWhisper(ctx.account, id, text), ctx, `💬 ${args[0]}`)
    }
  },
  {
    name: 'pin',
    usage: '/pin',
    desc: 'Недоступно: Twitch не має API для піна',
    run: async (_a, _r, ctx) => {
      ctx.toast('Twitch поки не має публічного API для закріплення — використай /announce', 'error')
    }
  }
]

export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const typed = input.slice(1).split(' ')[0].toLowerCase()
  if (input.includes(' ')) {
    // command fully typed — show just its usage while typing args
    const exact = SLASH_COMMANDS.find((c) => c.name === typed)
    return exact ? [exact] : []
  }
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed)).slice(0, 12)
}

/** Returns true if the text was handled as a command (or rejected as unknown). */
export async function runSlashCommand(text: string, ctx: SlashContext): Promise<boolean> {
  if (!text.startsWith('/')) return false
  const parts = text.slice(1).split(' ').filter(Boolean)
  const name = (parts.shift() ?? '').toLowerCase()
  const cmd = SLASH_COMMANDS.find((c) => c.name === name)
  if (!cmd) {
    ctx.toast(`Невідома команда: /${name}`, 'error')
    return true
  }
  const rest = text.slice(1 + name.length).trim()
  await cmd.run(parts, rest, ctx)
  return true
}
