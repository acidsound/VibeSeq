import { useEffect, useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'

type RegionPropertiesControlsProps = {
  regionId: string
  regionName: string
  description: string
  onRename: (name: string) => void
  onDelete: () => void
}

export function RegionPropertiesControls({ regionId, regionName, description, onRename, onDelete }: RegionPropertiesControlsProps) {
  const [nameDraft, setNameDraft] = useState(regionName)
  const [editing, setEditing] = useState(false)
  const cancelBlurRef = useRef(false)

  useEffect(() => {
    setNameDraft(regionName)
    cancelBlurRef.current = false
    setEditing(false)
  }, [regionId, regionName])

  const commitName = (rawName: string) => {
    const nextName = rawName.trim()
    if (!nextName) {
      setNameDraft(regionName)
      setEditing(false)
      return
    }
    setNameDraft(nextName)
    setEditing(false)
    if (nextName === regionName) return
    onRename(nextName)
  }

  return (
    <div className="region-properties-inline">
      <div className="region-properties-copy">
        {editing ? (
          <input
            type="text"
            autoFocus
            value={nameDraft}
            aria-label="Region name"
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
                setNameDraft(regionName)
                setEditing(false)
                event.currentTarget.blur()
              }
            }}
          />
        ) : <><h2>{regionName}</h2><p>{description}</p></>}
      </div>
      <div className="region-properties-actions" aria-label="Region edit actions">
        <button type="button" aria-label={`Edit ${regionName} region name`} title="Edit region name" aria-pressed={editing} disabled={editing} onClick={() => { cancelBlurRef.current = false; setNameDraft(regionName); setEditing(true) }}><Pencil /></button>
        <button type="button" className="delete-region-action" aria-label={`Delete ${regionName} region`} title="Delete region" onClick={onDelete}><Trash2 /></button>
      </div>
    </div>
  )
}
