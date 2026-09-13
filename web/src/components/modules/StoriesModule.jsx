import { useCallback, useEffect, useState } from 'react'
import { ModuleEmptyState, ModuleScaffold } from './ModuleScaffold'

export function StoriesModule({ apiUrl }) {
  const [stories, setStories] = useState([])
  const [mediaUrl, setMediaUrl] = useState('')
  const load = useCallback(() => fetch(`${apiUrl}/api/stories`, { credentials: 'include' }).then((response) => { if (!response.ok) throw new Error('Không thể tải story'); return response.json() }).then((data) => setStories(data.stories || [])).catch(() => setStories([])), [apiUrl])
  useEffect(() => { load() }, [load])
  const createStory = async (event) => { event.preventDefault(); if (!mediaUrl.trim()) return; await fetch(`${apiUrl}/api/stories`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_url: mediaUrl.trim() }) }); setMediaUrl(''); load() }
  return (
    <ModuleScaffold icon="◌" title="Story" description="Chia sẻ những khoảnh khắc của bạn.">
      <form className="module-filter-row" onSubmit={createStory}><input value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="URL ảnh hoặc video" /><button type="submit" className="module-filter active">Đăng story</button></form>
      {stories.length ? <div className="module-planned-grid">{stories.map((story) => <a className="module-planned-panel" href={story.media_url} target="_blank" rel="noreferrer" key={story.id} onClick={() => fetch(`${apiUrl}/api/stories/${story.id}/view`, { method: 'POST', credentials: 'include' })}><strong>@{story.username}</strong><span>{story.caption || story.media_type} · {story.view_count} lượt xem</span></a>)}</div> : <ModuleEmptyState icon="◌" title="Chưa có story nào">Đăng một URL media để bắt đầu.</ModuleEmptyState>}
    </ModuleScaffold>
  )
}
