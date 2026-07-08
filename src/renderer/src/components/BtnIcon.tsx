/** Mod-button icon: an emoji string or an image URL. */
export default function BtnIcon({ icon }: { icon?: string }): React.JSX.Element | null {
  if (!icon) return null
  if (/^https?:\/\//i.test(icon)) return <img className="btn-icon" src={icon} alt="" />
  return <span>{icon}</span>
}
