import './module-shell.css'

export function ModuleScaffold({ icon, title, description, children }) {
  return (
    <section className="module-content module-scaffold" aria-labelledby={`module-${title}`}>
      <header className="module-header">
        <div>
          <span className="module-eyebrow">Workspace</span>
          <h1 id={`module-${title}`}>{title}</h1>
          <p>{description}</p>
        </div>
        <span className="module-header-icon" aria-hidden="true">{icon}</span>
      </header>
      <div className="module-body">{children}</div>
    </section>
  )
}

export function ModuleEmptyState({ icon = '✦', title, children }) {
  return (
    <div className="module-empty-state">
      <div className="module-empty-icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}
