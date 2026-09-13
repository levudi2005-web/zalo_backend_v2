import { useEffect, useRef, useState } from 'react'
import { dodoAssets } from '../../assets/mascot/dodo'
import './DodoQuickPopup.css'

const QUICK_ACTIONS = [
  { id: 'chat', label: 'Trò chuyện', icon: '💬', description: 'Mở cuộc trò chuyện đầy đủ' },
  { id: 'summarize', label: 'Tóm tắt', icon: '📝', description: 'Tóm gọn nội dung' },
  { id: 'writing', label: 'Viết & dịch', icon: '✨', description: 'Viết lại hoặc dịch' },
  { id: 'ask', label: 'Hỏi Dodo', icon: '🧠', description: 'Hỏi nhanh điều bạn muốn' },
]

const TARGET_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
]

export function DodoQuickPopup({
  isOpen,
  messages,
  processing,
  error,
  selectedText = '',
  anchor = { x: 86, y: 82 },
  onClose,
  onSubmit,
  onOpenChat,
}) {
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState('menu')
  const [writingMode, setWritingMode] = useState('rewrite')
  const [targetLanguage, setTargetLanguage] = useState('en')
  const inputRef = useRef(null)
  const historyRef = useRef(null)
  const popupRef = useRef(null)
  const submitLockRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return undefined

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(focusTimer)
  }, [isOpen])

  useEffect(() => {
    if (isOpen && mode === 'summarize' && selectedText && !draft) {
      setDraft(selectedText)
    }
  }, [isOpen, mode, selectedText, draft])

  useEffect(() => {
    if (!isOpen) return undefined

    const handlePointerDown = (event) => {
      const path = event.composedPath?.() || []
      const clickedInside = popupRef.current && (
        popupRef.current.contains(event.target) || path.includes(popupRef.current)
      )

      if (!clickedInside) onClose?.()
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  useEffect(() => {
    historyRef.current?.scrollTo({
      top: historyRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages, processing, error])

  if (!isOpen) return null

  const submit = () => {
    const text = draft.trim()
    if (!text || submitLockRef.current) return
    submitLockRef.current = true
    const prompts = {
      summarize: `Hãy tóm tắt nội dung sau thật ngắn gọn bằng tiếng Việt, chỉ giữ lại ý chính.\n\n${text}`,
      rewrite: `Hãy viết lại nội dung sau tự nhiên, rõ ràng và chuyên nghiệp hơn.\n\n${text}`,
      translate: `Hãy dịch nội dung sau sang ${TARGET_LANGUAGES.find((item) => item.value === targetLanguage)?.label || 'English'}, giữ nguyên ý nghĩa và trả lời chỉ bằng bản dịch.\n\n${text}`,
      ask: text,
    }

    const prompt = mode === 'writing'
      ? prompts[writingMode]
      : prompts[mode] || text

    onSubmit?.({
      input: prompt,
      action: mode === 'writing' ? writingMode : mode,
      context: selectedText
        ? { type: 'selected_text', content: selectedText, source: 'quick_popup' }
        : null,
    })
    setDraft('')
    window.setTimeout(() => {
      submitLockRef.current = false
    }, 250)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const openMode = (nextMode) => {
    if (nextMode === 'chat') {
      onOpenChat?.()
      return
    }

    setMode(nextMode)
    setDraft(nextMode === 'summarize' ? selectedText : '')
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const goBack = () => {
    setMode('menu')
    setDraft('')
  }

  return (
    <section
      ref={popupRef}
      className="dodo-quick-popup"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      role="dialog"
      aria-modal="false"
      aria-label="Dodo quick companion"
    >
      <header className="dodo-quick-header">
        <div className="dodo-quick-heading">
          {mode !== 'menu' && (
            <button type="button" className="dodo-quick-back" onClick={goBack} aria-label="Quay lại menu Dodo">
              ←
            </button>
          )}
          <div className="dodo-quick-avatar">
            <img src={dodoAssets.base} alt="" />
          </div>
          <div>
            <strong>{mode === 'menu' ? 'Dodo' : QUICK_ACTIONS.find((item) => item.id === mode)?.label}</strong>
            <span>{processing ? 'Đang nghĩ...' : mode === 'menu' ? 'Luôn ở đây bên bạn' : 'Dodo nghe nè'}</span>
          </div>
        </div>
        <button type="button" className="dodo-quick-close" onClick={onClose} aria-label="Đóng Dodo">
          ×
        </button>
      </header>

      <div ref={historyRef} className="dodo-quick-history" aria-live="polite">
        {mode === 'menu' && messages.length === 0 && (
          <div className="dodo-quick-welcome">
            <span>Dodo</span>
            <p>Bạn cần Dodo giúp gì nè? 😄</p>
          </div>
        )}

        {messages.map((item) => (
          <div key={item.id} className={`dodo-quick-message ${item.role}`}>
            <span>{item.role === 'user' ? 'Bạn' : 'Dodo'}</span>
            <p>{item.content}</p>
          </div>
        ))}

        {processing && (
          <div className="dodo-quick-message assistant is-thinking">
            <span>Dodo</span>
            <p><i /><i /><i /></p>
          </div>
        )}

        {error && <p className="dodo-quick-error">{error}</p>}
      </div>

      {mode === 'menu' ? (
        <div className="dodo-quick-actions" aria-label="Tính năng nhanh của Dodo">
          {QUICK_ACTIONS.map((action) => (
            <button key={action.id} type="button" className="dodo-quick-action" onClick={() => openMode(action.id)}>
              <span className="dodo-quick-action-icon" aria-hidden="true">{action.icon}</span>
              <span><strong>{action.label}</strong><small>{action.description}</small></span>
            </button>
          ))}
        </div>
      ) : (
        <div className={`dodo-quick-mode dodo-quick-mode-${mode}`}>
          {mode === 'writing' && (
            <div className="dodo-quick-mode-tabs" role="tablist" aria-label="Chọn thao tác viết">
              <button type="button" className={writingMode === 'rewrite' ? 'active' : ''} onClick={() => setWritingMode('rewrite')}>Viết lại</button>
              <button type="button" className={writingMode === 'translate' ? 'active' : ''} onClick={() => setWritingMode('translate')}>Dịch</button>
            </div>
          )}

          {mode === 'writing' && writingMode === 'translate' && (
            <label className="dodo-quick-language">
              <span>Dịch sang</span>
              <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
                {TARGET_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
              </select>
            </label>
          )}

          <label className="dodo-quick-input-label" htmlFor="dodo-quick-input">
            {mode === 'summarize' ? 'Dán nội dung cần tóm tắt' : mode === 'ask' ? 'Dodo nghe nè 😄' : writingMode === 'translate' ? 'Nhập nội dung cần dịch' : 'Nhập nội dung cần viết lại'}
          </label>
          <div className="dodo-quick-composer">
            <textarea
              ref={inputRef}
              id="dodo-quick-input"
              className="dodo-quick-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={mode === 'summarize' ? 4 : mode === 'ask' ? 1 : 3}
              placeholder={mode === 'summarize' ? 'Nhập hoặc dán văn bản...' : mode === 'ask' ? 'Nhập điều muốn hỏi...' : 'Nhập nội dung...'}
              aria-label="Nhập yêu cầu cho Dodo"
            />
            <button type="button" className="dodo-quick-send" onClick={submit} disabled={!draft.trim()} aria-label="Gửi cho Dodo">↑</button>
          </div>
          <button type="button" className="dodo-quick-submit" onClick={submit} disabled={!draft.trim()}>
            {mode === 'summarize' ? 'Tóm tắt' : mode === 'ask' ? 'Hỏi Dodo' : writingMode === 'translate' ? 'Dịch' : 'Viết lại'}
          </button>
        </div>
      )}
    </section>
  )
}
