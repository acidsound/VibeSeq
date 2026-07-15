import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Keeps keyboard focus inside a mounted modal and restores it on close. */
export function useModalFocus<T extends HTMLElement>() {
  const dialogRef = useRef<T>(null)
  const returnTargetRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const returnTarget = returnTargetRef.current
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
      if (element.hidden || element.closest('[aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    })
    const initial = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0]
    window.requestAnimationFrame(() => initial?.focus())

    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) { event.preventDefault(); dialog.focus(); return }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', trap)
    return () => {
      dialog.removeEventListener('keydown', trap)
      window.requestAnimationFrame(() => returnTarget?.focus())
    }
  }, [])

  return dialogRef
}
