import { useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'

type TrackPropertiesControlsProps = {
  trackId: string
  trackName: string
  description: string
  onRename: (name: string) => void
  onDelete: () => void
}

export function TrackPropertiesControls({ trackId, trackName, description, onRename, onDelete }: TrackPropertiesControlsProps) {
  const [nameDraft, setNameDraft] = useState(trackName)
  const [editing, setEditing] = useState(false)
  const cancelBlurRef = useRef(false)

  useEffect(() => {
    setNameDraft(trackName)
    cancelBlurRef.current = false
    setEditing(false)
  }, [trackId, trackName])

  const commitName = (rawName: string) => {
    const nextName = rawName.trim()
    if (!nextName) {
      setNameDraft(trackName)
      setEditing(false)
      return
    }
    setNameDraft(nextName)
    setEditing(false)
    if (nextName === trackName) return
    onRename(nextName)
  }

  return (
    <div className="track-properties-inline">
      <div className="track-properties-copy">
        {editing ? (
        <input
          type="text"
          autoFocus
          value={nameDraft}
          aria-label="Track name"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={(event) => {
            if (cancelBlurRef.current) {
              cancelBlurRef.current = false
              return
            }
            commitName(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              cancelBlurRef.current = true
              commitName(event.currentTarget.value)
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelBlurRef.current = true
              setNameDraft(trackName)
              setEditing(false)
              event.currentTarget.blur()
            }
          }}
        />
        ) : <><h2>{trackName}</h2><p>{description}</p></>}
      </div>
      <div className="track-properties-actions" aria-label="Track edit actions">
        <button type="button" aria-label={`Edit ${trackName} track name`} title="Edit track name" aria-pressed={editing} disabled={editing} onClick={() => { cancelBlurRef.current = false; setNameDraft(trackName); setEditing(true) }}><Pencil /></button>
        <button type="button" className="delete-track-action" aria-label={`Delete ${trackName} track`} title="Delete track" onClick={onDelete}><Trash2 /></button>
      </div>
    </div>
  )
}
