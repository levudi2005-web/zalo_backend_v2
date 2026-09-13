import { useEffect, useRef, useState } from 'react'
import { ModuleScaffold } from './ModuleScaffold'

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function CallsModule({ apiUrl, currentUserId, socket }) {
  const [friends, setFriends] = useState([])
  const [callState, setCallState] = useState({ status: 'idle', callType: 'audio', remoteUserId: null, callId: null, incoming: false })
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOn, setIsCameraOn] = useState(true)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)

  const peerRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const callIsInitiatorRef = useRef(false)

  const loadFriends = async () => {
    if (!apiUrl) return
    try {
      const response = await fetch(`${apiUrl}/api/friendships`, { credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể tải bạn bè')
      const accepted = Array.isArray(data.friendships) ? data.friendships.filter((friend) => friend.status === 'accepted') : []
      setFriends(accepted.filter((friend) => Number(friend.user_id) !== Number(currentUserId) && Number(friend.friend_id) !== Number(currentUserId)))
    } catch (loadError) {
      setError(loadError.message || 'Không thể tải danh sách bạn bè.')
    }
  }

  useEffect(() => {
    loadFriends()
  }, [apiUrl, currentUserId])

  useEffect(() => {
    if (!socket) return undefined

    const handleIncoming = (payload) => {
      setCallState({ status: 'ringing', callType: payload.callType || 'audio', remoteUserId: Number(payload.fromUserId), callId: payload.callId, incoming: true })
      setError('')
    }

    const handleStarted = (payload) => {
      setCallState({ status: 'connecting', callType: payload.callType || 'audio', remoteUserId: Number(payload.targetUserId), callId: payload.callId, incoming: false })
      setError('')
    }

    const handleAccept = async (payload) => {
      setCallState({ status: 'connected', callType: payload.callType || 'audio', remoteUserId: Number(payload.toUserId || payload.fromUserId), callId: payload.callId, incoming: false })
      setError('')
      const stream = await ensureLocalMedia(payload.callType || 'audio')
      if (!stream) return
      if (!peerRef.current) {
        const peer = createPeerConnection(Number(payload.toUserId || payload.fromUserId))
        callIsInitiatorRef.current = false
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        socket.emit('call:offer', { callId: payload.callId, targetUserId: Number(payload.toUserId || payload.fromUserId), offer })
      }
    }

    const handleReject = () => {
      resetCallState('Cuộc gọi đã bị từ chối.')
    }

    const handleEnd = () => {
      resetCallState('')
    }

    const handleOffer = async (payload) => {
      try {
        if (!payload?.offer) return
        const peer = createPeerConnection(Number(payload.fromUserId))
        await peer.setRemoteDescription(new RTCSessionDescription(payload.offer))
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        socket.emit('call:answer', { callId: payload.callId, targetUserId: Number(payload.fromUserId), answer })
      } catch (callError) {
        setError('Không thể thiết lập cuộc gọi.')
      }
    }

    const handleAnswer = async (payload) => {
      if (!peerRef.current || !payload?.answer) return
      await peerRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer))
    }

    const handleCandidate = (payload) => {
      if (!peerRef.current || !payload?.candidate) return
      peerRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => undefined)
    }

    const handleError = (payload) => {
      setError(payload?.message || 'Không thể thực hiện cuộc gọi.')
      resetCallState('')
    }

    socket.on('call:incoming', handleIncoming)
    socket.on('call:started', handleStarted)
    socket.on('call:accept', handleAccept)
    socket.on('call:reject', handleReject)
    socket.on('call:end', handleEnd)
    socket.on('call:offer', handleOffer)
    socket.on('call:answer', handleAnswer)
    socket.on('call:ice-candidate', handleCandidate)
    socket.on('call:error', handleError)

    return () => {
      socket.off('call:incoming', handleIncoming)
      socket.off('call:started', handleStarted)
      socket.off('call:accept', handleAccept)
      socket.off('call:reject', handleReject)
      socket.off('call:end', handleEnd)
      socket.off('call:offer', handleOffer)
      socket.off('call:answer', handleAnswer)
      socket.off('call:ice-candidate', handleCandidate)
      socket.off('call:error', handleError)
    }
  }, [socket])

  const resetCallState = (nextError = '') => {
    setError(nextError)
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
    setLocalStream(null)
    setRemoteStream(null)
    if (peerRef.current) {
      peerRef.current.close()
      peerRef.current = null
    }
    setCallState({ status: 'idle', callType: 'audio', remoteUserId: null, callId: null, incoming: false })
    setIsMuted(false)
    setIsCameraOn(true)
    setDuration(0)
  }

  useEffect(() => {
    if (!localVideoRef.current || !localStream) return
    localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (!remoteVideoRef.current || !remoteStream) return
    remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(() => {
    if (callState.status !== 'connected') return undefined
    const timer = window.setInterval(() => setDuration((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [callState.status])

  const createPeerConnection = (targetUserId) => {
    if (peerRef.current) {
      peerRef.current.close()
    }

    const peer = new RTCPeerConnection({ iceServers: STUN_SERVERS })
    peerRef.current = peer

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => peer.addTrack(track, mediaStreamRef.current))
    }

    peer.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream()
      setRemoteStream(stream)
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream
    }

    peer.onicecandidate = (event) => {
      if (!event.candidate || !socket) return
      socket.emit('call:ice-candidate', {
        callId: callState.callId,
        targetUserId,
        candidate: event.candidate.toJSON(),
      })
    }

    peer.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        setError('Kết nối cuộc gọi bị mất.')
      }
    }

    return peer
  }

  const ensureLocalMedia = async (callType) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Trình duyệt không hỗ trợ microphone/camera.')
      return null
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video',
      })
      mediaStreamRef.current = stream
      setLocalStream(stream)
      setIsMuted(false)
      setIsCameraOn(callType !== 'video' || !!stream.getVideoTracks().length)
      return stream
    } catch (mediaError) {
      setError('Không thể truy cập mic/camera. Vui lòng cấp quyền và thử lại.')
      return null
    }
  }

  const startCall = async (targetUserId, callType = 'audio') => {
    if (!socket || !targetUserId) return
    const stream = await ensureLocalMedia(callType)
    if (!stream) return
    callIsInitiatorRef.current = true
    setCallState({ status: 'connecting', callType, remoteUserId: Number(targetUserId), callId: null, incoming: false })
    socket.emit('call:start', { targetUserId: Number(targetUserId), callType })
  }

  const acceptCall = async () => {
    if (!socket || !callState.callId) return
    const stream = await ensureLocalMedia(callState.callType)
    if (!stream) return
    socket.emit('call:accept', { callId: callState.callId })
    setCallState((current) => ({ ...current, status: 'connected', incoming: false }))
    callIsInitiatorRef.current = false
  }

  const rejectCall = () => {
    if (!socket || !callState.callId) return
    socket.emit('call:reject', { callId: callState.callId })
    resetCallState('')
  }

  const endCall = () => {
    if (socket && callState.callId) {
      socket.emit('call:end', { callId: callState.callId })
    }
    resetCallState('')
  }

  const toggleMute = () => {
    if (!mediaStreamRef.current) return
    const nextValue = !isMuted
    mediaStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextValue
    })
    setIsMuted(nextValue)
  }

  const toggleCamera = () => {
    if (!mediaStreamRef.current) return
    const nextValue = !isCameraOn
    mediaStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = nextValue
    })
    setIsCameraOn(nextValue)
  }

  const callList = Array.isArray(friends) ? friends : []

  return (
    <ModuleScaffold icon="◉" title="Cuộc gọi" description="Gọi thoại và video trực tiếp qua Socket.IO + WebRTC.">
      <div className="module-call-shell">
        <div className="module-call-header">
          <strong>Danh sách bạn bè</strong>
          <span>{callState.status === 'idle' ? 'Sẵn sàng' : callState.status}</span>
        </div>

        {error && <div className="module-call-error">{error}</div>}

        {callState.status !== 'idle' && (
          <div className="module-call-video-panel">
            {callState.callType === 'video' && (
              <>
                <video ref={remoteVideoRef} autoPlay playsInline className="module-call-remote-video" />
                <video ref={localVideoRef} autoPlay muted playsInline className="module-call-local-video" />
              </>
            )}
            {callState.callType === 'audio' && (
              <div className="module-call-audio-panel">
                <div className="module-call-avatar">{String(callState.remoteUserId || 'U').slice(0, 1).toUpperCase()}</div>
                <strong>{callState.remoteUserId ? `User ${callState.remoteUserId}` : 'Đang kết nối'}</strong>
                <span>{callState.status === 'connected' ? formatDuration(duration) : callState.status}</span>
              </div>
            )}
            <div className="module-call-actions">
              <button type="button" className="module-call-button" onClick={toggleMute}>{isMuted ? 'Mic off' : 'Mic on'}</button>
              {callState.callType === 'video' && (
                <button type="button" className="module-call-button" onClick={toggleCamera}>{isCameraOn ? 'Camera on' : 'Camera off'}</button>
              )}
              {callState.incoming ? (
                <>
                  <button type="button" className="module-call-button primary" onClick={acceptCall}>Accept</button>
                  <button type="button" className="module-call-button danger" onClick={rejectCall}>Reject</button>
                </>
              ) : (
                <button type="button" className="module-call-button danger" onClick={endCall}>End</button>
              )}
            </div>
          </div>
        )}

        {callState.status === 'idle' && (
          <div className="module-call-list">
            {callList.length === 0 ? <p>Không có bạn bè nào khả dụng để gọi.</p> : callList.map((friend) => {
              const friendId = Number(friend.user_id) === Number(currentUserId) ? Number(friend.friend_id) : Number(friend.user_id)
              return (
                <div key={friend.id || friendId} className="module-call-row">
                  <div>
                    <strong>{friend.friend_full_name || friend.friend_username || friend.username}</strong>
                    <span>@{friend.friend_username || friend.username}</span>
                  </div>
                  <div className="module-call-actions small">
                    <button type="button" className="module-call-button" onClick={() => startCall(friendId, 'audio')}>Audio</button>
                    <button type="button" className="module-call-button primary" onClick={() => startCall(friendId, 'video')}>Video</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </ModuleScaffold>
  )
}
