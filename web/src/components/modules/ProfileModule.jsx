import { useEffect, useState } from 'react'
import { ModuleScaffold } from './ModuleScaffold'

export function ProfileModule({ apiUrl, onLogout }) {
  const [profile, setProfile] = useState(null)
  const [bio, setBio] = useState('')
  useEffect(() => { fetch(`${apiUrl}/api/profile/me`, { credentials: 'include' }).then((response) => { if (!response.ok) throw new Error('Không thể tải hồ sơ'); return response.json() }).then((data) => { setProfile(data.user); setBio(data.user?.bio || '') }).catch(() => setProfile(null)) }, [apiUrl])
  const save = async (event) => { event.preventDefault(); const response = await fetch(`${apiUrl}/api/profile/me`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bio }) }); const data = await response.json(); if (data.user) setProfile((current) => ({ ...current, ...data.user, bio })) }
  return (
    <ModuleScaffold icon="U" title="Hồ sơ" description="Quản lý thông tin hiển thị của bạn.">
      <div className="profile-preview">
        <div className="profile-avatar">{(profile?.display_name || profile?.username || 'U').slice(0, 1).toUpperCase()}</div>
        <div><strong>{profile?.display_name || profile?.username || 'Đang tải...'}</strong><span>@{profile?.username || ''}</span></div>
      </div>
      <form className="module-settings-list" onSubmit={save}><label>Giới thiệu<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={280} /></label><button className="module-filter active" type="submit">Lưu hồ sơ</button><button className="module-filter danger" type="button" onClick={onLogout}>Đăng xuất</button></form>
    </ModuleScaffold>
  )
}
