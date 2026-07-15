import { Copy, FilePenLine, Music2, Repeat2, Scissors, Trash2, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ClipKind } from '../types'

type MenuPoint = { x: number; y: number }

type ClipCommandMenuProps = {
  anchor: MenuPoint
  clipKind: ClipKind
  clipName: string
  clipMuted: boolean
  sourceLoopEnabled: boolean
  splitLabel: string
  canSplit: boolean
  inferenceBusy: boolean
  onOpenDetail: () => void
  onSplit: () => void
  onDuplicate: () => void
  onToggleMute: () => void
  onToggleSourceLoop: () => void
  onExtractMidi: () => void
  onDelete: () => void
  onClose: () => void
}

type Command = {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
  icon: React.ReactNode
  run: () => void
}

export function ClipCommandMenu({
  anchor,
  clipKind,
  clipName,
  clipMuted,
  sourceLoopEnabled,
  splitLabel,
  canSplit,
  inferenceBusy,
  onOpenDetail,
  onSplit,
  onDuplicate,
  onToggleMute,
  onToggleSourceLoop,
  onExtractMidi,
  onDelete,
  onClose,
}: ClipCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const menu = menuRef.current
    const first = menu?.querySelector<HTMLButtonElement>('button:not([disabled])')
    window.requestAnimationFrame(() => first?.focus())
  }, [])

  const run = (action: () => void) => {
    action()
    onClose()
  }

  const commands: Command[] = [
    { id: 'open-detail', label: 'Open detail editor', icon: <FilePenLine />, run: onOpenDetail },
    { id: 'split', label: `Split at ${splitLabel}`, disabled: !canSplit, icon: <Scissors />, run: onSplit },
    { id: 'duplicate', label: 'Duplicate after region', icon: <Copy />, run: onDuplicate },
    {
      id: 'clip-mute',
      label: clipMuted ? 'Unmute region' : 'Mute region',
      hint: clipMuted ? 'Restore playback + export' : 'Exclude from playback + export',
      icon: clipMuted ? <Volume2 /> : <VolumeX />,
      run: onToggleMute,
    },
    {
      id: 'clip-source-loop',
      label: sourceLoopEnabled ? 'Disable clip loop' : 'Enable clip loop',
      hint: 'Source repeat · not project cycle',
      icon: <Repeat2 />,
      run: onToggleSourceLoop,
    },
    ...(clipKind === 'audio' ? [{
      id: 'extract-midi',
      label: inferenceBusy ? 'Inference engine busy' : 'Extract editable MIDI',
      disabled: inferenceBusy,
      icon: <Music2 />,
      run: onExtractMidi,
    }] : []),
    { id: 'delete', label: 'Delete region', danger: true, icon: <Trash2 />, run: onDelete },
  ]

  return (
    <div className="clip-command-backdrop" onPointerDown={onClose}>
      <div
        ref={menuRef}
        className="clip-command-menu"
        role="menu"
        aria-label={`Commands for ${clipName}`}
        style={{ '--menu-x': `${anchor.x}px`, '--menu-y': `${anchor.y}px` } as React.CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
          if (buttons.length === 0) return
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : event.key === 'ArrowDown'
                ? (current + 1 + buttons.length) % buttons.length
                : (current - 1 + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}
      >
        <p><b>{clipName}</b><span>{clipKind.toUpperCase()} REGION</span></p>
        {commands.map((command) => (
          <button
            key={command.id}
            role="menuitem"
            data-command-id={command.id}
            className={command.danger ? 'is-danger' : undefined}
            disabled={command.disabled}
            onClick={() => run(command.run)}
          >
            {command.icon}
            <span><b>{command.label}</b>{command.hint && <small>{command.hint}</small>}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
