import { Component, type ErrorInfo, type ReactNode } from 'react'
import * as Sentry from '@sentry/react'
import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })
    Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    })
    console.error('[ErrorBoundary]', error, errorInfo)
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    if (!this.state.error) return this.props.children

    const isDev = import.meta.env.DEV

    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.iconBubble} aria-hidden>
              ⚠️
            </div>
            <div>
              <h1 className={styles.title}>Något gick fel</h1>
              <p className={styles.subtitle}>
                Ett oväntat fel har inträffat i portalen. Försök ladda om sidan eller gå tillbaka
                till översikten.
              </p>
            </div>
          </div>

          {isDev && this.state.error && (
            <details className={styles.details}>
              <summary className={styles.detailsSummary}>Detaljer (dev)</summary>
              <div className={styles.detailsBody}>
                <div>
                  <div className={styles.errorName}>{this.state.error.name}</div>
                  <div>{this.state.error.message}</div>
                </div>
                {this.state.error.stack && (
                  <pre className={styles.stack}>{this.state.error.stack}</pre>
                )}
                {this.state.errorInfo?.componentStack && (
                  <pre className={styles.stack}>{this.state.errorInfo.componentStack}</pre>
                )}
              </div>
            </details>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={this.handleReload}
            >
              Ladda om sidan
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={this.handleGoHome}
            >
              Tillbaka till översikten
            </button>
          </div>
        </div>
      </div>
    )
  }
}
