import { AppNavigation } from '../navigation/AppNavigation'
import './AppShell.css'

export function AppShell({ activeModule, onNavigate, onOpenSidebar, onOpenProfile, dodo, children }) {
  return (
    <main className="page app-shell-page">
      <section className="messenger app-shell">
        <AppNavigation
          activeId={activeModule}
          onNavigate={onNavigate}
          onOpenSidebar={onOpenSidebar}
          onOpenProfile={onOpenProfile}
        />
        {dodo}
        {children}
      </section>
    </main>
  )
}
