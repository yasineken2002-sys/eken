import { useEffect, useRef } from 'react'

/**
 * Framework-agnostisk focus-trap för dialoger/modaler (WCAG 2.1 — 2.4.3 Focus Order,
 * 2.1.2 No Keyboard Trap i "rätt" mening: fokus hålls INOM dialogen men Escape/stäng
 * släpper ut). Ren React, INGA beroenden → kan användas av portalen (CSS Modules,
 * ingen Tailwind/framer) likaväl som web/admin.
 *
 * Beteende när `active` blir true:
 *  1. Sparar elementet som hade fokus (för återställning).
 *  2. Flyttar fokus till första fokuserbara elementet i containern (annars containern).
 *  3. Cyklar Tab/Shift+Tab inom containern.
 * När `active` blir false (eller unmount): återställer fokus till (1).
 *
 * Användning:
 *   const ref = useFocusTrap<HTMLDivElement>(open)
 *   return <div ref={ref} role="dialog" aria-modal="true">…</div>
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const SELECTOR =
      'a[href],area[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    const focusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(SELECTOR)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      )

    // Flytta in fokus.
    const first = focusable()[0]
    ;(first ?? node).focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const firstEl = items[0]!
      const lastEl = items[items.length - 1]!
      const activeEl = document.activeElement
      if (e.shiftKey && (activeEl === firstEl || activeEl === node)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      // Återställ fokus dit det var (om elementet finns kvar).
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus()
    }
  }, [active])

  return ref
}
