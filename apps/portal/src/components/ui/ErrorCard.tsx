import styles from './ui.module.css'

interface ErrorCardProps {
  message?: string
  /**
   * Sätt ENBART för sidor/funktioner som ännu inte är byggda. Använd INTE
   * vid vanliga API-fel (500, nätverk) — då ska felmeddelande + "Försök
   * igen"-knapp visas, annars ser en fungerande sida ut som permanent obyggd.
   */
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
