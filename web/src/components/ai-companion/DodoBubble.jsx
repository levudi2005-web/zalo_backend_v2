import './DodoCompanion.css'

export function DodoBubble({ children, style }) {
  if (!children) return null

  return (
    <div className="dodo-bubble" style={style} role="status" aria-live="polite">
      {children}
    </div>
  )
}
