/**
 * Small monochrome UI glyphs shared across windows. They inherit `currentColor`, so a button's
 * hover/disabled state styles the icon for free — which text labels like "A−" never did.
 */

/** the layout-swap glyph shown on the translit button (A ⇄ Ф) */
export function TranslitIcon({ size = 21 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <text x="7" y="11.5" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="currentColor">
        A
      </text>
      <text x="17" y="23" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="currentColor">
        Ф
      </text>
      <g stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10 V7.5 Q21 5 18.5 5 H14.5" />
        <path d="M16.5 2.5 L14 5 L16.5 7.5" />
        <path d="M3 14 V16.5 Q3 19 5.5 19 H9.5" />
        <path d="M7.5 16.5 L10 19 L7.5 21.5" />
      </g>
    </svg>
  )
}

/** magnifier with a + or − inside — replaces the old "A+" / "A−" text zoom buttons */
export function ZoomIcon({ dir, size = 15 }: { dir: 'in' | 'out'; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.5 15.5 L21 21" />
        <path d="M7.5 10.5 H13.5" />
        {dir === 'in' && <path d="M10.5 7.5 V13.5" />}
      </g>
    </svg>
  )
}

/**
 * The rest of the UI glyph set.
 *
 * These replace emoji that were being used as icons (🔊 📌 ⚙ 🎨 ▶ 🗑 …). Emoji are FONT
 * data: Windows 10 and 11 ship different Segoe UI Emoji builds, so the same button looked
 * different on two machines, sat on its own baseline, and could not take the button's colour.
 * A stroked SVG on `currentColor` is the same everywhere and inherits hover/disabled for free.
 *
 * All of them share one 24x24 grid and a 2px stroke so they read as one family.
 */
function Glyph({
  size = 15,
  children
}: {
  size?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>
    </svg>
  )
}

export function SpeakerIcon({ muted, size }: { muted?: boolean; size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M4 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4 Z" />
      {muted ? (
        <>
          <path d="M16 9.5 L21 14.5" />
          <path d="M21 9.5 L16 14.5" />
        </>
      ) : (
        <>
          <path d="M15.5 9 Q17.5 12 15.5 15" />
          <path d="M18.5 6.5 Q22 12 18.5 17.5" />
        </>
      )}
    </Glyph>
  )
}

export function PinIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M9 3 H15 L14 9 L18.5 12.5 H5.5 L10 9 Z" />
      <path d="M12 12.5 V21" />
    </Glyph>
  )
}

export function GearIcon({ size = 17 }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="3.4" />
      <circle cx="12" cy="12" r="7.6" />
      <path d="M12 1.6 V4.4 M12 19.6 V22.4 M1.6 12 H4.4 M19.6 12 H22.4 M4.7 4.7 L6.7 6.7 M17.3 17.3 L19.3 19.3 M19.3 4.7 L17.3 6.7 M6.7 17.3 L4.7 19.3" />
    </Glyph>
  )
}

export function MailIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7 L12 13 L20.5 7" />
    </Glyph>
  )
}

export function PaletteIcon({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M12 3.5 A8.5 8.5 0 1 0 12 20.5 Q14.8 20.5 14.8 18.4 Q14.8 16.4 16.8 16.4 H18.6 A2.2 2.2 0 0 0 20.5 14.2 Q20.5 8.1 12 3.5 Z" />
      <circle cx="8.6" cy="8.8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="7.3" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="6.9" cy="13.6" r="1.5" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function PlayIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M7.5 4.8 L19 12 L7.5 19.2 Z" />
    </Glyph>
  )
}

export function TrashIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M4 6.5 H20" />
      <path d="M9.5 6.5 V4.5 H14.5 V6.5" />
      <path d="M6 6.5 L7 20 H17 L18 6.5" />
      <path d="M10.2 10 V16.5 M13.8 10 V16.5" />
    </Glyph>
  )
}

export function NoteIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M9.5 17.5 V5 L19 3 V15.5" />
      <circle cx="7" cy="17.5" r="2.6" />
      <circle cx="16.5" cy="15.5" r="2.6" />
    </Glyph>
  )
}

