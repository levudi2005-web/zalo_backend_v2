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
  const remoteStreamRef = useRef(null)
  const callIsInitiatorRef = useRef(false)
  const pendingIceCandidatesRef = useRef([])

  const loadFriends = async () => {
    if (!apiUrl) return
    try {
      const response = await fetch(`${apiUrl}/api/friendships`, { credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Không thể tải bạn bè')

      const accepted = Array.isArray(data.friendships)
        ? data.friendships.filter((friend) => friend.status === 'accepted')
        : []

      const mappedFriends = accepted
        .map((friend) => {
          const otherUserId = Number(friend.user_id) === Number(currentUserId)
            ? Number(friend.friend_id)
            : Number(friend.user_id)

          return {
            ...friend,
            id: friend.id,
            user_id: Number(friend.user_id),
            friend_id: Number(friend.friend_id),
            otherUserId,
            username: friend.friend_username || friend.username || 'Unknown',
            full_name: friend.friend_full_name || friend.full_name || friend.friend_username || 'Unknown',
            avatar: friend.avatar || null,
          }
        })
        .filter((friend) => Number(friend.otherUserId) > 0 && Number(friend.otherUserId) !== Number(currentUserId))

      setFriends(mappedFriends)
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
      pendingIceCandidatesRef.current = pendingIceCandidatesRef.current.filter((item) => item.callId === payload.callId)
      setCallState({ status: 'ringing', callType: payload.callType || 'audio', remoteUserId: Number(payload.fromUserId), callId: payload.callId, incoming: true })
      setError('')
    }

    const handleStarted = (payload) => {
      pendingIceCandidatesRef.current = pendingIceCandidatesRef.current.filter((item) => item.callId === payload.callId)
      setCallState({ status: 'connecting', callType: payload.callType || 'audio', remoteUserId: Number(payload.targetUserId), callId: payload.callId, incoming: false })
      setError('')
    }

    const handleAccept = async (payload) => {
      console.log('[CALL DEBUG] call:accept received', {
        callId: payload?.callId,
        fromUserId: payload?.fromUserId,
        toUserId: payload?.toUserId,
        callType: payload?.callType,
        socketConnected: socket?.connected,
      })
      setCallState({ status: 'connected', callType: payload.callType || 'audio', remoteUserId: Number(payload.toUserId || payload.fromUserId), callId: payload.callId, incoming: false })
      setError('')
      const stream = await ensureLocalMedia(payload.callType || 'audio')
      if (!stream) return
      if (!peerRef.current) {
        const peer = createPeerConnection(Number(payload.toUserId || payload.fromUserId), payload.callId)
        callIsInitiatorRef.current = false
        console.log('[CALL DEBUG] creating offer', { callId: payload.callId, targetUserId: Number(payload.toUserId || payload.fromUserId) })
        const offer = await peer.createOffer()
        console.log('[CALL DEBUG] offer created', { callId: payload.callId, offerType: offer.type })
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
        console.log('[CALL DEBUG] remote offer received', {
          callId: payload.callId,
          fromUserId: payload.fromUserId,
          targetUserId: payload.toUserId,
          offerType: payload.offer?.type,
        })
        const peer = createPeerConnection(Number(payload.fromUserId), payload.callId)
        await peer.setRemoteDescription(new RTCSessionDescription(payload.offer))
        console.log('[CALL DEBUG] remote description set', { callId: payload.callId, type: 'offer' })
        await flushPendingIceCandidates(peer, payload.callId)
        const answer = await peer.createAnswer()
        console.log('[CALL DEBUG] answer created', { callId: payload.callId, answerType: answer.type })
        await peer.setLocalDescription(answer)
        socket.emit('call:answer', { callId: payload.callId, targetUserId: Number(payload.fromUserId), answer })
      } catch (callError) {
        console.error('[CALL DEBUG] WebRTC error', callError)
        setError('Không thể thiết lập cuộc gọi.')
      }
    }

    const handleAnswer = async (payload) => {
      if (!peerRef.current || !payload?.answer) return
      try {
        console.log('[CALL DEBUG] remote answer received', {
          callId: payload.callId,
          fromUserId: payload.fromUserId,
          answerType: payload.answer?.type,
        })
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer))
        console.log('[CALL DEBUG] remote description set', { callId: payload.callId, type: 'answer' })
        await flushPendingIceCandidates(peerRef.current, payload.callId)
      } catch (answerError) {
        console.error('[CALL DEBUG] WebRTC error', answerError)
        setError('Không thể xác nhận cuộc gọi.')
      }
    }

    const handleCandidate = async (payload) => {
      if (!payload?.candidate) return
      const targetCallId = payload.callId || callState.callId
      const peer = peerRef.current

      console.log('[CALL DEBUG] ICE candidate received', {
        callId: targetCallId,
        hasPeer: !!peer,
        hasRemoteDescription: !!peer?.remoteDescription,
        candidate: payload.candidate?.candidate?.slice(0, 80),
      })

      if (!peer || !peer.remoteDescription) {
        const alreadyQueued = pendingIceCandidatesRef.current.some(
          (item) =>
            item.callId === targetCallId &&
            item.candidate?.candidate === payload.candidate?.candidate &&
            item.candidate?.sdpMid === payload.candidate?.sdpMid &&
            item.candidate?.sdpMLineIndex === payload.candidate?.sdpMLineIndex,
        )

        if (!alreadyQueued) {
          console.warn('[CALL DEBUG] ICE candidate queued', { callId: targetCallId })
          pendingIceCandidatesRef.current.push({
            callId: targetCallId,
            candidate: payload.candidate,
          })
        }
        return
      }

      try {
        await peer.addIceCandidate(new RTCIceCandidate(payload.candidate))
        console.log('[CALL DEBUG] ICE candidate added', { callId: targetCallId })
      } catch (candidateError) {
        const alreadyQueued = pendingIceCandidatesRef.current.some(
          (item) =>
            item.callId === targetCallId &&
            item.candidate?.candidate === payload.candidate?.candidate &&
            item.candidate?.sdpMid === payload.candidate?.sdpMid &&
            item.candidate?.sdpMLineIndex === payload.candidate?.sdpMLineIndex,
        )

        if (!alreadyQueued) {
          console.warn('[CALL DEBUG] ICE candidate queued', { callId: targetCallId })
          pendingIceCandidatesRef.current.push({
            callId: targetCallId,
            candidate: payload.candidate,
          })
        }
      }
    }

    const handleError = (payload) => {
      console.error('[CALL DEBUG] received call:error', payload)
      const message = payload?.message || 'Không thể thực hiện cuộc gọi.'
      resetCallState(message, { preserveError: true })
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

  const flushPendingIceCandidates = async (peer, callId = callState.callId) => {
    if (!peer || !pendingIceCandidatesRef.current.length) return
    const queuedForCall = pendingIceCandidatesRef.current.filter((entry) => entry.callId === callId)
    if (!queuedForCall.length) return

    const remaining = pendingIceCandidatesRef.current.filter((entry) => entry.callId !== callId)
    pendingIceCandidatesRef.current = remaining

    for (const entry of queuedForCall) {
      try {
        if (!entry?.candidate) continue
        await peer.addIceCandidate(new RTCIceCandidate(entry.candidate))
      } catch (candidateError) {
        console.warn('Failed to flush queued ICE candidate', candidateError)
      }
    }
  }

  const resetCallState = (nextError = '', options = {}) => {
    const preserveError = typeof nextError === 'object' ? Boolean(nextError.preserveError) : Boolean(options?.preserveError)
    const message = typeof nextError === 'string' ? nextError : options?.message || ''

    console.warn('[CALL DEBUG] resetCallState', {
      message,
      preserveError,
      callState,
    })

    setError(preserveError ? message : '')
    pendingIceCandidatesRef.current = []
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop())
      remoteStreamRef.current = null
    }
    setLocalStream(null)
    setRemoteStream(null)
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
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

  const createPeerConnection = (targetUserId, callIdOverride = callState.callId) => {
    const activeCallId = callIdOverride || callState.callId

    if (peerRef.current && peerRef.current.__callId === activeCallId) {
      console.log('[CALL DEBUG] reuse existing peer connection', {
        callId: activeCallId,
        targetUserId,
      })
      return peerRef.current
    }

    if (peerRef.current) {
      console.log('[CALL DEBUG] closing stale peer before new peer', {
        staleCallId: peerRef.current.__callId,
        newCallId: activeCallId,
      })
      peerRef.current.close()
      peerRef.current = null
    }

    const peer = new RTCPeerConnection({ iceServers: STUN_SERVERS })
    peer.__callId = activeCallId
    peerRef.current = peer

    console.log('[CALL DEBUG] peer connection created', {
      targetUserId,
      callId: activeCallId,
      hasLocalStream: !!mediaStreamRef.current,
    })

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        const senderAlreadyExists = peer.getSenders().some((sender) => sender.track && sender.track.id === track.id)
        if (senderAlreadyExists) {
          console.log('[CALL DEBUG] local track already attached', { kind: track.kind, id: track.id, callId: activeCallId })
          return
        }
        console.log('[CALL DEBUG] local track added', { kind: track.kind, id: track.id, enabled: track.enabled, callId: activeCallId })
        peer.addTrack(track, mediaStreamRef.current)
      })
    }

    peer.ontrack = (event) => {
      console.log('[CALL DEBUG] ontrack received', {
        kind: event.track?.kind,
        trackId: event.track?.id,
        readyState: event.track?.readyState,
        enabled: event.track?.enabled,
        streams: event.streams?.map((stream) => stream.id),
      })

      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream()
      }

      if (event.track && !remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track)
        console.log('[CALL DEBUG] remote track added', {
          kind: event.track.kind,
          trackId: event.track.id,
          audioTracks: remoteStreamRef.current.getAudioTracks().length,
          videoTracks: remoteStreamRef.current.getVideoTracks().length,
        })
      }

      setRemoteStream(remoteStreamRef.current)

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current
        remoteVideoRef.current.autoplay = true
        remoteVideoRef.current.playsInline = true
        remoteVideoRef.current.play().catch((playError) => {
          console.warn('[CALL DEBUG] remote video play failed', playError)
        })
      }

      console.log('[CALL DEBUG] remote stream attached', {
        streamId: remoteStreamRef.current.id,
        audioTracks: remoteStreamRef.current.getAudioTracks().length,
        videoTracks: remoteStreamRef.current.getVideoTracks().length,
        videoElementExists: !!remoteVideoRef.current,
        videoReadyState: remoteVideoRef.current?.readyState,
        videoWidth: remoteVideoRef.current?.videoWidth,
        videoHeight: remoteVideoRef.current?.videoHeight,
      })
    }

    peer.onicecandidate = (event) => {
      if (!event.candidate || !socket) return
      const candidateCallId = callIdOverride || callState.callId
      console.log('[CALL DEBUG] ICE candidate local', {
        callId: candidateCallId,
        targetUserId,
        candidate: event.candidate.candidate?.slice(0, 80),
      })
      socket.emit('call:ice-candidate', {
        callId: candidateCallId,
        targetUserId,
        candidate: event.candidate.toJSON(),
      })
    }

    peer.onconnectionstatechange = () => {
      console.log('[CALL DEBUG] connectionState', {
        callId: activeCallId,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
      })
      if (peer.connectionState === 'connected') {
        setCallState((current) => ({ ...current, status: 'connected' }))
        setError('')
      }
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        setError('Kết nối cuộc gọi bị mất.')
      }
    }

    return peer
  }

  const ensureLocalMedia = async (callType) => {
    console.log('[CALL DEBUG] getUserMedia start', { callType, hasNavigatorMediaDevices: !!navigator.mediaDevices, socketConnected: socket?.connected })
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error('[CALL DEBUG] getUserMedia failed', { reason: 'unsupported', callType })
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
      console.log('[CALL DEBUG] getUserMedia success', {
        hasStream: !!stream,
        callType,
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
      })
      console.log('[CALL DEBUG] ensureLocalMedia result', {
        hasStream: !!stream,
        callType,
      })
      return stream
    } catch (mediaError) {
      console.error('[CALL DEBUG] getUserMedia failed', { callType, error: mediaError?.message || String(mediaError) })
      setError('Không thể truy cập mic/camera. Vui lòng cấp quyền và thử lại.')
      return null
    }
  }

  const startCall = async (targetUserId, callType = 'audio') => {
    console.log('[CALL DEBUG] startCall', {
      targetUserId,
      callType,
      currentUserId,
      socketConnected: socket?.connected,
    })

    if (!socket || !targetUserId) {
      console.warn('[CALL DEBUG] startCall blocked', { hasSocket: !!socket, targetUserId, socketConnected: socket?.connected })
      return
    }
    const stream = await ensureLocalMedia(callType)
    console.log('[CALL DEBUG] ensureLocalMedia result', {
      hasStream: !!stream,
      callType,
    })
    if (!stream) return
    callIsInitiatorRef.current = true
    setCallState({ status: 'connecting', callType, remoteUserId: Number(targetUserId), callId: null, incoming: false })
    console.log('[CALL DEBUG] emitting call:start', {
      targetUserId: Number(targetUserId),
      callType,
      socketConnected: socket?.connected,
    })
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
  const remoteUserName = callState.remoteUserId
    ? (callList.find((friend) => Number(friend.otherUserId) === Number(callState.remoteUserId))?.full_name
      || callList.find((friend) => Number(friend.otherUserId) === Number(callState.remoteUserId))?.username
      || `User ${callState.remoteUserId}`)
    : 'Đang kết nối'

  const statusLabel = callState.status === 'ringing'
    ? 'Calling...'
    : callState.status === 'connecting'
      ? 'Connecting...'
      : callState.status === 'connected'
        ? 'Connected'
        : callState.status === 'idle'
          ? 'Sẵn sàng'
          : callState.status

  return (
    <ModuleScaffold icon="◉" title="Cuộc gọi" description="Gọi thoại và video trực tiếp qua Socket.IO + WebRTC.">
      <div className="module-call-shell">
        <div className="module-call-header">
          <strong>Danh sách bạn bè</strong>
          <span>{statusLabel}</span>
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
                <div className="module-call-avatar">{String(remoteUserName || 'U').slice(0, 1).toUpperCase()}</div>
                <strong>{remoteUserName}</strong>
                <span>{callState.status === 'connected' ? formatDuration(duration) : statusLabel}</span>
              </div>
            )}
            <div className="module-call-actions">
              {!callState.incoming && callState.status !== 'ringing' && (
                <button type="button" className="module-call-button" onClick={toggleMute}>{isMuted ? 'Mic off' : 'Mic on'}</button>
              )}
              {callState.callType === 'video' && callState.status !== 'ringing' && (
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
