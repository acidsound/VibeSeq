import { Trash2 } from 'lucide-react'
import { useModalFocus } from '../hooks/useModalFocus'
import type { ProjectSummary } from '../types'

interface ProjectDeleteDialogProps {
  summary: ProjectSummary
  current: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ProjectDeleteDialog({
  summary,
  current,
  busy,
  onCancel,
  onConfirm,
}: ProjectDeleteDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>()
  return <div className="modal-backdrop project-delete-backdrop" onMouseDown={onCancel}>
    <section ref={dialogRef} className="dialog project-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="eyebrow">DELETE LOCAL PROJECT</p><h2 id="project-delete-title">Delete “{summary.name}”?</h2></div><Trash2 /></header>
      <p id="project-delete-description">This permanently removes the arrangement, project candidates, job history, recovery journal, and embedded project media from this browser. Global Sound Library sounds are kept.{current ? ' A different project will open after deletion.' : ''}</p>
      <div className="project-delete-summary"><b>{summary.name}</b><span>{summary.trackCount} tracks · {summary.bpm.toFixed(1)} BPM</span></div>
      <div className="project-delete-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="delete-confirm" disabled={busy} onClick={onConfirm}>{busy ? 'Deleting…' : 'Delete project'}</button></div>
    </section>
  </div>
}
