// Hjälpare för att öppna förautentiserade nedladdningar (presigned R2-URL:er).
// Backend returnerar { url, filename } från /documents/:id/download och
// /contracts/download/:leaseId — URL:en är giltig i ~5 min och kräver inte
// någon Authorization-header (signaturen ligger i query-stringen).
//
// Vi triggar nedladdning via en dynamisk <a download="..."> istället för
// window.open, så att webbläsaren respekterar filnamnet och inte navigerar
// bort från SPA:n när PDF:en visas inline i iframe-läge.

const FILENAME_SAFE_RE = /[^\w.\-() ]+/g

export function sanitizeFilename(name: string, fallback = 'fil'): string {
  const cleaned = name.trim().replace(FILENAME_SAFE_RE, '_').slice(0, 200)
  return cleaned || fallback
}

export function openPresignedDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.target = '_blank'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
