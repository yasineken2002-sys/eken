import './instrument'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SessionBoundary } from './components/SessionBoundary'
import './styles/tokens.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <SessionBoundary>
          <App />
          <Toaster position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />
        </SessionBoundary>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
