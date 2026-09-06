import { ForbiddenException } from '@nestjs/common'

/**
 * DET HÄR VERKTYGET BEHÖVER EN MÄNNISKA ATT TILLSKRIVA HANDLINGEN.
 *
 * ── VARFÖR EN FUNKTION OCH INTE ETT `!` ────────────────────────────────────
 *
 * När `userId` blev nullbart (etapp 8: en SYSTEM-principal har inget) föll åtta
 * ställen i `tool-executor.service.ts`. Det snabba svaret hade varit `userId!` —
 * och det hade gjort en riktig gräns till en typassertion, alltså till
 * ingenting: en SYSTEM-körning hade skrivit `createdById: undefined` eller
 * kastat ett `null`-fel långt inne i en domäntjänst, där ingen kan se varför.
 *
 * Anropet säger i stället rakt ut vad som gäller: *det här verktyget kan inte
 * utföras utan en människa att tillskriva handlingen.* Felet blir en 403 med
 * verktygets namn, på gränsen, i stället för en `null` som färdas nedåt.
 *
 * ── DEN HÄR GRINDEN ÄR DJUPFÖRSVAR, INTE DEN BÄRANDE ───────────────────────
 *
 * `assertActionToolAuthorized` släpper bara igenom fem verktyg på en
 * delegation — de som är `IDEMPOTENT` med bärande spår — och inget av de åtta
 * ställena nedan ligger i dem. Ingen SYSTEM-körning kan alltså nå hit i dag.
 *
 * Att grinden ändå finns är samma skäl som `assertActionToolAuthorized` själv
 * anför: tre kopior av en kontroll är en VANA, inte en invariant. Klassas ett
 * verktyg om till `IDEMPOTENT` i morgon flyttas det in i mängden av fem utan
 * att någon läser den här filen — och då ska felet vara högt och tydligt, inte
 * en rad med fel författare.
 */
export function krävMänskligtSubjekt(userId: string | null | undefined, toolName: string): string {
  if (typeof userId === 'string' && userId.trim() !== '') return userId
  throw new ForbiddenException(
    `Verktyget "${toolName}" tillskriver handlingen en människa och kan därför inte ` +
      'utföras av systemet på en delegation. Det kräver en inloggad användare.',
  )
}
