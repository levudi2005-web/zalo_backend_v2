import { useEffect, useState } from 'react'
import { ModuleEmptyState, ModuleScaffold } from './ModuleScaffold'

export function NotificationsModule({ apiUrl }) {
  const [items, setItems] = useState([])
  useEffect(() => { fetch(`${apiUrl}/api/notifications`, { credentials: 'include' }).then((response) => { if (!response.ok) throw new Error('Không thể tải thông báo'); return response.json() }).then((data) => setItems(data.notifications || [])).catch(() => setItems([])) }, [apiUrl])
  const markAllRead = async () => { await fetch(`${apiUrl}/api/notifications/read-all`, { method: 'POST', credentials: 'include' }); setItems((current) => current.map((item) => ({ ...item, is_read: 1 }))) }
  const respondToFriendRequest = async (item, action) => {
    const userId = item.metadata?.user_id || item.reference_id
    if (!userId) return
    const response = await fetch(`${apiUrl}/api/friendships/${userId}/${action}`, { method: 'POST', credentials: 'include' })
    await response.json().catch(() => ({}))
    if (response.ok) setItems((current) => current.filter((candidate) => candidate.id !== item.id))
  }
  return (
    <ModuleScaffold icon="♧" title="Thông báo" description="Theo dõi các cập nhật quan trọng trong ứng dụng.">
      {items.length > 0 && <button type="button" className="module-filter active" onClick={markAllRead}>Đánh dấu đã đọc</button>}
      {items.length ? <div className="module-planned-grid">{items.map((item) => <div className={`module-planned-panel ${item.is_read ? '' : 'unread'}`} key={item.id}><strong>{item.title}</strong><span>{item.message}</span>{item.type === 'friend_request' && <div className="module-filter-row"><button type="button" className="module-filter active" onClick={() => respondToFriendRequest(item, 'accept')}>Chấp nhận</button><button type="button" className="module-filter" onClick={() => respondToFriendRequest(item, 'reject')}>Từ chối</button></div>}</div>)}</div> : <ModuleEmptyState icon="♧" title="Bạn chưa có thông báo mới">Thông báo mới sẽ xuất hiện ở đây khi có dữ liệu thật.</ModuleEmptyState>}
    </ModuleScaffold>
  )
}
