import { useEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useFocusTrap } from './useFocusTrap'

// Liten lokal className-hjälpare — undviker beroende på appens cn()/clsx.
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  /** Web-API: underrubrik i headern. */
  description?: string
  children: ReactNode
  /** Admin-API: footer via prop. (Web lägger istället <ModalFooter> i children.) */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}

const SIZES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[440px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-5xl',
  full: 'max-w-7xl',
}

/**
 * Delad, tillgänglig Modal (web + admin). Konsoliderar de två divergerande
 * app-kopiorna till EN källa och lägger till WCAG-fixarna som saknades:
 * role="dialog" + aria-modal + aria-labelledby (+ aria-describedby), focus-trap,
 * Escape, aria-label på stängknappen, fokus-återställning vid stängning.
 *
 * Utseende följer CLAUDE.md:s designsystem-spec (bg-black/25 + blur, rounded-2xl,
 * border-line, spring). Klasserna genereras av web/admins Tailwind — deras config
 * scannar packages/ui/src (content-glob). Portalen använder INTE denna komponent
 * (ingen Tailwind) — den delar bara useFocusTrap-hooken.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const titleId = useId()
  const descId = useId()
  const trapRef = useFocusTrap<HTMLDivElement>(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className={cx(
              'border-line relative flex max-h-[calc(100vh-80px)] w-full flex-col overflow-hidden rounded-2xl border bg-white shadow-xl outline-none',
              SIZES[size],
            )}
          >
            <div className="border-line flex flex-shrink-0 items-start justify-between border-b px-5 pb-4 pt-4">
              <div className="pr-4">
                <h2 id={titleId} className="text-[17px] font-semibold leading-tight text-gray-900">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="mt-1 text-[13px] text-gray-500">
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Stäng"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

            {footer && (
              <div className="border-line flex flex-shrink-0 justify-end gap-2 border-t px-5 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/** Web-API: footer-rad placerad inuti <Modal>-children. */
export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'border-line mt-5 flex items-center justify-end gap-2 border-t pt-4',
        className,
      )}
    >
      {children}
    </div>
  )
}
