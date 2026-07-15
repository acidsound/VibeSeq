import { AudioLines, Music2, Plus } from 'lucide-react'
import type { TrackKind } from '../types'

type AddTrackButtonsProps = {
  onAddTrack: (kind: TrackKind) => void
}

export function AddTrackButtons({ onAddTrack }: AddTrackButtonsProps) {
  return (
    <div className="add-track-buttons" role="group" aria-label="Add a track">
      <button
        type="button"
        className="add-track-button add-track-audio"
        aria-label="Add audio track"
        title="Add audio track"
        onClick={() => onAddTrack('audio')}
      >
        <Plus className="add-track-plus-icon" aria-hidden="true" />
        <AudioLines className="add-track-kind-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="add-track-button add-track-midi"
        aria-label="Add MIDI track"
        title="Add MIDI track"
        onClick={() => onAddTrack('midi')}
      >
        <Plus className="add-track-plus-icon" aria-hidden="true" />
        <Music2 className="add-track-kind-icon" aria-hidden="true" />
      </button>
    </div>
  )
}
