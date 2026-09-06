import { delegationVillkorstext } from '@eken/shared'

import type { InboxItem } from '../api/inbox.api'

export interface VerdiktVisning {
  /** Kort etikett för kortet. */
  etikett: string
  /** Hela meningen för modalen. */
  mening: string
  variant: 'success' | 'default' | 'warning'
}

/**
 * TORRLÄGETS DOM I KLARTEXT.
 *
 * ── FYRA UTFALL, INTE TRE ───────────────────────────────────────────────────
 *
 * Enumen har tre värden, men `null` är ett fjärde tillstånd med egen betydelse:
 * *ingen dom ännu*. Att rendera det som "hade väntat på dig" hade gjort en lucka
 * i kön till ett påstående om delegationsläget — alltså ett facit som ljuger åt
 * det håll som får hyresvärden att tro att hen delegerat mindre än hen gjort.
 *
 * ── DOMEN ÄR INTE FÄRSK, OCH TEXTEN SÄGER DET INTE ─────────────────────────
 *
 * `verdictAt` bär när domen fälldes, och delegationsläget kan ha ändrats sedan
 * dess. Datumet visas därför bredvid domen i modalen. Det är läsytans sak att
 * visa tidpunkten — den här funktionen formulerar bara utfallet.
 */
export function verdiktVisning(item: InboxItem): VerdiktVisning | null {
  switch (item.executionVerdict) {
    case 'WOULD_EXECUTE': {
      const villkor = item.verdictDelegation
        ? delegationVillkorstext(item.verdictDelegation.villkor)
        : null
      return {
        etikett: 'Hade utförts automatiskt',
        mening: villkor
          ? `Hade utförts automatiskt enligt din delegation (${villkor}).`
          : 'Hade utförts automatiskt enligt en av dina delegationer.',
        variant: 'success',
      }
    }
    case 'NO_DELEGATION':
      return {
        etikett: 'Hade väntat på dig',
        mening:
          'Hade väntat på dig — du har inte gett agenten rätten att göra det här på egen hand.',
        variant: 'default',
      }
    case 'BLOCKED':
      return {
        etikett: 'Hade stoppats',
        // SERVERNS EGEN TEXT, ordagrant. En omformulering här hade blivit en
        // andra uppräkning av grindens skäl, och den som syns hade varit den
        // som ingen prövat.
        mening: item.verdictReason
          ? `Hade stoppats: ${item.verdictReason}`
          : 'Hade stoppats — en delegation finns men bar inte det här fallet.',
        variant: 'warning',
      }
    default:
      // INGEN DOM ÄNNU. Returnerar null i stället för en text: kortet ska då
      // inte visa något alls, för det finns inget att visa.
      return null
  }
}
