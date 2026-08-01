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