export function EyeIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M2.5 12 Q7 5.5 12 5.5 Q17 5.5 21.5 12 Q17 18.5 12 18.5 Q7 18.5 2.5 12 Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Glyph>
  )
}

export function ClockIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 6.8 V12 L15.6 14.2" />
    </Glyph>
  )
}

export function GameIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M7.5 7.5 H16.5 A5.5 5.5 0 0 1 21 16 Q20 19 17.5 17.5 L15 15.5 H9 L6.5 17.5 Q4 19 3 16 A5.5 5.5 0 0 1 7.5 7.5 Z" />
      <path d="M7 11 V13.5 M5.8 12.2 H8.2" />
      <circle cx="16.3" cy="12.2" r="1" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function StarIcon({ filled, size }: { filled?: boolean; size?: number }): React.JSX.Element {
  return (
    <svg width={size ?? 15} height={size ?? 15} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3.2 L14.7 9 L21 9.8 L16.4 14.1 L17.6 20.4 L12 17.3 L6.4 20.4 L7.6 14.1 L3 9.8 L9.3 9 Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

/** the padlock, shut or with its shackle swung open */
export function LockIcon({ open, size }: { open?: boolean; size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      {open ? (
        <path d="M8.2 10.5 V7.8 A3.8 3.8 0 0 1 15.8 7.8" />
      ) : (
        <path d="M8.2 10.5 V7.8 A3.8 3.8 0 0 1 15.8 7.8 V10.5" />
      )}
    </Glyph>
  )
}

/**
 * Two figures: the chatters list.
 *
 * One person already means "account" elsewhere in the app, so the list of everyone watching is
 * drawn as a pair, the second one half behind the first.
 */
export function PeopleIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="9.2" cy="8.6" r="3.3" />
      <path d="M3.5 19.4 C3.5 16 6 14.2 9.2 14.2 C12.4 14.2 14.9 16 14.9 19.4" />
      <path d="M16.2 5.8 A3.3 3.3 0 0 1 16.2 11.6" />
      <path d="M17.4 14.6 C19.6 15.2 21 16.9 21 19.4" />
    </Glyph>
  )
}

/** a page with an arrow leaving it: opening this somewhere outside the app */
export function ExternalIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M18.6 13.8 V18.4 A1.9 1.9 0 0 1 16.7 20.3 H5.9 A1.9 1.9 0 0 1 4 18.4 V7.6 A1.9 1.9 0 0 1 5.9 5.7 H10.4" />
      <path d="M13.6 4.4 H19.6 V10.4" />
      <path d="M19.6 4.4 L11.4 12.6" />
    </Glyph>
  )
}

/**
 * A chain, struck through when this chat scrolls on its own.
 *
 * Two links pulled apart read as two commas at fifteen pixels; the same slash a muted speaker
 * wears says "not joined" at a glance and cannot be mistaken for anything else.
 */
export function ChainIcon({ broken, size }: { broken?: boolean; size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M10.2 13.8 L8.4 15.6 A3.6 3.6 0 0 1 3.3 10.5 L6.6 7.2 A3.6 3.6 0 0 1 11.7 12.3" />
      <path d="M13.8 10.2 L15.6 8.4 A3.6 3.6 0 0 1 20.7 13.5 L17.4 16.8 A3.6 3.6 0 0 1 12.3 11.7" />
      {broken && <path d="M4.4 19.6 L19.6 4.4" />}
    </Glyph>
  )
}

export function ImageIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M3.5 16.5 L9 11.5 L14 16 L17 13.5 L20.5 16.5" />
    </Glyph>
  )
}

/** paired import/export arrows — same tray, arrow points in or out */
export function TrayArrowIcon({ dir, size }: { dir: 'in' | 'out'; size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M4 15.5 V19 A1.5 1.5 0 0 0 5.5 20.5 H18.5 A1.5 1.5 0 0 0 20 19 V15.5" />
      {dir === 'in' ? (
        <path d="M12 3.5 V15 M8 11 L12 15 L16 11" />
      ) : (
        <path d="M12 15 V3.5 M8 7.5 L12 3.5 L16 7.5" />
      )}
    </Glyph>
  )
}

