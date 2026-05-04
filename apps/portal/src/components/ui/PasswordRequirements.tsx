import { passwordChecks } from '@eken/shared'
import styles from './PasswordRequirements.module.css'

interface Props {
  password: string
}

export function PasswordRequirements({ password }: Props) {
  const checks = passwordChecks(password)
  return (
    <ul className={styles.list} aria-label="Lösenordskrav">
      {checks.map((c) => (
        <li key={c.key} className={c.passed ? `${styles.item} ${styles.passed}` : styles.item}>
          <span className={styles.icon} aria-hidden="true">
            {c.passed ? '✓' : '○'}
          </span>
          <span>{c.label}</span>
        </li>
      ))}
    </ul>
  )
}
