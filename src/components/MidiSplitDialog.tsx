import { ArrowRight, Scissors, Split, X } from 'lucide-react'
import type { MidiCrossingNotePolicy } from '../core'
import { useModalFocus } from '../hooks/useModalFocus'

type MidiSplitDialogProps = {
  affectedNotes: number
  positionLabel: string
  onlyKeep?: boolean
  onChoose: (policy: MidiCrossingNotePolicy) => void
  onClose: () => void
}

const outcomes: Array<{
  policy: MidiCrossingNotePolicy
  title: string
  description: string
}> = [
  {
    policy: 'keep',
    title: 'Keep on left',
    description: 'Keep each complete crossing note in the left region.',
  },
  {
    policy: 'shorten',
    title: 'Shorten at cut',
    description: 'End each crossing note at the split with no continuation.',
  },
  {
    policy: 'split',
    title: 'Split notes',
    description: 'End the left note and continue its remaining duration in the right region.',
  },
]

export function MidiSplitDialog({
  affectedNotes,
  positionLabel,
  onlyKeep = false,
  onChoose,
  onClose,
}: MidiSplitDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>()

  return (
    <div className="modal-backdrop midi-split-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="dialog midi-split-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="midi-split-dialog-title"
        aria-describedby="midi-split-dialog-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          const shortcutIndex = Number(event.key) - 1
          const shortcut = outcomes[shortcutIndex]
          if (!shortcut || (onlyKeep && shortcut.policy !== 'keep')) return
          event.preventDefault()
          onChoose(shortcut.policy)
        }}
      >
        <header>
          <div>
            <p className="eyebrow">MIDI REGION · {positionLabel}</p>
            <h2 id="midi-split-dialog-title">Notes cross this split</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Cancel MIDI split"><X /></button>
        </header>
        <p id="midi-split-dialog-description">
          {affectedNotes} {affectedNotes === 1 ? 'note crosses' : 'notes cross'} the cut. Choose how the musical tail should behave before VibeSeq changes the project.
        </p>
        <div className="midi-split-choices">
          {outcomes.map((outcome, index) => (
            <button
              key={outcome.policy}
              autoFocus={index === 0}
              disabled={onlyKeep && outcome.policy !== 'keep'}
              onClick={() => onChoose(outcome.policy)}
              data-split-policy={outcome.policy}
            >
              <span>{outcome.policy === 'split' ? <Split /> : outcome.policy === 'shorten' ? <Scissors /> : <ArrowRight />}</span>
              <div><b>{outcome.title}</b><small>{outcome.description}</small></div>
              <kbd>{index + 1}</kbd>
            </button>
          ))}
        </div>
        {onlyKeep && <p className="midi-split-constraint">This region repeats one shared MIDI source. Shorten and Split would change every repeat; flatten the clip loop first to enable those outcomes.</p>}
        <p className="midi-split-note">Cancel leaves the region, notes, selection, and Undo history unchanged.</p>
      </section>
    </div>
  )
}
