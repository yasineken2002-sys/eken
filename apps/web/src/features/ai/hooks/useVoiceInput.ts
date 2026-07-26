import { useRef, useState } from 'react'

// Web Speech API — ännu inte i alla TypeScript-lib-definitioner.
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onerror: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance
}

declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionConstructor
    webkitSpeechRecognition: SpeechRecognitionConstructor
  }
}

/**
 * Röstinmatning på svenska via Web Speech API. Anroparen äger texten:
 * `onTranscript` får hela transkriptionen (inte deltan) vid varje resultat,
 * precis som textarean fick den tidigare.
 */
export function useVoiceInput(onTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)

  const start = () => {
    if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
      alert('Din webbläsare stöder inte röstinmatning')
      return
    }
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    const recognition = new SR()
    recognition.lang = 'sv-SE'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onstart = () => setIsListening(true)
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results.item(i)
        transcript += result?.item(0)?.transcript ?? ''
      }
      onTranscript(transcript)
    }
    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    recognition.onerror = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    recognition.start()
    recognitionRef.current = recognition
  }

  const stop = () => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  return { isListening, start, stop }
}
