import { useMemo, useState } from 'react'
import { DODO_FEATURES } from './dodoFeatures'
import './DodoCommandBox.css'

const SUMMARY_CHOICES = ['Ngắn', 'Vừa', 'Chi tiết']
const WRITING_MODES = [
  'viết lại',
  'sửa câu',
  'sửa chính tả',
  'đổi giọng văn',
  'rút gọn',
  'mở rộng',
  'viết email',
  'viết tin nhắn',
  'viết mô tả',
]
const REPLY_TONES = ['thân thiện', 'ngắn gọn', 'lịch sự', 'vui vẻ', 'khéo léo']

function getFeaturePrompt(featureId, draft, options) {
  const trimmed = draft.trim()

  if (!trimmed) {
    return ''
  }

  switch (featureId) {
    case 'summarize': {
      const length = options.summaryLength || 'Vừa'
      return `Hãy tóm tắt văn bản sau theo mức độ ${length.toLowerCase()} và giữ ý chính. Trả lời ngắn gọn bằng tiếng Việt.\n\n${trimmed}`
    }
    case 'writing': {
      const mode = options.writingMode || 'viết lại'
      return `Hãy ${mode} cho đoạn văn bản sau theo phong cách tự nhiên, rõ ràng và phù hợp với người đọc Việt Nam.\n\n${trimmed}`
    }
    case 'translate': {
      const from = options.translateFrom || 'vi'
      const to = options.translateTo || 'en'
      return `Dịch đoạn văn bản sau từ ${from.toUpperCase()} sang ${to.toUpperCase()}. Giữ nguyên nghĩa, ngữ điệu tự nhiên và trả lời bằng tiếng ${to.toUpperCase()}.\n\n${trimmed}`
    }
    case 'explain': {
      return `Hãy giải thích đoạn sau một cách rõ ràng, ngắn gọn và dễ hiểu. Nếu có thể, nêu ví dụ minh họa và không dài dòng.\n\n${trimmed}`
    }
    case 'ask': {
      return `Hãy trả lời câu hỏi hoặc yêu cầu này theo phong cách Dodo: thân thiện, ngắn gọn và rõ ràng.\n\n${trimmed}`
    }
    case 'reply': {
      const tone = options.replyTone || 'thân thiện'
      return `Hãy gợi ý một câu trả lời cho nội dung sau theo phong cách ${tone}, dễ đọc, tự nhiên và không quá dài.\n\n${trimmed}`
    }
    default:
      return trimmed
  }
}

