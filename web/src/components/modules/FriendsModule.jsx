import { useCallback, useEffect, useState } from 'react'
import { ModuleEmptyState, ModuleScaffold } from './ModuleScaffold'

export function FriendsModule({ apiUrl, userId, onOpenChat }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [friends, setFriends] = useState([])
  const [error, setError] = useState('')
  const [friendCode, setFriendCode] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [codeStatus, setCodeStatus] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const loadFriends = useCallback(() => fetch(`${apiUrl}/api/friendships`, { credentials: 'include' })
    .then((response) => response.json())
    .then((data) => setFriends(data.friendships || []))
    .catch(() => setError('Không thể tải danh sách bạn bè')), [apiUrl])

  useEffect(() => {
    loadFriends()
  }, [loadFriends])

  useEffect(() => {
    fetch(`${apiUrl}/api/me/friend-code`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Không thể tải mã kết bạn')
        setFriendCode(data.friend_code || '')
      })
      .catch((loadError) => setError(loadError.message))
  }, [apiUrl])

  const copyCode = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(friendCode)
      else {
        const input = document.createElement('textarea')
        input.value = friendCode
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      setCopyStatus('Đã sao chép mã kết bạn')
    } catch {
      setCopyStatus('Không thể sao chép mã')
    }
  }

  const sendCodeRequest = async (event) => {
    event.preventDefault()
    setBusy(true)
    setCodeStatus('')
    setError('')
    try {
      const response = await fetch(`${apiUrl}/api/friendships/request-by-code`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friend_code: codeInput }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể gửi lời mời')
      setCodeStatus('Đã gửi lời mời kết bạn')
      setCodeInput('')
      await loadFriends()
    } catch (requestError) {
      setCodeStatus(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const searchUsers = async (event) => {
    event.preventDefault()
    if (!query.trim()) return setResults([])
    const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Không thể tìm kiếm người dùng')
    setResults(data.users || [])
  }

  const requestFriend = async (id) => {
    const response = await fetch(`${apiUrl}/api/friendships/${id}/request`, { method: 'POST', credentials: 'include' })
    if (!response.ok) setError((await response.json().catch(() => ({}))).error || 'Không thể gửi lời mời')
    else loadFriends()
  }

  const friendshipAction = async (id, action, method = 'POST') => {
    const url = method === 'DELETE' ? `${apiUrl}/api/friendships/${id}` : `${apiUrl}/api/friendships/${id}/${action}`
    const response = await fetch(url, { method, credentials: 'include' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) setError(data.error || 'Không thể cập nhật mối quan hệ')
    else {
      await loadFriends()
      if (action === 'accept') setCodeStatus('Đã chấp nhận lời mời. Cuộc trò chuyện đã sẵn sàng.')
    }
  }

  return (
    <ModuleScaffold icon="♧" title="Bạn bè" description="Kết nối và quản lý các mối quan hệ của bạn.">
      <div className="module-planned-panel friend-code-panel">
        <strong>Mã kết bạn của bạn</strong>
        <div className="friend-code-value"><code>{friendCode || 'Đang tải...'}</code><button type="button" className="module-filter" onClick={copyCode} disabled={!friendCode}>Sao chép</button></div>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
      <form className="module-planned-panel friend-code-panel" onSubmit={sendCodeRequest}>
        <strong>Thêm bạn bè bằng mã</strong>
        <div className="module-filter-row"><input value={codeInput} onChange={(event) => setCodeInput(event.target.value.toUpperCase())} placeholder="XXXX-XXXX" maxLength={9} required /><button type="submit" className="module-filter active" disabled={busy}>{busy ? 'Đang gửi...' : 'Gửi lời mời'}</button></div>
        {codeStatus && <span role="status">{codeStatus}</span>}
      </form>
      <form className="module-filter-row" onSubmit={searchUsers}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm username hoặc tên" /><button type="submit" className="module-filter active">Tìm</button></form>
      {error && <p className="auth-error">{error}</p>}
      <div className="module-planned-grid">{results.map((user) => <div className="module-planned-panel" key={user.id}><strong>{user.full_name || user.username}</strong><span>@{user.username} <button type="button" className="module-filter" onClick={() => requestFriend(user.id)}>Kết bạn</button></span></div>)}</div>
      {friends.some((friend) => friend.can_accept || friend.incoming) && <><h2>Lời mời kết bạn</h2><div className="module-planned-grid">{friends.filter((friend) => friend.can_accept || friend.incoming).map((friend) => {
        const otherId = Number(friend.user_id) === Number(userId) ? friend.friend_id : friend.user_id
        return <div className="module-planned-panel" key={`incoming-${friend.id}`}><strong>{friend.friend_full_name || friend.friend_username}</strong><span>@{friend.friend_username} muốn kết bạn với bạn</span><div className="module-filter-row"><button type="button" className="module-filter active" onClick={() => friendshipAction(otherId, 'accept')}>Chấp nhận</button><button type="button" className="module-filter" onClick={() => friendshipAction(otherId, 'reject')}>Từ chối</button></div></div>
      })}</div></>}
      {friends.length ? <div className="module-planned-grid">{friends.map((friend) => {
        const otherId = Number(friend.user_id) === Number(userId) ? friend.friend_id : friend.user_id
        if (friend.can_accept || friend.incoming) return null
        return <div className="module-planned-panel friend-card" key={friend.id}><div className="friend-card-heading"><div className="profile-avatar" aria-hidden="true">{(friend.friend_full_name || friend.friend_username || '?').slice(0, 1).toUpperCase()}</div><div><strong>{friend.friend_full_name || friend.friend_username}</strong><span>@{friend.friend_username} · {friend.status === 'accepted' ? 'BẠN BÈ' : friend.status}</span></div></div><div className="module-filter-row friend-card-actions">
          {friend.status === 'pending' && friend.can_accept && <><button type="button" className="module-filter active" onClick={() => friendshipAction(otherId, 'accept')}>Chấp nhận</button><button type="button" className="module-filter" onClick={() => friendshipAction(otherId, 'reject')}>Từ chối</button></>}
          {friend.status === 'pending' && friend.outgoing && <button type="button" className="module-filter" onClick={() => friendshipAction(otherId, '', 'DELETE')}>Hủy lời mời</button>}
          {friend.status === 'accepted' && <><button type="button" className="module-filter active message-action" onClick={() => onOpenChat?.(friend.conversation_id)}>Nhắn tin</button><button type="button" className="module-filter" onClick={() => friendshipAction(otherId, 'block')}>Chặn</button></>}
          {friend.status === 'blocked' && friend.blocked_by_me && <button type="button" className="module-filter" onClick={() => friendshipAction(otherId, '', 'DELETE')}>Bỏ chặn</button>}
        </div></div>
      })}</div> : <ModuleEmptyState icon="♧" title="Chưa có dữ liệu bạn bè">Tìm một người dùng để bắt đầu kết nối.</ModuleEmptyState>}
    </ModuleScaffold>
  )
}