export function PencilIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M4 20 L4.9 16.2 L16.1 5 A2.1 2.1 0 0 1 19 8 L7.8 19.1 Z" />
      <path d="M14.5 6.6 L17.4 9.5" />
    </Glyph>
  )
}

export function CloseIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M6 6 L18 18 M18 6 L6 18" />
    </Glyph>
  )
}

export function PlusIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M12 5 V19 M5 12 H19" />
    </Glyph>
  )
}

export function AlertIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M12 3.4 L21.6 20 H2.4 Z" />
      <path d="M12 9.6 V14.2" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function InfoIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11 V16.4" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

/** the 7TV wordmark, for the emote-set-change card */
export function SevenTvMark(): React.JSX.Element {
  return (
    <svg className="stv-mark" viewBox="0 0 109.6 80.9" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M84.1 22.2 88 15.5l3.7-6.3.4-.8c.1-.2 0-.4-.2-.4H60.7c-.2 0-.4.2-.4.4v11.9c0 .2.2.4.4.4h23.2c.1 0 .2-.2.2-.5zM53.4 8H20.6c-.2 0-.4.1-.5.3l-3.9 6.7-3.7 6.3-.4.8c-.1.2 0 .4.2.4h32.8c.2 0 .4-.1.5-.3l3.9-6.7 3.7-6.3.4-.8c.1-.2 0-.4-.2-.4zM60.3 72.6l3.9-6.7 3.7-6.3.4-.8c.1-.2 0-.4-.2-.4H35.3c-.2 0-.4.1-.5.3l-3.9 6.7-3.7 6.3-.4.8c-.1.2 0 .4.2.4h32.8c.2 0 .4-.1.5-.3z"
      />
      <path
        fill="currentColor"
        d="m8.1 30.3 3.9 6.7 3.7 6.3.4.8c.1.2.3.3.5.3h32.8c.2 0 .3-.2.2-.4l-.4-.8-3.7-6.3-3.9-6.7c-.1-.2-.3-.3-.5-.3H8.3c-.2 0-.3.2-.2.4zM97.5 30.2H64.7c-.2 0-.4.1-.5.3l-3.9 6.7-3.7 6.3-.4.8c-.1.2 0 .4.2.4h32.8c.2 0 .4-.1.5-.3l3.9-6.7 3.7-6.3.4-.8c.1-.2 0-.4-.2-.4z"
      />
    </svg>
  )
}

/** a person in a circle: signing the PLAYER in to Twitch, not the app */
export function PersonIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5 C5.5 15.9 8.4 14 12 14 C15.6 14 18.5 15.9 18.5 19.5" />
    </Glyph>
  )
}

/**
 * The two arrangements, drawn as what they are: a frame split top/bottom or left/right, with the
 * video half filled in. A pair of block characters said nothing about which was which.
 */
export function LayoutIcon({ side, size }: { side?: boolean; size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      {side ? (
        <>
          <path d="M14 4.5 V19.5" />
          <path d="M4.5 6.5 H13 V17.5 H4.5 Z" fill="currentColor" stroke="none" opacity="0.45" />
        </>
      ) : (
        <>
          <path d="M3.5 14 H20.5" />
          <path d="M4.5 5.5 H19.5 V13 H4.5 Z" fill="currentColor" stroke="none" opacity="0.45" />
        </>
      )}
    </Glyph>
  )
}

/** a globe: the whole twitch.tv page rather than just its player */
export function GlobeIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12 H20.5" />
      <path d="M12 3.5 C15 7 15 17 12 20.5 C9 17 9 7 12 3.5 Z" />
    </Glyph>
  )
}

/** a shield: AutoMod, holding something back */
export function ShieldIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M12 3.5 L19.5 6.5 V12 C19.5 16.2 16.4 19.4 12 20.5 C7.6 19.4 4.5 16.2 4.5 12 V6.5 Z" />
    </Glyph>
  )
}

/** a heart: the channels this account follows */
export function HeartIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M12 20 C6 16.2 3.5 13 3.5 9.7 A4.2 4.2 0 0 1 12 7.6 A4.2 4.2 0 0 1 20.5 9.7 C20.5 13 18 16.2 12 20 Z" />
    </Glyph>
  )
}
