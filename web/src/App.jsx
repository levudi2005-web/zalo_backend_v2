import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { dodoAssets } from './assets/mascot/dodo'
import { DodoCompanion } from './components/ai-companion/DodoCompanion'
import { DodoQuickPopup } from './components/ai-companion/DodoQuickPopup'
import { AppShell } from './components/layout/AppShell'
import {
  CallsModule,
  FriendsModule,
  NotificationsModule,
  ProfileModule,
  SettingsModule,
  StoriesModule,
} from './components/modules'
import './components/modules/module-planned.css'
import './App.css'

const API_URL = (import.meta.env.VITE_API_URL || 'https://zalo-backend-v2.onrender.com').replace(/\/$/, '')
const MEDIA_URL = String(import.meta.env.VITE_MEDIA_URL || 'https://zalo-media.onrender.com').replace(/\/$/, '')
const AI_CONVERSATION_ID = Number(import.meta.env.VITE_AI_CONVERSATION_ID || 30001)

const emojis = ['😀', '😂', '😍', '👍', '🔥', '🎉', '😎', '❤️']

const reactionEmojis = ['❤️', '👍', '😂', '😮', '😢']

function AuthScreen({ mode, onModeChange, onSubmit, error, loading }) {
  const [form, setForm] = useState({ username: '', password: '', confirm_password: '' })

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={(event) => { event.preventDefault(); onSubmit(form) }}>
        <div className="auth-mark">Z</div>
        <p className="auth-kicker">Zalo Mini</p>
        <h1>{mode === 'login' ? 'Chào mừng trở lại' : 'Tạo tài khoản mới'}</h1>
        <p className="auth-subtitle">{mode === 'login' ? 'Đăng nhập để tiếp tục cuộc trò chuyện.' : 'Đăng ký để bắt đầu trò chuyện an toàn.'}</p>
        <label>Username<input value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="username" required minLength={3} maxLength={50} /></label>
        <label>Mật khẩu<input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} /></label>
        {mode === 'register' && <label>Xác nhận mật khẩu<input type="password" value={form.confirm_password} onChange={(event) => update('confirm_password', event.target.value)} autoComplete="new-password" required minLength={8} /></label>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Đang xử lý...' : mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}</button>
        <button className="auth-switch" type="button" onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
        </button>
      </form>
    </main>
  )
}

function AppBrand({ onClick }) {
  return (
    <button className="logo" type="button" onClick={onClick} aria-label="Mở danh sách trò chuyện">
      Z
    </button>
  )
}

