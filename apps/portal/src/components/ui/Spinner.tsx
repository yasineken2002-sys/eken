import styles from './ui.module.css'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  label?: string
}

export function Spinner({ size = 'md', label }: SpinnerProps) {
  return (
    <div className={styles.spinnerWrap}>
      <div className={`${styles.spinner} ${styles[`spinner_${size}`]}`} />
      {label && <p className={styles.spinnerLabel}>{label}</p>}
    </div>
  )
}
