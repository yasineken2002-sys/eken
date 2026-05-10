import { Component, type ErrorInfo, type ReactNode } from 'react'
import * as Sentry from '@sentry/react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from './ui/Button'

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
      <div className="flex min-h-screen items-center justify-center bg-[#F7F8FA] px-4">
        <div className="w-full max-w-lg rounded-2xl border border-[#EAEDF0] bg-white p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle className="h-6 w-6 text-red-600" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">
                Något gick fel
              </h1>
              <p className="mt-1 text-[13.5px] text-gray-600">
                Ett oväntat fel har inträffat. Försök ladda om sidan eller gå tillbaka till
                översikten.
              </p>
            </div>
          </div>

          {isDev && this.state.error && (
            <details className="mt-5 rounded-lg border border-[#EAEDF0] bg-gray-50 p-3 text-[12px]">
              <summary className="cursor-pointer font-medium text-gray-700">Detaljer (dev)</summary>
              <div className="mt-2 space-y-2 font-mono text-[11px] text-gray-700">
                <div>
                  <div className="font-semibold text-red-600">{this.state.error.name}</div>
                  <div>{this.state.error.message}</div>
                </div>
                {this.state.error.stack && (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-gray-500">
                    {this.state.error.stack}
                  </pre>
                )}
                {this.state.errorInfo?.componentStack && (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-gray-500">
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </div>
            </details>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={this.handleReload}>
              <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
              Ladda om sidan
            </Button>
            <Button variant="secondary" onClick={this.handleGoHome}>
              <Home className="h-4 w-4" strokeWidth={1.8} />
              Tillbaka till dashboard
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
