import { useEffect, useState } from 'react'
import { ModuleScaffold } from './ModuleScaffold'

export function SettingsModule({ apiUrl, onLogout }) {
  const [settings, setSettings] = useState({ show_online_status: 1, ai_can_message: 1 })
  const [sessions, setSessions] = useState([])
  useEffect(() => { Promise.all([fetch(`${apiUrl}/api/settings/me`, { credentials: 'include' }), fetch(`${apiUrl}/api/devices/sessions`, { credentials: 'include' })]).then(async ([settingsResponse, sessionsResponse]) => { if (settingsResponse.ok) { const settingsData = await settingsResponse.json(); setSettings((current) => ({ ...current, ...(settingsData.settings || {}) })) } if (sessionsResponse.ok) setSessions((await sessionsResponse.json()).sessions || []) }).catch(() => undefined) }, [apiUrl])
  const toggle = async (key) => { const next = { ...settings, [key]: settings[key] ? 0 : 1 }; setSettings(next); await fetch(`${apiUrl}/api/settings/me`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: next[key] }) }) }
  return (
    <ModuleScaffold icon="⚙" title="Cài đặt" description="Tùy chỉnh trải nghiệm ứng dụng của bạn.">
      <div className="module-settings-list">
        <button type="button" className="module-setting-row" onClick={() => toggle('show_online_status')}><span>Hiển thị trạng thái online</span><span>{settings.show_online_status ? 'Bật' : 'Tắt'}</span></button>
        <button type="button" className="module-setting-row" onClick={() => toggle('ai_can_message')}><span>Cho phép Dodo nhắn tin</span><span>{settings.ai_can_message ? 'Bật' : 'Tắt'}</span></button>
      </div>
      <h2>Thiết bị đăng nhập</h2>
      <div className="module-planned-grid">{sessions.map((session) => <div className="module-planned-panel" key={session.id}><strong>{session.current ? 'Thiết bị hiện tại' : 'Phiên đăng nhập'}</strong><span>{session.ip_address || 'Không rõ IP'} · {session.is_active ? 'Đang hoạt động' : 'Đã đăng xuất'}</span></div>)}</div>
      <button className="module-filter danger" type="button" onClick={onLogout}>Đăng xuất</button>
    </ModuleScaffold>
  )
}
