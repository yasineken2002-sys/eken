import { Component, type ReactNode } from 'react'
import axios from 'axios'

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    void axios
      .post('/api/v1/platform/errors/report', {
        severity: 'ERROR',
        source: 'ADMIN',
        message: error.message,
        stack: error.stack,
        context: { componentStack: info.componentStack, path: window.location.pathname },
      })
      .catch(() => undefined)
  }

  private reset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F7F8FA] p-6">
          <div className="max-w-lg rounded-2xl border border-[#EAEDF0] bg-white p-8 shadow-sm">
            <h1 className="text-[20px] font-semibold text-gray-900">Något gick fel</h1>
            <p className="mt-2 text-[13.5px] text-gray-600">
              Felet har rapporterats. Försök ladda om sidan.
            </p>
            <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-gray-50 p-3 text-[12px] text-gray-700">
              {this.state.error?.message}
            </pre>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => {
                  this.reset()
                  window.location.reload()
                }}
                className="h-9 rounded-lg bg-blue-600 px-4 text-[13.5px] font-medium text-white hover:bg-blue-700"
              >
                Ladda om
              </button>
              <button
                onClick={this.reset}
                className="h-9 rounded-lg border border-[#DDDFE4] px-4 text-[13.5px] font-medium text-gray-700 hover:bg-gray-50"
              >
                Försök igen
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
