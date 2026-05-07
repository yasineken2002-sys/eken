import { forwardRef, useState } from 'react'
import styles from './PasswordInput.module.css'

/**
 * Lösenordsinput med visa/dölj-toggle. Default type="password" (säker default);
 * öga-knappen byter till type="text" och tillbaka. När lösenordet är synligt
 * får fältet en svag blå-tonad bakgrund som visuell signal till användaren
 * att det inte längre är dolt.
 *
 * Drop-in kompatibel med <input> — tar emot ref + alla input-attribut. Inga
 * externa ikon-bibliotek används; SVG:erna är inlineade.
 */
type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>

export const PasswordInput = forwardRef<HTMLInputElement, Props>(({ className, ...props }, ref) => {
  const [visible, setVisible] = useState(false)
  return (
    <div className={styles.wrap}>
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={[styles.input, visible ? styles.visible : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Dölj lösenord' : 'Visa lösenord'}
        className={styles.toggle}
        tabIndex={0}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
})
PasswordInput.displayName = 'PasswordInput'

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2 10s2.5-5 8-5 8 5 8 5-2.5 5-8 5-8-5-8-5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 3l14 14M9.5 5.1A8 8 0 0 1 10 5c5.5 0 8 5 8 5a14.4 14.4 0 0 1-2.6 3.3M6.6 6.6A14.7 14.7 0 0 0 2 10s2.5 5 8 5a8 8 0 0 0 3.4-.7M11.7 11.7a2.5 2.5 0 0 1-3.4-3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
