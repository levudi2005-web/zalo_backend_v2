import { useEffect, useState } from 'react'
import { AVAILABLE_NAVIGATION_ITEMS } from './navigation.config'

const PRIMARY_MOBILE_IDS = new Set(['chat', 'friends', 'stories', 'notifications'])
const PRIMARY_DESKTOP_IDS = new Set(['chat', 'friends', 'stories', 'notifications', 'calls'])

function NavigationItem({ item, active, onClick, mobile = false }) {
  return (
    <button
      type="button"
      className={`nav-icon${active ? ' active' : ''}${mobile ? ' mobile-nav-icon' : ''}`}
      onClick={() => onClick?.(item.id)}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      title={mobile ? undefined : item.label}
    >
      <span className="nav-icon-symbol" aria-hidden="true">{item.icon}</span>
      <span className="nav-label">{item.label}</span>
    </button>
  )
}

export function AppNavigation({ activeId = 'chat', onNavigate, onOpenSidebar, onOpenProfile }) {
  const primaryItems = AVAILABLE_NAVIGATION_ITEMS.filter((item) => PRIMARY_MOBILE_IDS.has(item.id))
  const moreItems = AVAILABLE_NAVIGATION_ITEMS.filter((item) => !PRIMARY_MOBILE_IDS.has(item.id))
  const desktopPrimaryItems = AVAILABLE_NAVIGATION_ITEMS.filter((item) => PRIMARY_DESKTOP_IDS.has(item.id))
  const desktopSecondaryItems = AVAILABLE_NAVIGATION_ITEMS.filter((item) => !PRIMARY_DESKTOP_IDS.has(item.id))

  return (
    <>
      <aside className="nav-rail" aria-label="Điều hướng chính">
        <button
          className="logo"
          type="button"
          onClick={onOpenSidebar}
          aria-label="Mở danh sách trò chuyện"
        >
          N
        </button>

        <nav className="nav-items" aria-label="Khu vực ứng dụng">
          {desktopPrimaryItems.map((item) => (
            <NavigationItem
              key={item.id}
              item={item}
              active={item.id === activeId}
              onClick={onNavigate}
            />
          ))}
        </nav>

        <div className="nav-bottom">
          {desktopSecondaryItems.map((item) => (
            <NavigationItem
              key={item.id}
              item={item}
              active={item.id === activeId}
              onClick={onNavigate}
            />
          ))}
          <button
            type="button"
            className="user-avatar"
            aria-label="Mở hồ sơ người dùng"
            onClick={onOpenProfile}
          >
            U
            <i />
          </button>
        </div>
      </aside>

      <MobileNavigation
        activeId={activeId}
        items={primaryItems}
        moreItems={moreItems}
        onNavigate={onNavigate}
      />
    </>
  )
}

function MobileNavigation({ activeId, items, moreItems, onNavigate }) {
  return (
    <nav className="mobile-nav" aria-label="Điều hướng mobile">
      {items.map((item) => (
        <NavigationItem
          key={item.id}
          item={item}
          active={item.id === activeId}
          onClick={onNavigate}
          mobile
        />
      ))}
      <MoreNavigationItem
        active={moreItems.some((item) => item.id === activeId) || activeId === 'profile'}
        items={moreItems}
        onNavigate={onNavigate}
      />
    </nav>
  )
}

function MoreNavigationItem({ active, items, onNavigate }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <div className="mobile-more">
      <button
        type="button"
        className={`nav-icon mobile-nav-icon${active ? ' active' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        aria-label="Thêm"
        aria-expanded={open}
      >
        <span className="nav-icon-symbol" aria-hidden="true">☰</span>
        <span className="nav-label">Thêm</span>
      </button>
      {open && (
        <div className="mobile-more-menu" onPointerDown={(event) => event.stopPropagation()}>
          {items.map((item) => (
            <button key={item.id} type="button" onClick={() => { onNavigate?.(item.id); setOpen(false) }}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
          <button type="button" onClick={() => { onNavigate?.('profile'); setOpen(false) }}>
            <span aria-hidden="true">U</span>Hồ sơ
          </button>
        </div>
      )}
    </div>
  )
}
