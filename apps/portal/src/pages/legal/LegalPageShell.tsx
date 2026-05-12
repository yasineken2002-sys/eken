import { Link } from 'react-router-dom'
import { PLATFORM_COMPANY } from '@eken/shared'
import styles from './LegalPageShell.module.css'

export interface TocItem {
  id: string
  label: string
}

interface Props {
  title: string
  description: string
  version: string
  updatedAt: string
  toc: TocItem[]
  children: React.ReactNode
}

/**
 * Mobil-anpassad ram för juridiska sidor i hyresgästportalen. Lägger på
 * sidhuvud med tillbakaknapp + skriv-ut, innehållsförteckning och fotnot
 * med plattformens kontaktuppgifter. Tar bort allt skärm-chrome vid utskrift.
 */
export function LegalPageShell({ title, description, version, updatedAt, toc, children }: Props) {
  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        <div className={`${styles.topBar} ${styles.noPrint}`}>
          <Link to="/" className={styles.backLink}>
            ← Tillbaka
          </Link>
          <button type="button" onClick={() => window.print()} className={styles.printBtn}>
            Skriv ut
          </button>
        </div>

        <h1 className={styles.title}>{title}</h1>
        <p className={styles.description}>{description}</p>
        <div className={styles.meta}>
          <span>Version {version}</span>
          <span>Senast uppdaterad {updatedAt}</span>
          <span>{PLATFORM_COMPANY.legalName}</span>
        </div>

        <nav className={`${styles.toc} ${styles.noPrint}`}>
          <p className={styles.tocTitle}>Innehåll</p>
          <ul className={styles.tocList}>
            {toc.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>{item.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className={styles.content}>{children}</article>

        <footer className={`${styles.footer} ${styles.noPrint}`}>
          <p>
            © {new Date().getFullYear()} {PLATFORM_COMPANY.legalName} · org.nr{' '}
            {PLATFORM_COMPANY.orgNumber}
          </p>
          <p>
            {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
          </p>
          <p>
            Kontakt: <a href={`mailto:${PLATFORM_COMPANY.email}`}>{PLATFORM_COMPANY.email}</a> ·
            Dataskydd:{' '}
            <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
          </p>
        </footer>
      </div>
    </div>
  )
}