function ConversationListItem({ chat, selected, onSelect, dodoAssets, formatTime }) {
  const isAi = chat.conversation_type === 'ai' || chat.name === 'Dodo'

  return (
    <button
      key={chat.id}
      type="button"
      className={`chat-item ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(chat.id)}
    >
      <div className={`chat-avatar ${isAi ? 'ai' : ''}`}>
        {chat.avatar_url ? (
          <img className="dodo-avatar-image" src={chat.avatar_url} alt="" />
        ) : isAi ? (
          <img className="dodo-avatar-image" src={dodoAssets.base} alt="Dodo" />
        ) : (
          (chat.name || '?').slice(0, 1).toUpperCase()
        )}

        {Number(chat.unread_count) > 0 && <b className="chat-unread">{chat.unread_count}</b>}
        {!chat.avatar_url && !isAi && <i />}
      </div>

      <div className="chat-content">
        <div className="chat-top">
          <strong>{chat.name}</strong>
          <time>{chat.last_message_at ? formatTime(chat.last_message_at) : ''}</time>
        </div>

        <div className="chat-preview-row">
          <span className="chat-preview-status">
            {chat.is_pinned ? '📌' : ''}
            {chat.is_muted ? '🔕' : ''}
          </span>
          <span className="chat-preview-text">{chat.last_message_text || 'Chưa có tin nhắn'}</span>
        </div>
      </div>
    </button>
  )
}

function App() {
  const [authUser, setAuthUser] = useState(null)
  const [conversationId, setConversationId] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [conversations, setConversations] = useState([])
  const [conversationSettings, setConversationSettings] = useState(null)
  const [conversationActionLoading, setConversationActionLoading] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [logoutLoading, setLogoutLoading] = useState(false)

  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [newMessages, setNewMessages] = useState(false)
  const [typingUsers, setTypingUsers] = useState([])
  const [conversationPresence, setConversationPresence] = useState([])
  const [aiProcessing, setAiProcessing] = useState(false)
  const [aiStatus, setAiStatus] = useState('idle')
  const [error, setError] = useState('')

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)

  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearch, setChatSearch] = useState('')

  const [menuOpen, setMenuOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false)
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState(null)
  const [reactionPickerAnchor, setReactionPickerAnchor] = useState({ x: 0, y: 0 })
  const [commandBoxOpen, setCommandBoxOpen] = useState(false)
  const [quickMessages, setQuickMessages] = useState([])
  const [quickPending, setQuickPending] = useState(0)
  const [quickError, setQuickError] = useState('')
  const [quickAnchor, setQuickAnchor] = useState({ x: 86, y: 82 })
  const [quickSelectedText, setQuickSelectedText] = useState('')
  const [conversationInfo, setConversationInfo] = useState(null)
  const [activeModule, setActiveModule] = useState('chat')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [activeMessageAction, setActiveMessageAction] = useState(null)
  const [editingMessage, setEditingMessage] = useState(null)
  const [replyingTo, setReplyingTo] = useState(null)
  const [selectedAttachment, setSelectedAttachment] = useState(null)
  const [attachmentPreview, setAttachmentPreview] = useState(null)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [fileInputAccept, setFileInputAccept] = useState('image/*')
  const [forwardMessage, setForwardMessage] = useState(null)
  const [forwardConversations, setForwardConversations] = useState([])
  const [forwardSelectedIds, setForwardSelectedIds] = useState([])
  const [forwardSearch, setForwardSearch] = useState('')
  const [forwardLoading, setForwardLoading] = useState(false)
  const [forwardError, setForwardError] = useState('')
  const [forwardSuccess, setForwardSuccess] = useState('')
  const [pinnedPanelOpen, setPinnedPanelOpen] = useState(false)
  const [pinnedMessages, setPinnedMessages] = useState([])
  const [pinnedLoading, setPinnedLoading] = useState(false)
  const [pinnedError, setPinnedError] = useState('')
  const [highlightedMessageId, setHighlightedMessageId] = useState(null)
  const [conversationMembers, setConversationMembers] = useState([])
  const [mentionState, setMentionState] = useState({ active: false, query: '', start: 0, end: 0 })
  const [mentionIndex, setMentionIndex] = useState(0)

  const bottomRef = useRef(null)
  const messagesRef = useRef(null)
  const wasAtBottomRef = useRef(true)
  const menuRef = useRef(null)
  const attachRef = useRef(null)
  const emojiRef = useRef(null)
  const reactionPickerRef = useRef(null)
  const fileInputRef = useRef(null)
  const composerInputRef = useRef(null)
  const quickPendingRef = useRef(new Set())
  const pendingSendRef = useRef(new Set())
  const historyLimitRef = useRef(50)
  const hasMoreHistoryRef = useRef(true)
  const loadingOlderRef = useRef(false)
  const socketRef = useRef(null)
  const aiProcessingTimeoutRef = useRef(null)
  const typingTimerRef = useRef(null)
  const onlineUsersRef = useRef([])
  const typingStateRef = useRef({ isTyping: false, conversationId: null })
  const typingDebounceRef = useRef(null)
  const conversationIdRef = useRef(null)

  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' })
        if (!response.ok) {
          setAuthUser(null)
          setConversationId(null)
          return
        }

        const data = await response.json()
        setAuthUser(data.user)
        const bootstrap = await fetch(`${API_URL}/api/bootstrap`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (bootstrap.ok) setConversationId((await bootstrap.json()).conversation_id || null)
      } catch (error) {
        console.error('Session restore failed', error)
        setAuthUser(null)
        setConversationId(null)
      } finally {
        setAuthReady(true)
      }
    }
    restoreSession()
  }, [])

  const submitAuth = async (form) => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const endpoint = authMode === 'login' ? 'login' : 'register'
      const response = await fetch(`${API_URL}/api/auth/${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể xác thực')
      const bootstrap = await fetch(`${API_URL}/api/bootstrap`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const bootstrapData = await bootstrap.json().catch(() => ({}))
      if (!bootstrap.ok) throw new Error(bootstrapData.error || 'Không thể khởi tạo phiên đăng nhập')
      setAuthUser(data.user)
      setConversationId(bootstrapData.conversation_id || null)
    } catch (error) {
      setAuthError(error instanceof TypeError
        ? 'Không thể kết nối máy chủ. Vui lòng thử lại sau.'
        : error.message || 'Không thể xác thực')
    } finally {
      setAuthLoading(false)
    }
  }

  const logout = async () => {
    if (logoutLoading) return
    setLogoutLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể đăng xuất')
      socketRef.current?.disconnect()
      socketRef.current = null
      setAuthUser(null)
      setConversationId(null)
      setMessages([])
      setConversations([])
      setConversationSettings(null)
      setConversationMembers([])
      setQuickMessages([])
      setQuickPending(0)
      setSearch('')
      setSearchResults(null)
      setActiveModule('chat')
      setLogoutConfirmOpen(false)
      setError('')
    } catch (logoutError) {
      setError(logoutError.message)
    } finally {
      setLogoutLoading(false)
    }
  }

  /*
   * Đóng menu khi click ra ngoài
   */
  useEffect(() => {
    const handlePointerDown = (event) => {
      if (
        menuOpen &&
        menuRef.current &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false)
      }

      if (
        attachOpen &&
        attachRef.current &&
        !attachRef.current.contains(event.target)
      ) {
        setAttachOpen(false)
      }

      if (
        emojiOpen &&
        emojiRef.current &&
        !emojiRef.current.contains(event.target)
      ) {
        setEmojiOpen(false)
      }

      if (
        reactionPickerOpen &&
        reactionPickerRef.current &&
        !reactionPickerRef.current.contains(event.target)
      ) {
        setReactionPickerOpen(false)
        setReactionPickerMessageId(null)
      }
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setAttachOpen(false)
        setEmojiOpen(false)
        setChatSearchOpen(false)
        setCommandBoxOpen(false)
        setPinnedPanelOpen(false)
        setReactionPickerOpen(false)
        setReactionPickerMessageId(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen, attachOpen, emojiOpen, reactionPickerOpen])

  /*
   * Thêm tin nhắn và tránh duplicate
   */
  const upsertMessage = (item) => {
    if (!item) return

    setMessages((current) => {
      const index = current.findIndex((existing) => (
        item.id !== undefined &&
        item.id !== null &&
        String(existing.id) === String(item.id)
      ) || (
        item.client_message_id &&
        existing.client_message_id &&
        String(existing.client_message_id) === String(item.client_message_id)
      ))

      if (index === -1) return [...current, item]

      const merged = [...current]
      merged[index] = {
        ...merged[index],
        ...item,
        status: item.status ?? merged[index].status ?? null,
      }
      return merged
    })
  }

  const mergeMessages = (incoming) => {
    if (!incoming.length) return

    setMessages((current) => {
      const merged = [...current]

      incoming.forEach((item) => {
        const index = merged.findIndex((existing) => (
          String(existing.id) === String(item.id) || (
            item.client_message_id &&
            existing.client_message_id &&
            String(existing.client_message_id) === String(item.client_message_id)
          )
        ))

        if (index === -1) {
          merged.push(item)
        } else {
          merged[index] = {
            ...merged[index],
            ...item,
            status: item.status ?? merged[index].status ?? null,
          }
        }
      })

      return merged.sort((left, right) => (
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      ))
    })
  }

  /*
   * Chuẩn hóa message
   */
  const normalizeMessage = (item) => {
    const text =
      item?.message ??
      item?.text_content ??
      item?.text ??
      item?.content ??
      ''

    const username =
      item?.username ??
      item?.sender_username ??
      item?.sender ??
      ''

    const normalizedUsername = String(username).toLowerCase()

    const sender =
      normalizedUsername === 'ai'
        ? 'ai'
        : normalizedUsername === String(authUser?.username || '').toLowerCase()
          ? 'me'
          : 'other'

    return {
      id:
        item?.id ??
        `${Date.now()}-${Math.random()}`,
      text: String(text),
      username,
      sender,
      message_type:
        item?.message_type ?? 'text',
      attachment:
        item?.attachment ?? null,
      client_message_id:
        item?.client_message_id ?? null,
      status:
        item?.status ?? null,
      is_deleted: Number(item?.is_deleted || 0),
      is_edited: Number(item?.is_edited || 0),
      reply_to_id: item?.reply_to_id ?? null,
      reply_to: item?.reply_to ?? null,
      forwarded_from_message_id: item?.forwarded_from_message_id ?? null,
      forwarded_by_user_id: item?.forwarded_by_user_id ?? null,
      forwarded_at: item?.forwarded_at ?? null,
      is_pinned: Boolean(item?.is_pinned),
      pin: item?.pin ?? null,
      reactions: item?.reactions ?? [],
      mentions: Array.isArray(item?.mentions) ? item.mentions : [],
      forwarded_message: item?.forwarded_message ?? null,
      created_at:
        item?.created_at ??
        new Date().toISOString(),
    }
  }

  const renderMessageText = (item) => {
    if (item.is_deleted || !item.mentions?.length) return item.is_deleted ? 'Tin nhắn đã xóa' : item.text
    const mentions = [...item.mentions].sort((left, right) => left.start - right.start)
    const parts = []
    let cursor = 0
    mentions.forEach((mention, index) => {
      if (mention.start < cursor || mention.end > item.text.length) return
      if (mention.start > cursor) parts.push(<span key={`text-${index}`}>{item.text.slice(cursor, mention.start)}</span>)
      parts.push(
        <span className="message-mention" key={`mention-${index}`}>
          {item.text.slice(mention.start, mention.end)}
        </span>,
      )
      cursor = mention.end
    })
    if (cursor < item.text.length) parts.push(<span key="text-end">{item.text.slice(cursor)}</span>)
    return parts
  }

  /*
   * Tải lịch sử tin nhắn
   */
  const loadMessages = useCallback(async (limit = historyLimitRef.current, preserveScroll = false) => {
    if (!conversationId || !authUser) return

    try {
      if (preserveScroll) {
        if (loadingOlderRef.current || !hasMoreHistoryRef.current) return
        loadingOlderRef.current = true
        setLoadingOlder(true)
      } else {
        setLoading(true)
      }
      setError('')

      const element = messagesRef.current
      const previousHeight = element?.scrollHeight || 0
      const previousTop = element?.scrollTop || 0

      const response = await fetch(
        `${API_URL}/api/messages?conversation_id=${conversationId}&limit=${limit}`,
        { credentials: 'include' },
      )

      if (!response.ok) {
        const reason = await response.json().catch(() => ({}))
        throw new Error(reason.error || 'Không thể tải tin nhắn')
      }

      const data = await response.json()

      const list = Array.isArray(data)
        ? data
        : Array.isArray(data.messages)
          ? data.messages
          : []

      mergeMessages(list.map(normalizeMessage))
      const unreadIds = list
        .filter((item) => Number(item.sender_id) !== Number(authUser?.id) && !item.is_deleted)
        .map((item) => Number(item.id))
        .filter(Boolean)
      void Promise.all(unreadIds.map((id) => markMessageRead(id)))
      hasMoreHistoryRef.current = list.length >= limit && limit < 200
      historyLimitRef.current = Math.min(limit + 50, 200)

      // Determine conversation info from messages for 1-1 conversations
      if (!preserveScroll && list.length > 0) {
        const otherParticipants = [...new Set(list
          .map((m) => m.sender_id)
          .filter((id) => Number(id) !== Number(authUser?.id))
        )]
        if (otherParticipants.length === 1) {
          const otherId = otherParticipants[0]
          const otherMsg = list.find((m) => Number(m.sender_id) === otherId)
          if (otherMsg) {
            setConversationInfo({
              type: 'direct',
              partnerId: otherId,
              partnerName: otherMsg.username,
            })
          }
        } else if (otherParticipants.length > 1) {
          // Group conversation
          setConversationInfo({
            type: 'group',
            name: `Nhóm (${otherParticipants.length + 1} thành viên)`,
          })
        }
      }

      if (preserveScroll) {
        window.requestAnimationFrame(() => {
          const nextHeight = messagesRef.current?.scrollHeight || previousHeight
          if (messagesRef.current) {
            messagesRef.current.scrollTop = previousTop + nextHeight - previousHeight
          }
        })
      }
    } catch (err) {
      console.error(err)
      setError(
        err.message ||
          'Không thể tải tin nhắn',
      )
    } finally {
      if (preserveScroll) {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      } else {
        setLoading(false)
      }
    }
  }, [authUser, conversationId])

  const loadConversations = useCallback(async () => {
    if (!authUser) return
    try {
      const response = await fetch(`${API_URL}/api/conversations`, { credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể tải danh sách cuộc trò chuyện')
      setConversations(Array.isArray(data.conversations) ? data.conversations : [])
    } catch (loadError) {
      console.error('Conversation list load failed', loadError)
    }
  }, [authUser])

  useEffect(() => {
    if (!authUser || search.trim().length < 2) {
      setSearchResults(null)
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetch(`${API_URL}/api/search?q=${encodeURIComponent(search.trim())}`, { credentials: 'include' })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error || 'Không thể tìm kiếm')
          if (!cancelled) setSearchResults(data)
        })
        .catch(() => { if (!cancelled) setSearchResults({ users: [], conversations: [], messages: [] }) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [authUser, search])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (!authUser || !conversationId) {
      setConversationSettings(null)
      return undefined
    }
    let cancelled = false
    fetch(`${API_URL}/api/conversations/${conversationId}/settings`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Không thể tải cài đặt cuộc trò chuyện')
        if (!cancelled) setConversationSettings(data.settings || null)
      })
      .catch((loadError) => {
        if (!cancelled) console.error('Conversation settings load failed', loadError)
      })
    return () => { cancelled = true }
  }, [authUser, conversationId])

  const handleMessagesScroll = () => {
    const nearBottom = isNearBottom()
    wasAtBottomRef.current = nearBottom

    if (nearBottom) setNewMessages(false)

    if (messagesRef.current?.scrollTop < 48 && !loadingOlderRef.current) {
      loadMessages(historyLimitRef.current, true)
    }
  }

/*
    * Socket.IO
    *
   * Session cookie authenticates the socket handshake.
    *
    * Backend phát ra:
    * - new_message
    * - ai_processing
    * - ai_processing_done
    */
  // Socket connection effect - runs once on authUser
  useEffect(() => {
    if (!authUser) return undefined

    const socket = io(API_URL, {
      transports: ['polling'],
      upgrade: false,
      withCredentials: true,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      console.log(
        'Socket.IO connected:',
        socket.id,
      )

      setConnected(true)

      if (conversationId) {
        socket.emit('join_conversation', conversationId)
      }

    })

    socket.on('session_ready', (data) => {
      console.log(
        'Socket session ready:',
        data,
      )
    })

    socket.on('disconnect', () => {
        console.log('Socket.IO disconnected')
        setConnected(false)
      })
    
      socket.on('connect_error', (err) => {
        console.error('Socket.IO error:', err)
        setConnected(false)
      })
    
      /*
       * Tin nhắn mới từ Chat Server
       */
      socket.on('new_message', (data) => {
        const normalized = normalizeMessage(data)
        console.log('[AI TRACE] socket event:', {
          event: 'new_message',
          payload: data,
          normalized,
        })
        if (normalized.text) {
          upsertMessage(normalized)
          setConversations((current) => current.map((conversation) => (
            Number(conversation.id) === Number(data?.conversation_id)
              ? { ...conversation, last_message_text: normalized.text, last_message_at: normalized.created_at, unread_count: Number(conversation.id) === Number(conversationIdRef.current) ? 0 : Number(conversation.unread_count || 0) + 1 }
              : conversation
          )))
          if (normalized.sender !== 'me') markMessageRead(normalized.id)
        }
      })
    
      socket.on('message:edited', (data) => {
        if (data?.message) upsertMessage(normalizeMessage(data.message))
      })
    
      socket.on('message:deleted', (data) => {
        if (data?.message) upsertMessage(normalizeMessage(data.message))
      })
    
      socket.on('message:status', (data) => {
        if (!data?.message_id || Number(data.sender_id) !== Number(authUser.id)) return
        setMessages((current) => current.map((item) => (
          String(item.id) === String(data.message_id)
            ? { ...item, status: data.status }
            : item
        )))
      })
    
      socket.on('typing', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationId)) return
        if (Number(data?.user_id) === Number(authUser.id)) return
        const userId = Number(data?.user_id)
        if (!userId) return
        setTypingUsers((current) => {
          if (data.typing) {
            if (current.some((item) => item.id === userId)) return current
            return [...current, { id: userId, username: data.username || 'Một người' }]
          }
          return current.filter((item) => item.id !== userId)
        })
      })
    
      socket.on('online_users', (userIds) => {
        onlineUsersRef.current = Array.isArray(userIds) ? userIds.map(Number).filter(Boolean) : []
      })
    
      socket.on('conversation_presence', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationId)) return
        setConversationPresence(Array.isArray(data.user_ids)
          ? data.user_ids.map(Number).filter(Boolean)
          : [])
      })
    
      socket.on('presence:update', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationId)) return
        const userId = Number(data?.user_id)
        if (!userId || userId === Number(authUser.id)) return
        setConversationPresence((current) => data.online
          ? Array.from(new Set([...current, userId]))
          : current.filter((id) => id !== userId))
      })
    
      socket.on('message:reaction_added', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationIdRef.current)) return
        const messageId = data?.message_id
        const reaction = data?.reaction
        if (!messageId || !reaction) return
        setMessages((current) => current.map((item) => {
          if (String(item.id) !== String(messageId)) return item
          const existingReactions = item.reactions || []
          if (existingReactions.some(r => r.user_id === reaction.user_id && r.reaction_type === reaction.reaction_type)) {
            return item
          }
          return { ...item, reactions: [...existingReactions, reaction] }
        }))
      })
    
      socket.on('message:reaction_removed', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationIdRef.current)) return
        const messageId = data?.message_id
        const reaction = data?.reaction
        if (!messageId || !reaction) return
        setMessages((current) => current.map((item) => {
          if (String(item.id) !== String(messageId)) return item
          const existingReactions = item.reactions || []
          return {
            ...item,
            reactions: existingReactions.filter(r => !(r.user_id === reaction.user_id && r.reaction_type === reaction.reaction_type))
          }
        }))
      })

      socket.on('message:pinned', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationIdRef.current)) return
        setMessages((current) => current.map((item) => (
          String(item.id) === String(data.message_id)
            ? { ...item, is_pinned: true, pin: data.pin || null }
            : item
        )))
        setPinnedMessages((current) => current.some((item) => String(item.id) === String(data.message_id))
          ? current
          : [...current, { id: data.message_id, ...(data.message || {}), ...(data.pin || {}), is_pinned: true }])
      })

      socket.on('message:unpinned', (data) => {
        if (Number(data?.conversation_id) !== Number(conversationIdRef.current)) return
        setMessages((current) => current.map((item) => (
          String(item.id) === String(data.message_id)
            ? { ...item, is_pinned: false, pin: null }
            : item
        )))
        setPinnedMessages((current) => current.filter((item) => String(item.id) !== String(data.message_id)))
      })

      socket.on('conversation:user_settings', (data) => {
        if (Number(data?.user_id) !== Number(authUser.id)) return
        if (Number(data?.conversation_id) === Number(conversationIdRef.current)) setConversationSettings(data.settings || null)
        setConversations((current) => current.map((conversation) => (
          Number(conversation.id) === Number(data?.conversation_id)
            ? { ...conversation, ...(data.settings || {}) }
            : conversation
        )).sort((left, right) => Number(right.is_pinned) - Number(left.is_pinned) || new Date(right.last_message_at || 0).getTime() - new Date(left.last_message_at || 0).getTime()))
      })

      socket.on('conversation:created', () => {
        loadConversations()
      })
    
      /*
       * AI bắt đầu xử lý
       */
      socket.on('ai_processing', (data) => {
        console.log('AI đang xử lý:', data)
        setAiProcessing(true)
        setAiStatus('processing')
        setError('')
        if (aiProcessingTimeoutRef.current) {
          clearTimeout(aiProcessingTimeoutRef.current)
        }
        aiProcessingTimeoutRef.current = setTimeout(() => {
          console.warn('[AI TRACE] AI processing timeout fallback: clearing ai_processing state without inventing a false error.')
          setAiProcessing(false)
          setAiStatus('waiting')
        }, 12000)
      })
    
      /*
       * AI hoàn thành
       */
      socket.on('ai_processing_done', (data) => {
        console.log('[AI TRACE] socket event:', {
          event: 'ai_processing_done',
          payload: data,
        })
        if (aiProcessingTimeoutRef.current) {
          clearTimeout(aiProcessingTimeoutRef.current)
          aiProcessingTimeoutRef.current = null
        }
        const normalized = normalizeMessage(data?.message)
        console.log('[AI TRACE] normalized message:', normalized)
        if (normalized.text && normalized.sender === 'ai') {
          upsertMessage(normalized)
          console.log('[AI TRACE] message added:', normalized)
        }
        setAiProcessing(false)
        if (data?.error) {
          setAiStatus('error')
          setError(data.error)
        } else {
          setAiStatus('success')
          setError('')
        }
      })
    
      socket.on('dodo_quick_processing', (data) => {
        if (!quickPendingRef.current.has(data?.request_id)) return
        setQuickError('')
      })
    
      socket.on('dodo_quick_done', (data) => {
        const requestId = data?.request_id
        if (!requestId || !quickPendingRef.current.has(requestId)) return
        console.debug('[AI SPEED]', {
          event: 'response_received',
          requestId,
          timing: data?.timing || null,
        })
        quickPendingRef.current.delete(requestId)
        setQuickPending(quickPendingRef.current.size)
        if (data.error) {
          setQuickError('Ơ, Dodo bị khựng một chút 😅 Thử lại nha.')
          return
        }
        const text = data?.message?.message || data?.message?.text || ''
        if (!text) return
        setQuickMessages((current) => [
          ...current,
          {
            id: `assistant-${requestId}`,
            role: 'assistant',
            content: text,
          },
        ])
        console.debug('[AI SPEED]', {
          event: 'ui_render_scheduled',
          requestId,
        })
      })
    
      /*
       * Backend báo lỗi socket
       */
      socket.on('server_error', (data) => {
        console.error('Server error:', data)
        setError(data?.error || 'Lỗi máy chủ')
      })
    
      /*
       * Dọn socket khi component unmount
       */
      return () => {
        stopTyping()
        if (aiProcessingTimeoutRef.current) {
          clearTimeout(aiProcessingTimeoutRef.current)
          aiProcessingTimeoutRef.current = null
        }
        socketRef.current = null
        setTypingUsers([])
        setConversationPresence([])
        socket.disconnect()
      }
    }, [authUser, loadConversations])

  useEffect(() => {
    if (!authUser || !conversationId) return
    loadMessages()
  }, [authUser, conversationId, loadMessages])

  useEffect(() => {
    if (!authUser || !conversationId) {
      setConversationMembers([])
      return
    }
    let cancelled = false
    fetch(`${API_URL}/api/conversations/${conversationId}/members`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Không thể tải thành viên')
        if (!cancelled) setConversationMembers(Array.isArray(data.members) ? data.members : [])
      })
      .catch((loadError) => {
        if (!cancelled) {
          console.error('Conversation members load failed', loadError)
          setConversationMembers([])
        }
      })
    return () => { cancelled = true }
  }, [authUser, conversationId])

  // Conversation room management effect - runs on conversationId change
  useEffect(() => {
    if (!socketRef.current?.connected || !conversationId) return

    const socket = socketRef.current
    socket.emit('join_conversation', conversationId)

    stopTyping()
    setTypingUsers([])
    setConversationPresence([])

    return () => {
      stopTyping()
    }
  }, [conversationId, connected])

  /*
   * Tự cuộn xuống tin nhắn mới nhất
   */
  const isNearBottom = () => {
    const element = messagesRef.current
    if (!element) return true

    return element.scrollHeight - element.scrollTop - element.clientHeight < 72
  }

  const scrollToBottom = () => {
    wasAtBottomRef.current = true
    setNewMessages(false)
    bottomRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    })
  }

  useEffect(() => {
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      })
    } else if (messages.length) {
      setNewMessages(true)
    }
  }, [messages, aiProcessing])

  /*
   * Gửi tin nhắn
   */
  const sendMessage = async (overrideText, retryMessage = null) => {
    if (!conversationId) return
    const rawText = typeof overrideText === 'string'
      ? overrideText
      : message

    const text = rawText.trim()

    const attachment = retryMessage?.attachment || selectedAttachment
    if (!text && !attachment) return
    stopTyping()

    const clientMessageId = retryMessage?.client_message_id ||
      `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingSendRef.current.add(clientMessageId)

    const optimistic = {
      id: retryMessage?.id || `local-${clientMessageId}`,
      text,
      username: authUser.username,
      sender: 'me',
      message_type: 'text',
      attachment,
      client_message_id: clientMessageId,
      reply_to_id: replyingTo?.id ?? null,
      mentions: getClientMentions(text),
      status: 'sending',
      created_at:
        retryMessage?.created_at || new Date().toISOString(),
    }

    try {
      setError('')

      /*
       * Optimistic message
       */
      upsertMessage(optimistic)

      setMessage('')
      setMentionState({ active: false, query: '', start: 0, end: 0 })
      setMentionIndex(0)
      setEmojiOpen(false)
      setAttachOpen(false)
      setCommandBoxOpen(false)

      /*
       * Gửi lên Chat Server
       */
      const response = await fetch(
        `${API_URL}/api/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            message: text,
            conversation_id: conversationId,
            client_message_id: clientMessageId,
            reply_to_id: replyingTo?.id ?? null,
            attachment,
          }),
        },
      )

      const data =
        await response
          .json()
          .catch(() => ({}))

      if (!response.ok) {
        throw new Error(
          data?.error ||
            data?.message ||
            'Gửi tin nhắn thất bại',
        )
      }

      upsertMessage({
        ...normalizeMessage(data),
        status: 'sent',
        client_message_id: clientMessageId,
      })
      setReplyingTo(null)
      setSelectedAttachment(null)

      // Backend emits ai_processing for Dodo and @ai invocations.
    } catch (err) {
      console.error(err)

      upsertMessage({
        ...optimistic,
        status: 'failed',
      })

      setError(
        err.message ||
          'Gửi tin nhắn thất bại',
      )
    } finally {
      pendingSendRef.current.delete(clientMessageId)
    }
  }

  const retryMessage = (item) => {
    sendMessage(item.text, item)
  }

  async function markMessageRead(messageId) {
    if (!messageId) return
    await fetch(`${API_URL}/api/messages/${messageId}/read`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {})
  }

  const mentionCandidates = mentionState.active
    ? conversationMembers
      .filter((member) => member.username.toLowerCase().includes(mentionState.query.toLowerCase()))
      .slice(0, 8)
    : []

  const getClientMentions = (text) => {
    const membersByUsername = new Map(conversationMembers.map((member) => [member.username.toLowerCase(), member]))
    const matches = []
    const pattern = /(^|\s)@([a-zA-Z0-9_.-]{1,50})/g
    let match
    while ((match = pattern.exec(text))) {
      const member = membersByUsername.get(match[2].toLowerCase())
      if (!member) continue
      const start = match.index + match[1].length
      matches.push({
        user_id: member.id,
        username: member.username,
        full_name: member.full_name,
        start,
        end: start + match[2].length + 1,
      })
    }
    return matches
  }

  const updateMentionState = (value, caretPosition) => {
    const beforeCaret = value.slice(0, caretPosition)
    const match = beforeCaret.match(/(^|\s)@([a-zA-Z0-9_.-]*)$/)
    if (!match) {
      setMentionState((current) => current.active
        ? { active: false, query: '', start: 0, end: 0 }
        : current)
      setMentionIndex(0)
      return
    }
    const start = caretPosition - match[2].length - 1
    setMentionState({ active: true, query: match[2], start, end: caretPosition })
    setMentionIndex(0)
  }

  const selectMention = (member) => {
    const { start, end } = mentionState
    const nextMessage = `${message.slice(0, start)}@${member.username} ${message.slice(end)}`
    const nextCaret = start + member.username.length + 2
    setMessage(nextMessage)
    setMentionState({ active: false, query: '', start: 0, end: 0 })
    setMentionIndex(0)
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus()
      composerInputRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  async function addReaction(messageId, reactionType) {
    const response = await fetch(`${API_URL}/api/messages/${messageId}/reactions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction_type: reactionType }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Không thể thêm reaction')
    return data
  }

  async function removeReaction(messageId, reactionType) {
    const response = await fetch(`${API_URL}/api/messages/${messageId}/reactions`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction_type: reactionType }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Không thể xóa reaction')
    return data
  }

  function stopTyping() {
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
    if (typingDebounceRef.current) {
      window.clearTimeout(typingDebounceRef.current)
      typingDebounceRef.current = null
    }
    const wasTyping = typingStateRef.current.isTyping
    const currentConversationId = typingStateRef.current.conversationId
    typingStateRef.current = { isTyping: false, conversationId: null }
    if (wasTyping && socketRef.current?.connected && currentConversationId) {
      socketRef.current.emit('typing', { conversation_id: currentConversationId, typing: false })
    }
  }

  const handleComposerChange = (value, caretPosition = value.length) => {
    setMessage(value)
    updateMentionState(value, caretPosition)
    if (!socketRef.current?.connected || !conversationId) return
    if (!value.trim()) {
      stopTyping()
      return
    }
    if (!typingStateRef.current.isTyping) {
      typingStateRef.current = { isTyping: true, conversationId }
      socketRef.current.emit('typing', { conversation_id: conversationId, typing: true })
    }
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current)
    typingTimerRef.current = window.setTimeout(stopTyping, 1200)
  }

  const saveEdit = async () => {
    const text = message.trim()
    if (!editingMessage || !text) return
    try {
      const response = await fetch(`${API_URL}/api/messages/${editingMessage.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể chỉnh sửa tin nhắn')
      upsertMessage(normalizeMessage(data))
      setEditingMessage(null)
      setMessage('')
    } catch (error) {
      setError(error.message)
    }
  }

  const deleteMessage = async (item) => {
    try {
      const response = await fetch(`${API_URL}/api/messages/${item.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể xóa tin nhắn')
      upsertMessage(normalizeMessage(data))
    } catch (error) {
      setError(error.message)
    } finally {
      setActiveMessageAction(null)
    }
  }

  const copyMessage = async (item) => {
    if (!item.text || item.is_deleted) return
    try {
      await navigator.clipboard.writeText(item.text)
    } catch {
      setError('Không thể sao chép tin nhắn')
    } finally {
      setActiveMessageAction(null)
    }
  }

  useEffect(() => {
    if (!forwardMessage) return
    let cancelled = false
    setForwardLoading(true)
    setForwardError('')
    setForwardSearch('')
    setForwardSelectedIds([])
    fetch(`${API_URL}/api/conversations`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Không thể tải cuộc trò chuyện')
        if (!cancelled) setForwardConversations(Array.isArray(data.conversations) ? data.conversations : [])
      })
      .catch((error) => {
        if (!cancelled) setForwardError(error.message)
      })
      .finally(() => {
        if (!cancelled) setForwardLoading(false)
      })
    return () => { cancelled = true }
  }, [forwardMessage])

  const openForwardDialog = (item) => {
    setForwardSuccess('')
    setForwardError('')
    setForwardMessage(item)
    setActiveMessageAction(null)
  }

  const toggleForwardConversation = (id) => {
    setForwardSelectedIds((current) => current.includes(id)
      ? current.filter((conversationId) => conversationId !== id)
      : [...current, id])
  }

  useEffect(() => {
    if (!pinnedPanelOpen || !conversationId) return
    let cancelled = false
    setPinnedLoading(true)
    setPinnedError('')
    fetch(`${API_URL}/api/conversations/${conversationId}/pins`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Không thể tải tin nhắn đã ghim')
        if (!cancelled) setPinnedMessages(Array.isArray(data.pins) ? data.pins : [])
      })
      .catch((error) => { if (!cancelled) setPinnedError(error.message) })
      .finally(() => { if (!cancelled) setPinnedLoading(false) })
    return () => { cancelled = true }
  }, [pinnedPanelOpen, conversationId])

  const togglePin = async (item) => {
    const method = item.is_pinned ? 'DELETE' : 'POST'
    try {
      const response = await fetch(`${API_URL}/api/messages/${item.id}/pin`, {
        method,
        credentials: 'include',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể cập nhật ghim')
      setMessages((current) => current.map((messageItem) => (
        String(messageItem.id) === String(item.id)
          ? { ...messageItem, is_pinned: method === 'POST', pin: data.pin || null }
          : messageItem
      )))
      setActiveMessageAction(null)
      if (method === 'DELETE') setPinnedMessages((current) => current.filter((pin) => String(pin.id) !== String(item.id)))
      else setPinnedMessages((current) => [...current.filter((pin) => String(pin.id) !== String(item.id)), { ...item, ...data.pin, is_pinned: true }])
    } catch (error) {
      setError(error.message)
    }
  }

  const jumpToPinnedMessage = (messageId) => {
    setPinnedPanelOpen(false)
    window.requestAnimationFrame(() => {
      const element = messagesRef.current?.querySelector(`[data-message-id="${messageId}"]`)
      if (!element) return
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(String(messageId))
      window.setTimeout(() => setHighlightedMessageId(null), 1400)
    })
  }

  const submitForward = async () => {
    if (!forwardMessage || !forwardSelectedIds.length) return
    setForwardLoading(true)
    setForwardError('')
    try {
      const response = await fetch(`${API_URL}/api/messages/${forwardMessage.id}/forward`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_ids: forwardSelectedIds }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể chuyển tiếp tin nhắn')
      setForwardMessage(null)
      setForwardSelectedIds([])
      setForwardSuccess(`Đã chuyển tiếp đến ${data.forwarded?.length || forwardSelectedIds.length} cuộc trò chuyện`)
    } catch (error) {
      setForwardError(error.message)
    } finally {
      setForwardLoading(false)
    }
  }

  const updateConversationSettings = async (patch) => {
    if (!conversationId || conversationActionLoading) return
    setConversationActionLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/settings`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể cập nhật cuộc trò chuyện')
      setConversationSettings(data.settings)
      await loadConversations()
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setConversationActionLoading(false)
      setMenuOpen(false)
    }
  }

  const updateDisappearing = async (seconds) => {
    if (!conversationId || conversationActionLoading) return
    setConversationActionLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/disappearing`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: seconds > 0, seconds }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể cập nhật tin nhắn tự xóa')
      setConversationSettings((current) => ({ ...current, disappearing_enabled: data.disappearing_enabled, disappearing_seconds: data.disappearing_seconds }))
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setConversationActionLoading(false)
      setMenuOpen(false)
    }
  }

  const clearConversationHistory = async () => {
    if (!conversationId || conversationActionLoading) return
    setConversationActionLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/clear`, { method: 'POST', credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể xóa lịch sử chat')
      setMessages([])
      setConversationSettings(data.settings || { ...conversationSettings, hide_chat_history: 1 })
      setMenuOpen(false)
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setConversationActionLoading(false)
    }
  }

  const hideConversation = async () => {
    if (!conversationId || conversationActionLoading) return
    setConversationActionLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/hide`, { method: 'POST', credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể ẩn cuộc trò chuyện')
      const next = conversations.find((conversation) => Number(conversation.id) !== Number(conversationId))
      setConversationId(next?.id || null)
      await loadConversations()
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setConversationActionLoading(false)
      setMenuOpen(false)
    }
  }

  const selectConversation = (id) => {
    setConversationId(id)
    setActiveModule('chat')
    setSidebarOpen(true)
    setNewMessages(false)
    setChatSearch('')
  }

  const openReactionPicker = (event, messageId) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setReactionPickerAnchor({ x: rect.left + rect.width / 2, y: rect.top })
    setReactionPickerMessageId(messageId)
    setReactionPickerOpen(true)
    setActiveMessageAction(null)
  }

  const toggleReaction = async (messageId, reactionType) => {
    const message = messages.find(m => String(m.id) === String(messageId))
    if (!message) return
    const userReaction = message.reactions?.find(r => Number(r.user_id) === Number(authUser?.id) && r.reaction_type === reactionType)
    try {
      if (userReaction) {
        await removeReaction(messageId, reactionType)
        setMessages((current) => current.map((item) => (
          String(item.id) === String(messageId)
            ? { ...item, reactions: (item.reactions || []).filter((reaction) => (
              !(Number(reaction.user_id) === Number(authUser?.id) && reaction.reaction_type === reactionType)
            )) }
            : item
        )))
      } else {
        const data = await addReaction(messageId, reactionType)
        if (data.reaction) {
          setMessages((current) => current.map((item) => (
            String(item.id) === String(messageId)
              ? {
                ...item,
                reactions: (item.reactions || []).some((reaction) => (
                  Number(reaction.user_id) === Number(data.reaction.user_id) && reaction.reaction_type === data.reaction.reaction_type
                ))
                  ? item.reactions
                  : [...(item.reactions || []), data.reaction],
              }
              : item
          )))
        }
      }
    } catch (error) {
      setError(error.message)
    }
    setReactionPickerOpen(false)
    setReactionPickerMessageId(null)
  }

  /*
   * Enter để gửi
   */
  const handleKeyDown = (event) => {
    if (mentionState.active && mentionCandidates.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((current) => (current + 1) % mentionCandidates.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        selectMention(mentionCandidates[mentionIndex])
        return
      }
    }
    if (event.key === 'Escape' && mentionState.active) {
      event.preventDefault()
      setMentionState({ active: false, query: '', start: 0, end: 0 })
      return
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {
      event.preventDefault()
      if (editingMessage) saveEdit()
      else sendMessage()
    }
  }

  const handleDodoPrompt = (promptText) => {
    if (!promptText?.trim()) return

    const trimmed = promptText.trim()
    setMessage(trimmed)
    sendMessage(trimmed)
  }

  const handleQuickPrompt = async (request) => {
    const input = typeof request === 'string' ? request : request?.input
    const text = String(input || '').trim()
    if (!text) return

    const requestId = `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const action = typeof request === 'string' ? 'ask' : request.action
    const history = action === 'ask'
      ? quickMessages.slice(-4).map((item) => ({
        role: item.role,
        content: item.content,
      }))
      : []
    const startedAt = performance.now()

    console.debug('[AI SPEED]', {
      event: 'frontend_request_start',
      requestId,
      action,
    })

    setQuickError('')
    setQuickMessages((current) => [
      ...current,
      { id: `user-${requestId}`, role: 'user', content: text },
    ])
    quickPendingRef.current.add(requestId)
    setQuickPending(quickPendingRef.current.size)

    try {
      const response = await fetch(`${API_URL}/api/dodo/quick`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          request_id: requestId,
          action,
          context: typeof request === 'string' ? null : request.context,
          history,
        }),
      })

      if (!response.ok) throw new Error('quick request failed')
      console.debug('[AI SPEED]', {
        event: 'server_acknowledged',
        requestId,
        ms: Math.round(performance.now() - startedAt),
      })
    } catch (err) {
      console.error(err)
      quickPendingRef.current.delete(requestId)
      setQuickPending(quickPendingRef.current.size)
      setQuickError('Ơ, Dodo bị khựng một chút 😅 Thử lại nha.')
    }
  }

  /*
   * Chèn emoji
   */
  const insertEmoji = (emoji) => {
    setMessage(
      (current) =>
        `${current}${emoji}`,
    )

    setEmojiOpen(false)
  }

  /*
   * Upload file
   */
  const handleFileChange = async (
    event,
  ) => {
    const file = event.target.files?.[0]
    if (!file) return

    const previewUrl = URL.createObjectURL(file)
    const fileKind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file'
    setAttachmentPreview({
      kind: fileKind,
      url: previewUrl,
      fileName: file.name,
      fileType: file.type,
      size: file.size,
    })

    try {
      setError('')
      setUploadingAttachment(true)
      setSelectedAttachment(null)

      if (!MEDIA_URL) throw new Error('Media Server URL chưa được cấu hình')

      const tokenResponse = await fetch(`${API_URL}/api/auth/session-token`, {
        method: 'GET',
        credentials: 'include',
      })
      const tokenData = await tokenResponse.json().catch(() => ({}))
      if (!tokenResponse.ok) throw new Error(tokenData.error || 'Chưa đăng nhập')

      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`${MEDIA_URL}/api/upload`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${tokenData.token || ''}`,
        },
        body: formData,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Tải file thất bại')

      if (data.attachment?.attachment_type === 'image' || data.attachment?.attachment_type === 'video') {
        setAttachmentPreview({
          kind: data.attachment.attachment_type,
          url: data.attachment.attachment_type === 'image' ? (data.attachment.file_url || data.attachment.thumbnail_url) : (data.attachment.thumbnail_url || data.attachment.file_url),
          fileName: data.attachment.file_name || file.name,
          fileType: data.attachment.mime_type || file.type,
          size: data.attachment.file_size || file.size,
        })
      }

      setSelectedAttachment(data.attachment)
    } catch (err) {
      console.error(err)
      setAttachmentPreview(null)
      setError(err.message || 'Xử lý file thất bại')
    } finally {
      setUploadingAttachment(false)
      setAttachOpen(false)
      event.target.value = ''
    }
  }

  /*
   * Format giờ
   */
  const formatTime = (value) => {
    const date = new Date(value)

    if (
      Number.isNaN(date.getTime())
    ) {
      return ''
    }

    return date.toLocaleTimeString(
      'vi-VN',
      {
        hour: '2-digit',
        minute: '2-digit',
      },
    )
  }

  /*
   * Tìm kiếm danh sách chat
   */
  const aiAssistantChat = {
    id: AI_CONVERSATION_ID,
    name: 'AI Assistant',
    last_message_text: 'AI Assistant',
    last_message_at: null,
    conversation_type: 'ai',
    avatar_url: dodoAssets.base,
    unread_count: 0,
    is_muted: 0,
    is_pinned: 0,
  }

  const filteredChats =
    conversations.filter((chat) => chat.name.toLowerCase().includes(search.toLowerCase())).concat(
      conversations.some((chat) => Number(chat.id) === Number(AI_CONVERSATION_ID)) ? [] : [aiAssistantChat],
    ).filter((chat) => chat.name.toLowerCase().includes(search.toLowerCase()))

  const filteredForwardConversations = forwardConversations.filter((conversation) => (
    conversation.name.toLowerCase().includes(forwardSearch.toLowerCase())
  ))

  /*
   * Tìm kiếm trong cuộc trò chuyện
   */
  const visibleMessages =
    chatSearch.trim()
      ? messages.filter((item) =>
          item.text
            .toLowerCase()
            .includes(
              chatSearch
                .trim()
                .toLowerCase(),
            ),
        )
      : messages

  useEffect(() => {
    if (!commandBoxOpen) return undefined

    const handlePointerDown = (event) => {
      const target = event.target
      const clickedInsideCommandBox = target instanceof Element &&
        target.closest('.dodo-command-box')
      const clickedDodo = target instanceof Element &&
        target.closest('.dodo-character')

      if (!clickedInsideCommandBox && !clickedDodo) {
        setCommandBoxOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [commandBoxOpen])

  const moduleView = {
    friends: <FriendsModule apiUrl={API_URL} userId={authUser?.id} onOpenChat={(id) => { if (id) selectConversation(id) }} />,
    stories: <StoriesModule apiUrl={API_URL} />,
    notifications: <NotificationsModule apiUrl={API_URL} />,
    calls: <CallsModule apiUrl={API_URL} currentUserId={authUser?.id} socket={socketRef.current} />,
    settings: <SettingsModule apiUrl={API_URL} onLogout={() => setLogoutConfirmOpen(true)} />,
    profile: <ProfileModule apiUrl={API_URL} onLogout={() => setLogoutConfirmOpen(true)} />,
  }

  if (!authReady) {
    return <main className="auth-screen"><p>Đang khôi phục phiên đăng nhập...</p></main>
  }

  if (!authUser) {
    return <AuthScreen mode={authMode} onModeChange={(mode) => { setAuthMode(mode); setAuthError('') }} onSubmit={submitAuth} error={authError} loading={authLoading} />
  }

  const dodoOverlay = (
    <>
      <DodoCompanion
        aiProcessing={aiProcessing || quickPending > 0}
        onOpen={(anchor) => {
          setQuickAnchor(anchor || { x: 86, y: 82 })
          setQuickSelectedText(window.getSelection?.()?.toString().trim() || '')
          setCommandBoxOpen((value) => !value)
          setError('')
        }}
      />

      <DodoQuickPopup
        isOpen={commandBoxOpen}
        onClose={() => setCommandBoxOpen(false)}
        onOpenChat={() => {
          setActiveModule('chat')
          setSidebarOpen(true)
          setChatSearchOpen(false)
          setCommandBoxOpen(false)
        }}
        messages={quickMessages}
        processing={quickPending > 0}
        error={quickError}
        anchor={quickAnchor}
        selectedText={quickSelectedText}
        onSubmit={handleQuickPrompt}
      />
    </>
  )

  return (
    <AppShell
      activeModule={activeModule}
      onNavigate={(id) => {
        setActiveModule(id)
        if (id !== 'chat') setCommandBoxOpen(false)
        if (id === 'chat') setSidebarOpen(true)
      }}
      onOpenSidebar={() => {
        setActiveModule('chat')
        setSidebarOpen(true)
      }}
      onOpenProfile={() => setActiveModule('profile')}
      dodo={dodoOverlay}
    >

      {activeModule !== 'chat' ? moduleView[activeModule] : (
        <>

        {/* =====================================================
            CHAT LIST
        ====================================================== */}

        <aside
          className={`chat-sidebar ${
            sidebarOpen
              ? ''
              : 'hidden'
          }`}
        >

          <div className="sidebar-head">
            <div className="brand-compact-row">
              <div className="sidebar-kicker">Workspace</div>
              <button
                className="small-icon"
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Thu gọn danh sách"
              >
                ‹
              </button>
            </div>

            <div className="title-row">
              <div>
                <h1>Trò chuyện</h1>
                <span className="sidebar-subtitle">{filteredChats.length} cuộc hội thoại</span>
              </div>
              <AppBrand onClick={() => setSidebarOpen(false)} />
            </div>

            <div className={`search ${sidebarSearchOpen ? 'open' : ''}`}>
              <button
                type="button"
                onClick={() => setSidebarSearchOpen((value) => !value)}
                aria-label="Tìm kiếm"
              >
                ⌕
              </button>

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onFocus={() => setSidebarSearchOpen(true)}
                placeholder="Tìm kiếm"
              />
            </div>
          </div>

          {searchResults && (
            <div className="module-search-results">
              {searchResults.users?.map((user) => <button type="button" key={`user-${user.id}`} onClick={() => setSearch('')}><strong>{user.full_name || user.username}</strong><span>@{user.username}</span></button>)}
              {searchResults.conversations?.map((conversation) => <button type="button" key={`conversation-${conversation.id}`} onClick={() => { selectConversation(conversation.id); setSearch('') }}><strong>{conversation.name}</strong><span>Cuộc trò chuyện</span></button>)}
              {searchResults.messages?.map((result) => <button type="button" key={`message-${result.id}`} onClick={() => { selectConversation(result.conversation_id); setSearch('') }}><strong>{result.snippet || result.text_content}</strong><span>{result.conversation_name} · @{result.username}</span></button>)}
              {!searchResults.users?.length && !searchResults.conversations?.length && !searchResults.messages?.length && <span className="module-search-empty">Không tìm thấy kết quả</span>}
            </div>
          )}

          <div className="chat-list">
            {filteredChats.map((chat) => (
              <ConversationListItem
                key={chat.id}
                chat={chat}
                selected={Number(chat.id) === Number(conversationId)}
                onSelect={selectConversation}
                dodoAssets={dodoAssets}
                formatTime={formatTime}
              />
            ))}

            {filteredChats.length ===
              0 && (
              <div className="center-state">

                <div className="empty-icon">
                  ⌕
                </div>

                <div className="empty">

                  <h3>
                    {search.trim() ? 'Không tìm thấy' : 'Chưa có cuộc trò chuyện'}
                  </h3>

                  <p>
                    {search.trim() ? 'Thử tìm với từ khóa khác.' : 'Vào Bạn bè và chọn Nhắn tin để bắt đầu.'}
                  </p>

                </div>

              </div>
            )}

          </div>

        </aside>

        {/* =====================================================
            MAIN CHAT
        ====================================================== */}

        <section className="chat-window">

          {Number(conversationId) === Number(AI_CONVERSATION_ID) && (
            <div className="ai-chat-brief">
              <div className="ai-chat-brief-avatar">
                <img className="dodo-avatar-image" src={dodoAssets.base} alt="Dodo" />
              </div>
              <div className="ai-chat-brief-content">
                <span className="ai-chat-kicker">🤖 AI Assistant</span>
                <strong>AI Assistant</strong>
                <span className="ai-chat-status-line">
                  {aiStatus === 'processing' ? 'Đang xử lý' : aiStatus === 'waiting' ? 'Đang khởi động' : aiStatus === 'error' ? 'AI phản hồi thất bại' : aiStatus === 'success' ? 'AI đã phản hồi' : 'Online'}
                </span>
              </div>
            </div>
          )}

          {/* HEADER */}

          <header className="chat-header">
            <div className="header-person">
              <div className={`chat-avatar big ${conversationInfo?.type === 'direct' && conversationPresence.includes(conversationInfo.partnerId) ? 'online' : ''}`}>
                {!conversationId ? (
                  <span aria-hidden="true">+</span>
                ) : conversationInfo?.type === 'direct' ? (
                  conversationInfo.partnerName?.charAt(0).toUpperCase() || '?'
                ) : (
                  <img
                    className="dodo-avatar-image"
                    src={dodoAssets.base}
                    alt="Dodo"
                  />
                )}
                {conversationInfo?.type === 'direct' && conversationPresence.includes(conversationInfo.partnerId) && (
                  <i className="presence-dot" />
                )}
              </div>

              <div className="header-meta">
                <div className="header-identity">
                  <h2>
                    {Number(conversationId) === Number(AI_CONVERSATION_ID)
                      ? 'AI Assistant'
                      : conversationId && conversationInfo?.type === 'direct'
                        ? conversationInfo.partnerName
                        : conversationId && conversationInfo?.type === 'group'
                          ? conversationInfo.name
                          : 'Chọn cuộc trò chuyện'}
                  </h2>
                  <span className="header-chip">{connected ? 'Online' : 'Offline'}</span>
                </div>

                <span className="status">
                  <i className={connected ? 'online' : ''} />
                  {connected ? 'Kết nối realtime' : 'Mất kết nối realtime'}
                </span>
                <span className="presence-status">
                  {Number(conversationId) === Number(AI_CONVERSATION_ID)
                    ? (aiStatus === 'processing'
                        ? 'AI đang xử lý...'
                        : aiStatus === 'waiting'
                          ? 'AI đang khởi động...'
                          : aiStatus === 'error'
                            ? 'AI phản hồi thất bại'
                            : 'AI Online')
                    : conversationId && conversationInfo?.type === 'direct'
                      ? conversationPresence.includes(conversationInfo.partnerId)
                        ? 'Đang hoạt động'
                        : 'Ngoài tuyến'
                      : conversationId && conversationPresence.filter((id) => id !== Number(authUser.id)).length
                        ? `${conversationPresence.filter((id) => id !== Number(authUser.id)).length} người online`
                        : conversationId ? 'Không có người khác online' : 'Kết bạn để bắt đầu trò chuyện'}
                </span>
              </div>
            </div>

            <div className="header-buttons">

              {/* Tìm kiếm */}

              <button
                type="button"
                className={
                  chatSearchOpen
                    ? 'active'
                    : ''
                }
                onClick={() => {
                  setChatSearchOpen(
                    (value) =>
                      !value,
                  )
                  setMenuOpen(false)
                }}
                aria-label="Tìm trong cuộc trò chuyện"
              >
                ⌕
              </button>

              {/* Làm mới */}

              <button
                type="button"
                onClick={
                  loadMessages
                }
                aria-label="Tải lại tin nhắn"
              >
                ↻
              </button>

              <button
                type="button"
                className={pinnedPanelOpen ? 'active' : ''}
                onClick={() => setPinnedPanelOpen((value) => !value)}
                aria-label="Tin nhắn đã ghim"
                title="Tin nhắn đã ghim"
              >
                📌
              </button>

              {/* Menu */}

              <div
                ref={menuRef}
                style={{
                  position:
                    'relative',
                }}
              >

                <button
                  type="button"
                  className={
                    menuOpen
                      ? 'active'
                      : ''
                  }
                  onClick={() => {
                    setMenuOpen(
                      (value) =>
                        !value,
                    )
                    setChatSearchOpen(
                      false,
                    )
                  }}
                  aria-label="Tùy chọn cuộc trò chuyện"
                >
                  ⋯
                </button>

                {menuOpen && (
                  <div className="dropdown">

                    <button type="button" onClick={() => setMenuOpen(false)}>
                      Thông tin cuộc trò chuyện
                    </button>

                    <button type="button" disabled={conversationActionLoading} onClick={() => updateConversationSettings({ is_pinned: !conversationSettings?.is_pinned })}>
                      {conversationSettings?.is_pinned ? 'Bỏ ghim cuộc trò chuyện' : 'Ghim cuộc trò chuyện'}
                    </button>

                    <button type="button" disabled={conversationActionLoading} onClick={() => updateConversationSettings({ is_muted: !conversationSettings?.is_muted })}>
                      {conversationSettings?.is_muted ? 'Bật thông báo' : 'Tắt thông báo'}
                    </button>

                    <button type="button" disabled={conversationActionLoading} onClick={() => updateDisappearing(0)}>
                      Tin nhắn tự xóa: {conversationSettings?.disappearing_enabled ? `${conversationSettings.disappearing_seconds}s` : 'Tắt'}
                    </button>
                    <div className="conversation-duration-options">
                      {[60, 3600, 86400, 604800].map((seconds) => <button type="button" key={seconds} disabled={conversationActionLoading} onClick={() => updateDisappearing(seconds)}>{seconds === 60 ? '1 phút' : seconds === 3600 ? '1 giờ' : seconds === 86400 ? '1 ngày' : '7 ngày'}</button>)}
                    </div>

                    <button
                      type="button"
                      className="danger"
                      disabled={conversationActionLoading}
                      onClick={clearConversationHistory}
                    >
                      Xóa lịch sử
                    </button>

                    <button type="button" className="danger" disabled={conversationActionLoading} onClick={hideConversation}>
                      Xóa khỏi danh sách
                    </button>

                    <button
                      type="button"
                      className="danger"
                      onClick={() => { setMenuOpen(false); setLogoutConfirmOpen(true) }}
                    >
                      Đăng xuất
                    </button>

                  </div>
                )}

              </div>

            </div>

          </header>

          {/* SEARCH TRONG CHAT */}

          {chatSearchOpen && (
            <div className="chat-search-bar">

              <span>
                ⌕
              </span>

              <input
                autoFocus
                value={chatSearch}
                onChange={(event) =>
                  setChatSearch(
                    event.target.value,
                  )
                }
                placeholder="Tìm trong cuộc trò chuyện..."
              />

              {chatSearch && (
                <button
                  type="button"
                  onClick={() =>
                    setChatSearch('')
                  }
                  aria-label="Xóa tìm kiếm"
                >
                  ×
                </button>
              )}

            </div>
          )}

          {/* =====================================================
              MESSAGE AREA
          ====================================================== */}

          <div
            ref={messagesRef}
            className="messages"
            onScroll={handleMessagesScroll}
          >

            {Number(conversationId) === Number(AI_CONVERSATION_ID) && (
              <div className="ai-chat-panel">
                <div className="ai-chat-panel-head">
                  <div className="ai-chat-panel-avatar">
                    <img className="dodo-avatar-image" src={dodoAssets.base} alt="Dodo" />
                  </div>
                  <div>
                    <span className="ai-chat-panel-title">AI Assistant</span>
                    <span className="ai-chat-panel-status">
                      {aiStatus === 'processing' ? 'Đang xử lý' : aiStatus === 'waiting' ? 'Đang khởi động' : aiStatus === 'error' ? 'Thất bại' : 'Online'}
                    </span>
                  </div>
                </div>
                <div className="ai-chat-panel-empty">
                  <strong>Xin chào! Tôi là AI Assistant.</strong>
                  <span>Hỏi tôi giải thích, viết code, tóm tắt hoặc trò chuyện.</span>
                </div>
                <div className="ai-chat-quick-actions">
                  {['Giải thích bài này', 'Viết code', 'Tóm tắt', 'Hỏi AI'].map((label) => (
                    <button type="button" className="ai-chat-quick-action" key={label} onClick={() => setMessage(label)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loadingOlder && (
              <div className="history-loader" aria-live="polite">
                Đang tải tin nhắn cũ hơn...
              </div>
            )}

            {newMessages && (
              <button
                type="button"
                className="new-messages-indicator"
                onClick={scrollToBottom}
              >
                ↓ Tin nhắn mới
              </button>
            )}

            <div className="today">
              <span>
                Hôm nay
              </span>
            </div>

            {loading ? (
              <div className="center-state">

                <div className="loading-ring" />

                <div className="empty">

                  <h3>
                    Đang tải tin nhắn
                  </h3>

                  <p>
                    Vui lòng chờ một chút...
                  </p>

                </div>

              </div>
            ) : visibleMessages.length ===
              0 ? (
              <div className="center-state">

                <div className="empty-icon">
                  ✦
                </div>

                <div className="empty">

                  <h3>
                    {chatSearch.trim()
                      ? 'Không tìm thấy tin nhắn'
                      : conversationId && conversationInfo?.type === 'direct'
                        ? `Bạn đang trò chuyện với ${conversationInfo.partnerName || 'người bạn này'}`
                        : conversationId ? 'Bắt đầu trò chuyện' : 'Chưa có cuộc trò chuyện'}
                  </h3>

                  <p>
                    {chatSearch.trim()
                      ? 'Không có tin nhắn phù hợp với từ khóa.'
                      : conversationId && conversationInfo?.type === 'direct'
                        ? 'Nhắn một tin để bắt đầu cuộc trò chuyện.'
                        : conversationId ? 'Gửi một tin nhắn để bắt đầu.' : 'Mở Bạn bè và chọn Nhắn tin để bắt đầu.'}
                  </p>

                </div>

              </div>
            ) : (
              visibleMessages.map(
                (item) => (
                  <div
                    key={item.id}
                    className={`message-row ${
                      item.sender
                    } ${highlightedMessageId === String(item.id) ? 'pinned-highlight' : ''}`}
                    data-message-id={item.id}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setActiveMessageAction(item.id)
                    }}
                  >

                    {item.sender !==
                      'me' && (
                      <div className="message-avatar">
                        {item.sender === 'ai' ? (
                          <img
                            className="dodo-avatar-image"
                            src={dodoAssets.base}
                            alt="Dodo"
                          />
                        ) : 'A'}
                      </div>
                    )}

                    <div className="message-group">

                      {item.reply_to && (
                        <div className="message-reply-preview">
                          <strong>{item.reply_to.username}</strong>
                          <span>{item.reply_to.message || 'Tin nhắn đã xóa'}</span>
                        </div>
                      )}

                      <div className={`bubble ${item.is_deleted ? 'deleted' : ''}`}>
                        {item.is_pinned && !item.is_deleted && (
                          <div className="pinned-indicator">
                            📌 Đã ghim
                          </div>
                        )}
                        {item.forwarded_message && !item.is_deleted && (
                          <div className="forwarded-label">
                            <span>↗</span>
                            Đã chuyển tiếp từ {item.forwarded_message.username || 'người dùng'}
                          </div>
                        )}
                        {renderMessageText(item)}
                        {item.attachment && !item.is_deleted && (
                          <div className="message-attachment">
                            {item.attachment.attachment_type === 'image' && (
                              <a href={item.attachment.file_url} target="_blank" rel="noreferrer">
                                <img src={item.attachment.file_url || item.attachment.thumbnail_url} alt={item.attachment.file_name || 'Ảnh đính kèm'} />
                              </a>
                            )}
                            {item.attachment.attachment_type === 'video' && (
                              <video controls playsInline preload="metadata" poster={item.attachment.thumbnail_url || ''} src={item.attachment.file_url}>
                                Trình duyệt của bạn không hỗ trợ video.
                              </video>
                            )}
                            {item.attachment.attachment_type !== 'image' && item.attachment.attachment_type !== 'video' && (
                              <a href={item.attachment.file_url} target="_blank" rel="noreferrer">
                                {item.attachment.file_name || 'Tệp đính kèm'}
                              </a>
                            )}
                          </div>
                        )}
                      </div>

                      {!item.is_deleted && (
                        <button
                          type="button"
                          className="message-reaction-trigger"
                          aria-label="Thêm reaction"
                          title="Thêm reaction"
                          onClick={(event) => openReactionPicker(event, item.id)}
                        >
                          +
                        </button>
                      )}

                      {item.reactions && item.reactions.length > 0 && !item.is_deleted && (
                        <div className="message-reactions">
                          {Object.entries(
                            item.reactions.reduce((acc, r) => {
                              if (!acc[r.reaction_type]) acc[r.reaction_type] = { emoji: r.reaction_type, users: [], count: 0, hasCurrentUser: false }
                              acc[r.reaction_type].users.push(r)
                              acc[r.reaction_type].count += 1
                              if (r.user_id === authUser?.id) acc[r.reaction_type].hasCurrentUser = true
                              return acc
                            }, {})
                          ).map(([type, data]) => (
                            <button
                              key={type}
                              type="button"
                              className={`reaction-badge ${data.hasCurrentUser ? 'active' : ''}`}
                              onClick={(e) => toggleReaction(item.id, type)}
                              onContextMenu={(e) => openReactionPicker(e, item.id)}
                              title={`${data.users.map(u => u.username || u.full_name).join(', ')}`}
                            >
                              <span className="reaction-emoji">{data.emoji}</span>
                              <span className="reaction-count">{data.count}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {activeMessageAction === item.id && (
                        <div className="message-actions">
                          {!item.is_deleted && <button type="button" onClick={() => { setReplyingTo(item); setActiveMessageAction(null) }}>Trả lời</button>}
                          {!item.is_deleted && <button type="button" onClick={() => copyMessage(item)}>Sao chép</button>}
                          {!item.is_deleted && <button type="button" onClick={() => openForwardDialog(item)}>Chuyển tiếp</button>}
                          {!item.is_deleted && <button type="button" onClick={() => togglePin(item)}>{item.is_pinned ? 'Bỏ ghim' : 'Ghim tin nhắn'}</button>}
                          {!item.is_deleted && <button type="button" onClick={(e) => openReactionPicker(e, item.id)}>Reaction</button>}
                          {item.sender === 'me' && !item.is_deleted && <button type="button" onClick={() => { setEditingMessage(item); setMessage(item.text); setActiveMessageAction(null) }}>Sửa</button>}
                          {item.sender === 'me' && !item.is_deleted && <button type="button" className="danger" onClick={() => deleteMessage(item)}>Xóa</button>}
                        </div>
                      )}

                      <time>
                        {formatTime(
                          item.created_at,
                        )}
                        {item.sender === 'me' && item.status && (
                          <span className={`message-status ${item.status}`}>
                            {item.status === 'sending' ? ' ◷' : item.status === 'failed' ? ' !' : item.status === 'read' ? ' ✓✓' : item.status === 'delivered' ? ' ✓' : ' ✓'}
                          </span>
                        )}
                        {item.is_edited && !item.is_deleted && <span className="message-edited"> · đã sửa</span>}
                      </time>

                      {item.status === 'failed' && (
                        <button
                          type="button"
                          className="message-retry"
                          onClick={() => retryMessage(item)}
                        >
                          Thử lại
                        </button>
                      )}

                    </div>

                  </div>
                ),
              )
            )}

            {/* AI đang xử lý */}

            {!chatSearch.trim() &&
              aiProcessing && (
                <div className="message-row ai">

                  <div className="message-avatar">
                    ✦
                  </div>

                  <div className="typing">

                    <i />
                    <i />
                    <i />

                  </div>

                </div>
              )}

            {!chatSearch.trim() && typingUsers.length > 0 && (
              <div className="message-row typing-row">
                <div className="message-avatar">•••</div>
                <div className="typing">
                  <span className="typing-label">
                    {typingUsers.length === 1
                      ? `${typingUsers[0].username} đang nhập...`
                      : `${typingUsers.length} người đang nhập...`}
                  </span>
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            )}

            {error && (
              <div className="error">
                {error}
              </div>
            )}

            <div ref={bottomRef} />

          </div>

          {/* FILE INPUT */}

          <input
            ref={fileInputRef}
            type="file"
            hidden
            accept={fileInputAccept}
            onChange={handleFileChange}
          />

          {/* =====================================================
              ATTACHMENT MENU
          ====================================================== */}

          <div
            className={`attachment-menu ${
              attachOpen
                ? 'show'
                : ''
            }`}
            ref={attachRef}
          >

            <button
              type="button"
              onClick={() => {
                setFileInputAccept('image/*')
                fileInputRef.current?.click()
                setAttachOpen(false)
              }}
            >
              <span>
                ▣
              </span>
              Ảnh
            </button>

            <button
              type="button"
              onClick={() => {
                setFileInputAccept('.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip,.rar')
                fileInputRef.current?.click()
                setAttachOpen(false)
              }}
            >
              <span>
                □
              </span>
              Tài liệu
            </button>

            <button
              type="button"
              onClick={() => {
                setFileInputAccept('video/*')
                fileInputRef.current?.click()
                setAttachOpen(false)
              }}
            >
              <span>
                ◉
              </span>
              Video
            </button>

          </div>

          {/* =====================================================
              EMOJI MENU
          ====================================================== */}

          <div
            className={`emoji-menu ${
              emojiOpen
                ? 'show'
                : ''
            }`}
            ref={emojiRef}
          >

            {emojis.map(
              (emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() =>
                    insertEmoji(
                      emoji,
                    )
                  }
                >
                  {emoji}
                </button>
              ),
            )}

          </div>

          {/* =====================================================
              REACTION PICKER
          ====================================================== */}

          <div
            className={`reaction-picker ${reactionPickerOpen ? 'show' : ''}`}
            ref={reactionPickerRef}
            style={{
              left: reactionPickerAnchor.x,
              top: reactionPickerAnchor.y,
            }}
          >
            {reactionEmojis.map(
              (emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={(e) => {
                    if (reactionPickerMessageId) toggleReaction(reactionPickerMessageId, emoji)
                  }}
                >
                  {emoji}
                </button>
              ),
            )}
          </div>

          {pinnedPanelOpen && (
            <div className="pinned-panel-backdrop" role="presentation" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPinnedPanelOpen(false)
            }}>
              <div className="pinned-panel" role="dialog" aria-modal="true" aria-labelledby="pinned-title">
                <div className="pinned-panel-header">
                  <div>
                    <span className="forward-kicker">Conversation</span>
                    <h3 id="pinned-title">📌 Tin nhắn đã ghim</h3>
                  </div>
                  <button type="button" aria-label="Đóng tin nhắn đã ghim" onClick={() => setPinnedPanelOpen(false)}>×</button>
                </div>
                <div className="pinned-list">
                  {pinnedLoading && <div className="forward-state">Đang tải...</div>}
                  {pinnedError && <div className="pinned-error" role="alert">{pinnedError}</div>}
                  {!pinnedLoading && !pinnedError && pinnedMessages.map((pin) => (
                    <button type="button" className="pinned-item" key={pin.id} onClick={() => jumpToPinnedMessage(pin.id)}>
                      <span className="pinned-item-mark">📌</span>
                      <span className="pinned-item-copy">
                        <strong>{pin.username || 'Người dùng'}</strong>
                        <span>{pin.message || pin.text || 'Tệp đính kèm'}</span>
                        <small>{formatTime(pin.created_at)}</small>
                      </span>
                    </button>
                  ))}
                  {!pinnedLoading && !pinnedError && !pinnedMessages.length && <div className="forward-state">Chưa có tin nhắn được ghim.</div>}
                </div>
              </div>
            </div>
          )}

          {forwardMessage && (
            <div className="forward-modal-backdrop" role="presentation" onMouseDown={(event) => {
              if (event.target === event.currentTarget && !forwardLoading) setForwardMessage(null)
            }}>
              <div className="forward-modal" role="dialog" aria-modal="true" aria-labelledby="forward-title">
                <div className="forward-modal-header">
                  <div>
                    <span className="forward-kicker">Chia sẻ message</span>
                    <h3 id="forward-title">Chuyển tiếp tin nhắn</h3>
                  </div>
                  <button type="button" aria-label="Đóng" onClick={() => setForwardMessage(null)} disabled={forwardLoading}>×</button>
                </div>

                <div className="forward-preview">
                  <span>↗</span>
                  <p>{forwardMessage.text || 'Tệp đính kèm'}</p>
                </div>

                <input
                  className="forward-search"
                  value={forwardSearch}
                  onChange={(event) => setForwardSearch(event.target.value)}
                  placeholder="Tìm cuộc trò chuyện..."
                  aria-label="Tìm cuộc trò chuyện để chuyển tiếp"
                />

                <div className="forward-conversation-list">
                  {forwardLoading && <div className="forward-state">Đang xử lý...</div>}
                  {!forwardLoading && filteredForwardConversations.map((conversation) => (
                    <button
                      type="button"
                      key={conversation.id}
                      className={`forward-conversation ${forwardSelectedIds.includes(conversation.id) ? 'selected' : ''}`}
                      onClick={() => toggleForwardConversation(conversation.id)}
                    >
                      <span className="forward-conversation-check">{forwardSelectedIds.includes(conversation.id) ? '✓' : ''}</span>
                      <span className="forward-conversation-avatar">{conversation.name.slice(0, 1).toUpperCase()}</span>
                      <span className="forward-conversation-copy">
                        <strong>{conversation.name}</strong>
                        <small>{conversation.member_count} thành viên</small>
                      </span>
                    </button>
                  ))}
                  {!forwardLoading && !filteredForwardConversations.length && <div className="forward-state">Không tìm thấy cuộc trò chuyện</div>}
                </div>

                {forwardError && <p className="forward-error" role="alert">{forwardError}</p>}
                <div className="forward-modal-footer">
                  <button type="button" className="forward-cancel" onClick={() => setForwardMessage(null)} disabled={forwardLoading}>Hủy</button>
                  <button type="button" className="forward-submit" onClick={submitForward} disabled={forwardLoading || !forwardSelectedIds.length}>
                    {forwardLoading ? 'Đang gửi...' : `Gửi${forwardSelectedIds.length ? ` (${forwardSelectedIds.length})` : ''}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {forwardSuccess && (
            <div className="forward-success" role="status">
              {forwardSuccess}
              <button type="button" aria-label="Đóng thông báo" onClick={() => setForwardSuccess('')}>×</button>
            </div>
          )}

          {logoutConfirmOpen && (
            <div className="forward-modal-backdrop" role="presentation">
              <div className="forward-modal logout-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title">
                <div className="forward-modal-header">
                  <div>
                    <span className="forward-kicker">Tài khoản</span>
                    <h3 id="logout-title">Đăng xuất?</h3>
                  </div>
                </div>
                <p>Bạn có chắc muốn đăng xuất khỏi tài khoản hiện tại?</p>
                <div className="forward-modal-footer">
                  <button type="button" className="forward-cancel" onClick={() => setLogoutConfirmOpen(false)} disabled={logoutLoading}>Hủy</button>
                  <button type="button" className="forward-submit" onClick={logout} disabled={logoutLoading}>{logoutLoading ? 'Đang đăng xuất...' : 'Đăng xuất'}</button>
                </div>
              </div>
            </div>
          )}

          {/* =====================================================
              COMPOSER
          ====================================================== */}

          {(editingMessage || replyingTo || selectedAttachment || attachmentPreview) && (
            <div className="composer-context">
              <span>
                {editingMessage ? `Đang sửa: ${editingMessage.text}` : replyingTo ? `Trả lời ${replyingTo.username}: ${replyingTo.text}` : `Đã chọn: ${selectedAttachment?.file_name || attachmentPreview?.fileName || 'Tệp đính kèm'}`}
              </span>
              <button type="button" onClick={() => { setEditingMessage(null); setReplyingTo(null); setSelectedAttachment(null); setAttachmentPreview(null); setMessage('') }} aria-label="Hủy thao tác">×</button>
            </div>
          )}

          {(attachmentPreview || selectedAttachment) && (
            <div className="composer-media-preview">
              {selectedAttachment?.attachment_type === 'image' || attachmentPreview?.kind === 'image' ? (
                <img src={selectedAttachment?.file_url || selectedAttachment?.thumbnail_url || attachmentPreview?.url} alt={selectedAttachment?.file_name || attachmentPreview?.fileName || 'Ảnh'} />
              ) : selectedAttachment?.attachment_type === 'video' || attachmentPreview?.kind === 'video' ? (
                <video src={selectedAttachment?.file_url || attachmentPreview?.url} controls playsInline preload="metadata" />
              ) : null}
              <span>
                <strong>{selectedAttachment?.file_name || attachmentPreview?.fileName || 'Tệp đính kèm'}</strong>
                <small>{uploadingAttachment ? 'Uploading...' : selectedAttachment ? `${Math.round((selectedAttachment.file_size || attachmentPreview?.size || 0) / 1024)} KB` : 'Preview'}</small>
              </span>
            </div>
          )}

          <footer className="composer">

            <button
              className="composer-icon"
              type="button"
              disabled={!conversationId}
              onClick={() => {
                setEmojiOpen(
                  (value) =>
                    !value,
                )
                setAttachOpen(false)
              }}
              aria-label="Emoji"
            >
              ☺
            </button>

            <button
              className="composer-icon"
              type="button"
              disabled={!conversationId}
              onClick={() => {
                setAttachOpen(
                  (value) =>
                    !value,
                )
                setEmojiOpen(false)
              }}
              aria-label="Đính kèm"
            >
              ＋
            </button>

            <div className="input-box">

              {mentionState.active && mentionCandidates.length > 0 && (
                <div className="mention-suggestions" role="listbox" aria-label="Người dùng để mention">
                  {mentionCandidates.map((member, index) => (
                    <button
                      type="button"
                      key={member.id}
                      className={index === mentionIndex ? 'active' : ''}
                      role="option"
                      aria-selected={index === mentionIndex}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        selectMention(member)
                      }}
                    >
                      <span className="mention-avatar">{member.username.slice(0, 1).toUpperCase()}</span>
                      <span>
                        <strong>@{member.username}</strong>
                        {member.full_name && member.full_name !== member.username && <small>{member.full_name}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <input
                ref={composerInputRef}
                value={message}
                onChange={(event) => handleComposerChange(event.target.value, event.target.selectionStart)}
                onKeyDown={
                  handleKeyDown
                }
                disabled={!conversationId}
                placeholder={conversationId ? 'Nhập tin nhắn...' : 'Chọn một cuộc trò chuyện để nhắn tin'}
              />

            </div>

            <button
              className="send"
              type="button"
              disabled={!conversationId || (!message.trim() && !selectedAttachment)}
              onClick={
                editingMessage ? saveEdit : sendMessage
              }
              aria-label={editingMessage ? 'Lưu chỉnh sửa' : 'Gửi tin nhắn'}
            >
              {editingMessage ? '✓' : '↑'}
            </button>

          </footer>

        </section>
        </>
      )}
    </AppShell>
  )
}

export default App