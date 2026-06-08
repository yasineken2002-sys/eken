import { StorageService } from '../../storage/storage.service'

/**
 * Hämtar organisationens logga från R2 och returnerar den som en
 * `data:`-URL (base64) så att den kan bäddas in direkt i PDF-HTML (Puppeteer
 * laddar inte externa, presignerade URL:er pålitligt vid render-tid).
 *
 * Returnerar null om ingen logga finns eller om hämtningen misslyckas — en
 * saknad logga får aldrig fälla PDF-genereringen.
 *
 * Flyttad hit (Steg 3, PR 2) från två identiska kopior i avisering.service.ts
 * och contract-template.service.ts. Implementationen är ordagrant densamma —
 * en sanning som shellen och alla befintliga anropare delar.
 */
export async function getLogoDataUrl(
  storage: StorageService,
  logoStorageKey: string | null,
): Promise<string | null> {
  if (!logoStorageKey) return null
  try {
    const buffer = await storage.getFileBuffer(logoStorageKey)
    const ext = logoStorageKey.split('.').pop()?.toLowerCase() ?? ''
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}