export function DodoCommandBox({
  isOpen,
  onClose,
  onOpenChat,
  onSubmitPrompt,
  selectedText = '',
}) {
  const [selectedFeature, setSelectedFeature] = useState('chat')
  const [draft, setDraft] = useState(selectedText)
  const [summaryLength, setSummaryLength] = useState('Vừa')
  const [writingMode, setWritingMode] = useState('viết lại')
  const [translateFrom, setTranslateFrom] = useState('vi')
  const [translateTo, setTranslateTo] = useState('en')
  const [replyTone, setReplyTone] = useState('thân thiện')
  const [settings, setSettings] = useState({
    mascot: true,
    animations: true,
    bubbles: true,
    reducedMotion: false,
  })

  const activeFeature = useMemo(
    () => DODO_FEATURES.find((feature) => feature.id === selectedFeature) ?? DODO_FEATURES[0],
    [selectedFeature],
  )

  if (!isOpen) {
    return null
  }

  const handleFeatureSelect = (feature) => {
    setSelectedFeature(feature.id)

    if (feature.id === 'chat') {
      onOpenChat?.()
      onClose?.()
      return
    }

    if (feature.id === 'settings') {
      return
    }

    if (feature.id === 'document' || feature.id === 'image') {
      onClose?.()
      return
    }

    if (feature.id === 'memory') {
      const memoryPrompt = 'Dodo hãy lưu ngữ cảnh hiện tại và đề xuất cách Dodo nên nhớ tình huống của tôi tốt hơn trong cuộc trò chuyện tiếp theo.'
      onSubmitPrompt?.(memoryPrompt)
      onClose?.()
      return
    }

    setDraft((current) => current || selectedText || '')
  }

  const handleSubmit = () => {
    const prompt = getFeaturePrompt(selectedFeature, draft, {
      summaryLength,
      writingMode,
      translateFrom,
      translateTo,
      replyTone,
    })

    if (!prompt) {
      return
    }

    onSubmitPrompt?.(prompt)
    setDraft('')
    onClose?.()
  }

  const featureList = DODO_FEATURES

  return (
    <div
      className="dodo-command-box"
      role="dialog"
      aria-modal="false"
      aria-label="Hộp lệnh Dodo"
    >
      <div className="dodo-command-header">
        <div className="dodo-command-title-wrap">
          <span className="dodo-command-badge">Dodo</span>
          <span className="dodo-command-badge subtle">✦</span>
        </div>

        <button
          type="button"
          className="dodo-command-close"
          onClick={onClose}
          aria-label="Đóng hộp lệnh Dodo"
        >
          ×
        </button>
      </div>

      <p className="dodo-command-greeting">Dodo giúp gì cho bạn nè?</p>

      <div className="dodo-command-grid" role="list" aria-label="Các tính năng Dodo">
        {featureList.map((feature) => {
          const isSelected = feature.id === selectedFeature
          const isDisabled = feature.enabled === false

          return (
            <button
              key={feature.id}
              type="button"
              role="listitem"
              className={`dodo-feature-card${isSelected ? ' selected' : ''}${isDisabled ? ' disabled' : ''}`}
              onClick={() => handleFeatureSelect(feature)}
              disabled={isDisabled}
              aria-label={feature.title}
            >
              <span className="dodo-feature-icon" aria-hidden="true">{feature.icon}</span>
              <span className="dodo-feature-body">
                <strong>{feature.title}</strong>
                <small>{feature.comingSoon ? 'Sắp ra mắt' : feature.description}</small>
              </span>
            </button>
          )
        })}
      </div>

      {selectedFeature !== 'chat' && selectedFeature !== 'settings' && ![
        'document',
        'image',
      ].includes(selectedFeature) && (
        <div className="dodo-command-form">
          <label htmlFor="dodo-command-input" className="dodo-command-label">
            {activeFeature.title}
          </label>

          <textarea
            id="dodo-command-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
            placeholder={
              selectedFeature === 'summarize'
                ? 'Dán văn bản bạn muốn tóm tắt...'
                : selectedFeature === 'writing'
                  ? 'Dán đoạn văn bản cần viết lại hoặc chỉnh sửa...'
                  : selectedFeature === 'translate'
                    ? 'Nhập văn bản cần dịch...'
                    : selectedFeature === 'explain'
                      ? 'Nhập khái niệm, code, lỗi hoặc tin nhắn cần giải thích...'
                      : selectedFeature === 'reply'
                        ? 'Dán tin nhắn bạn muốn viết phản hồi cho...'
                        : 'Viết yêu cầu của bạn cho Dodo...'
            }
          />

          {selectedFeature === 'summarize' && (
            <div className="dodo-command-inline">
              <span>Mức độ</span>
              <select value={summaryLength} onChange={(event) => setSummaryLength(event.target.value)}>
                {SUMMARY_CHOICES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}

          {selectedFeature === 'writing' && (
            <div className="dodo-command-inline">
              <span>Thao tác</span>
              <select value={writingMode} onChange={(event) => setWritingMode(event.target.value)}>
                {WRITING_MODES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}

          {selectedFeature === 'translate' && (
            <div className="dodo-command-dual">
              <label>
                <span>Từ</span>
                <select value={translateFrom} onChange={(event) => setTranslateFrom(event.target.value)}>
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>

              <label>
                <span>Sang</span>
                <select value={translateTo} onChange={(event) => setTranslateTo(event.target.value)}>
                  <option value="en">English</option>
                  <option value="vi">Tiếng Việt</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
            </div>
          )}

          {selectedFeature === 'reply' && (
            <div className="dodo-command-inline">
              <span>Giọng</span>
              <select value={replyTone} onChange={(event) => setReplyTone(event.target.value)}>
                {REPLY_TONES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          )}

          <button type="button" className="dodo-command-submit" onClick={handleSubmit}>
            Gửi cho Dodo
          </button>
        </div>
      )}

      {selectedFeature === 'settings' && (
        <div className="dodo-command-form settings-panel">
          <label className="dodo-toggle-row">
            <span>Hiện Dodo</span>
            <input
              type="checkbox"
              checked={settings.mascot}
              onChange={() => setSettings((current) => ({ ...current, mascot: !current.mascot }))}
            />
          </label>

          <label className="dodo-toggle-row">
            <span>Hiệu ứng</span>
            <input
              type="checkbox"
              checked={settings.animations}
              onChange={() => setSettings((current) => ({ ...current, animations: !current.animations }))}
            />
          </label>

          <label className="dodo-toggle-row">
            <span>Bong bóng</span>
            <input
              type="checkbox"
              checked={settings.bubbles}
              onChange={() => setSettings((current) => ({ ...current, bubbles: !current.bubbles }))}
            />
          </label>

          <label className="dodo-toggle-row">
            <span>Giảm chuyển động</span>
            <input
              type="checkbox"
              checked={settings.reducedMotion}
              onChange={() => setSettings((current) => ({ ...current, reducedMotion: !current.reducedMotion }))}
            />
          </label>
        </div>
      )}
    </div>
  )
}
