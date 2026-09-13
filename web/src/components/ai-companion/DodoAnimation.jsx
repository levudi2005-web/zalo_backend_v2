import { dodoAssets } from '../../assets/mascot/dodo'
import './DodoCompanion.css'

export function DodoAnimation({ state, flip = false }) {
  const className = `dodo-art dodo-art-${state}${flip ? ' dodo-art-flipped' : ''}`

  if (dodoAssets.base) {
    return (
      <img
        className={className}
        src={dodoAssets.base}
        alt="Dodo"
      />
    )
  }

  return <span className={className} aria-hidden="true">🐧</span>
}
