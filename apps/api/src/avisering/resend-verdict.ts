import { createHash } from 'node:crypto'

import type { RentNotice, RentNoticeEventType } from '@prisma/client'
import type { RentCollectionStatus } from './rent-reminder.service'

/**
 * FÅR PÅMINNELSEN SKICKAS OM? — ren funktion, fyra fail-closed-grindar.
 *
 * Ren av ett skäl: grindarna bär pengar och avgör om en knapp går att trycka.
 * En sådan bedömning ska gå att pröva mot påhittade lägen, utan databas — och
 * den får bara finnas på ETT ställe, annars är knappens villkor och skrivvägens
 * villkor två uppsättningar som kan glida isär.
 *
 * Ordningen är vald efter vilket SKÄL som är mest upplysande: operatören ska få
 * veta vad som saknas, inte bara att knappen är grå.
 */
export function bedömOmsändning(args: {
  collectionStage: RentNotice['collectionStage']
  senasteUtskick: { id: string; toHash: string | null } | null
  /** Leveransutfallen för DET senaste utskicket. */
  utfall: RentNoticeEventType[]
  tenantEmail: string | null
}): RentCollectionStatus['resend'] {
  const senasteUtskickId = args.senasteUtskick?.id ?? null
  const nej = (blockedReason: string): RentCollectionStatus['resend'] => ({
    allowed: false,
    blockedReason,
    senasteUtskickId,
    addressChangedSinceBounce: null,
  })

  if (args.collectionStage !== 'REMINDED') {
    return nej('Avin är inte i påminnelsesteget — det finns ingen påminnelse att skicka om.')
  }
  if (!args.senasteUtskick) {
    return nej('Ingen påminnelse har skickats ännu, så det finns inget att skicka om.')
  }
  if (args.utfall.includes('EMAIL_DELIVERED')) {
    return nej('Påminnelsen kom fram. Ett andra brev vore en dubblett.')
  }
  if (!args.utfall.includes('EMAIL_BOUNCED')) {
    return nej('Utskicket har ännu inget leveransbesked — det kan fortfarande vara på väg.')
  }
  if (!args.tenantEmail) {
    return nej('Hyresgästen saknar e-postadress. Lägg till en adress först.')
  }

  return {
    allowed: true,
    blockedReason: null,
    senasteUtskickId,
    // `null` = VET EJ. Ett gammalt utskick saknar fingeravtryck, och då ska
    // gränssnittet säga det i stället för att påstå att adressen är ny.
    addressChangedSinceBounce:
      args.senasteUtskick.toHash === null
        ? null
        : args.senasteUtskick.toHash !== hashaAdress(args.tenantEmail),
  }
}

/**
 * Adressens fingeravtryck. ÄNDRINGSDETEKTOR, inte skydd — en e-postadress har
 * för litet sökrum för att en hash ska skydda den, och det påstås inte.
 */
export function hashaAdress(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}
