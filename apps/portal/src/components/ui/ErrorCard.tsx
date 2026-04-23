import styles from './ui.module.css'

interface ErrorCardProps {
  message?: string
  isUnderConstruction?: boolean
  onRetry?: () => void
}

export function ErrorCard({ message, isUnderConstruction, onRetry }: ErrorCardProps) {
  if (isUnderConstruction) {
    return (
      <div className={styles.errorCard}>
        <div className={styles.errorIcon}>🔧</div>
        <p className={styles.errorTitle}>Funktionen är under uppbyggnad</p>
        <p className={styles.errorText}>
          Den här sidan är inte tillgänglig än. Försök igen senare.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.errorCard}>
      <div className={styles.errorIcon}>⚠️</div>
      <p className={styles.errorTitle}>{message ?? 'Något gick fel'}</p>
      <p className={styles.errorText}>Kunde inte ladda information.</p>
      {onRetry && (
        <button className={styles.retryButton} onClick={onRetry}>
          Försök igen
        </button>
      )}
    </div>
  )
}
