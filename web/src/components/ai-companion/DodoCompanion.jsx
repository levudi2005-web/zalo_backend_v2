import { useEffect, useRef, useState } from 'react'
import { DODO_CONFIG } from '../../assets/mascot/dodo/config/dodo.config'
import { getDodoMessage } from '../../assets/mascot/dodo/config/dodo.messages'
import { DODO_STATES } from '../../assets/mascot/dodo/config/dodoStates'
import { DodoAnimation } from './DodoAnimation'
import { DodoBubble } from './DodoBubble'
import './DodoCompanion.css'

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function getInitialPosition() {
  return {
    x: 86,
    y: window.innerWidth <= 767 ? 62 : 82,
  }
}

export function DodoCompanion({ aiProcessing, onOpen }) {
  const [state, setState] = useState(DODO_STATES.IDLE)
  const [position, setPosition] = useState(getInitialPosition)
  const [flip, setFlip] = useState(false)
  const [bubble, setBubble] = useState('')
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [movementRestart, setMovementRestart] = useState(0)
  const positionRef = useRef(position)
  const stageRef = useRef(null)
  const wasProcessing = useRef(false)
  const bubbleTimeout = useRef(null)
  const movementTimeout = useRef(null)
  const bubbleCooldown = useRef(null)
  const interactionTimeout = useRef(null)
  const dragRef = useRef({ pointerId: null, moved: false, active: false })
  const suppressClick = useRef(false)

  const showBubble = (category, force = false) => {
    if (!force && bubbleCooldown.current) return

    setBubble(getDodoMessage(category))
    window.clearTimeout(bubbleTimeout.current)
    bubbleTimeout.current = window.setTimeout(() => setBubble(''), DODO_CONFIG.bubble.duration)

    if (!force) {
      bubbleCooldown.current = window.setTimeout(() => {
        bubbleCooldown.current = null
      }, randomBetween(DODO_CONFIG.bubble.minCooldown, DODO_CONFIG.bubble.maxCooldown))
    }
  }

  useEffect(() => {
    if (aiProcessing) {
      wasProcessing.current = true
      setState(DODO_STATES.THINKING)
      showBubble('thinking', true)
      return undefined
    }

    if (wasProcessing.current) {
      wasProcessing.current = false
      setState(DODO_STATES.HAPPY)
      showBubble('happy', true)
      const talkingTimeout = window.setTimeout(() => setState(DODO_STATES.IDLE), 1000)
      return () => window.clearTimeout(talkingTimeout)
    }

    return undefined
  }, [aiProcessing])

  useEffect(() => {
    if (aiProcessing) return undefined

    const idleMessageTimeout = window.setTimeout(() => {
      showBubble('idle')
    }, randomBetween(DODO_CONFIG.movement.minIdleTime, DODO_CONFIG.movement.maxIdleTime))

    return () => window.clearTimeout(idleMessageTimeout)
  }, [aiProcessing, state])

  useEffect(() => {
    let cancelled = false

    const scheduleMovement = () => {
      const delay = randomBetween(
        DODO_CONFIG.movement.minIdleTime,
        DODO_CONFIG.movement.maxIdleTime,
      )

      movementTimeout.current = window.setTimeout(() => {
        if (cancelled) {
          return
        }

        if (aiProcessing) {
          scheduleMovement()
          return
        }

        const nextX = randomBetween(20, 80)
        const nextY = randomBetween(
          12,
          window.innerWidth <= 767 ? 62 : 88,
        )
        setFlip(nextX < positionRef.current.x)
        positionRef.current = { x: nextX, y: nextY }
        setPosition(positionRef.current)
        setState(DODO_STATES.WALKING)

        movementTimeout.current = window.setTimeout(() => {
          if (!cancelled && !aiProcessing) setState(DODO_STATES.IDLE)
          scheduleMovement()
        }, randomBetween(DODO_CONFIG.movement.minWalkTime, DODO_CONFIG.movement.maxWalkTime))
      }, delay)
    }

    scheduleMovement()

    return () => {
      cancelled = true
      window.clearTimeout(movementTimeout.current)
    }
  }, [aiProcessing, movementRestart])

  useEffect(() => () => {
    window.clearTimeout(bubbleTimeout.current)
    window.clearTimeout(bubbleCooldown.current)
    window.clearTimeout(movementTimeout.current)
    window.clearTimeout(interactionTimeout.current)
  }, [])

  const handleClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }

    window.clearTimeout(interactionTimeout.current)
    setState(DODO_STATES.LISTENING)
    showBubble('click', true)
    onOpen?.({ x: position.x, y: position.y })
    interactionTimeout.current = window.setTimeout(() => setState(DODO_STATES.IDLE), 900)
  }

  const handlePointerDown = (event) => {
    if (aiProcessing) return
    if (event.pointerType === 'mouse') return

    window.clearTimeout(movementTimeout.current)
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, moved: false, active: true }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    setDragging(true)
    setState(DODO_STATES.SURPRISED)
    showBubble('angry', true)
  }

  const handleMouseDown = (event) => {
    if (aiProcessing || event.button !== 0) return

    window.clearTimeout(movementTimeout.current)
    dragRef.current = { pointerId: 'mouse', moved: false, active: true }
    document.addEventListener('mousemove', handlePointerMove, true)
    document.addEventListener('mouseup', handlePointerUp, true)
    setDragging(true)
    setState(DODO_STATES.SURPRISED)
    showBubble('angry', true)
  }

  const handlePointerMove = (event) => {
    if (!dragRef.current.active) return
    if (event.type !== 'mousemove' && dragRef.current.pointerId !== event.pointerId) return

    const stage = stageRef.current
    if (!stage) return

    const bounds = stage.getBoundingClientRect()
    const nextX = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100))
    const nextY = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100))
    const previousX = positionRef.current.x

    dragRef.current.moved = true
    positionRef.current = { x: nextX, y: nextY }
    setFlip(nextX < previousX)
    setPosition(positionRef.current)
  }

  const handlePointerUp = (event) => {
    if (!dragRef.current.active) return
    if (event.type !== 'mouseup' && dragRef.current.pointerId !== event.pointerId) return

    if (dragRef.current.moved) {
      suppressClick.current = true
      setState(DODO_STATES.ANGRY)
      showBubble('dragged', true)
      interactionTimeout.current = window.setTimeout(() => {
        setState(DODO_STATES.HAPPY)
        interactionTimeout.current = window.setTimeout(() => setState(DODO_STATES.IDLE), 800)
      }, 700)
    } else {
      setState(DODO_STATES.IDLE)
    }

    dragRef.current.pointerId = null
    dragRef.current.active = false
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    document.removeEventListener('mousemove', handlePointerMove, true)
    document.removeEventListener('mouseup', handlePointerUp, true)
    setDragging(false)
    setMovementRestart((value) => value + 1)
  }

  const handleDoubleClick = () => {
    window.clearTimeout(interactionTimeout.current)
    setState(DODO_STATES.EXCITED)
    showBubble('happy', true)
    interactionTimeout.current = window.setTimeout(() => setState(DODO_STATES.IDLE), 1200)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleClick()
    }
  }

  useEffect(() => () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    document.removeEventListener('mousemove', handlePointerMove, true)
    document.removeEventListener('mouseup', handlePointerUp, true)
  }, [dragging])

  return (
    <aside className="dodo-companion" aria-label="Dodo">
      <div className="dodo-stage" ref={stageRef}>
        <DodoBubble
          style={{
            left: `${position.x}%`,
            top: `calc(${position.y}% - 70px)`,
          }}
        >
          {bubble}
        </DodoBubble>
        <button
          className={`dodo-character${state === DODO_STATES.WALKING ? ' is-walking' : ''}${hovered ? ' is-hovered' : ''}${dragging ? ' is-dragging' : ''}`}
          style={{
            left: `${position.x}%`,
            top: `${position.y}%`,
            transform: 'translate3d(-50%, -50%, 0)',
          }}
          type="button"
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseDown={handleMouseDown}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          aria-label="Dodo"
        >
          <DodoAnimation state={state} flip={flip} />
        </button>
      </div>
    </aside>
  )
}
