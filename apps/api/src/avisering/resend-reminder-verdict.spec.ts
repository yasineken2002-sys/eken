/**
 * FÅR PÅMINNELSEN SKICKAS OM? — rena prov.
 *
 * ── DEN NEGATIVA KONTROLLEN ─────────────────────────────────────────────────
 *
 * Knappen får INTE gå att trycka på en avi vars senaste utskick LEVERERADES.
 * Ett andra brev vore då en dubblett till en hyresgäst som redan fått kravet —
 * och kravtrappan skulle se ut att göra om ett steg den redan tagit.
 *
 * ── VARFÖR BEDÖMNINGEN ÄR EN REN FUNKTION ───────────────────────────────────
 *
 * Grindarna bär pengar och avgör om en knapp går att trycka. Fanns de i två
 * uppsättningar — en för knappen, en för skrivvägen — vore det den som INTE
 * grindar som visas för operatören. `collectionStatus` och `resendReminder`
 * läser båda den här funktionen.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Om den nya adressen är RIKTIG. Funktionen kan bara se att den är en ANNAN än
 * den som studsade. `null` betyder "vet ej" och är ett eget svar, inte ett ja.
 */

import { bedömOmsändning, hashaAdress } from './resend-verdict'

import type { RentNoticeEventType } from '@prisma/client'

const STUDSAD = ['EMAIL_BOUNCED'] as RentNoticeEventType[]
const LEVERERAD = ['EMAIL_DELIVERED'] as RentNoticeEventType[]
const GAMMAL_ADRESS = 'gammal@example.se'

const bedöm = (over: Partial<Parameters<typeof bedömOmsändning>[0]> = {}) =>
  bedömOmsändning({
    collectionStage: 'REMINDED',
    senasteUtskick: { id: 'send-1', toHash: hashaAdress(GAMMAL_ADRESS) },
    utfall: STUDSAD,
    tenantEmail: 'ny@example.se',
    ...over,
  })

describe('bedömOmsändning', () => {
  it('KANARIEFÅGEL: funktionen kan säga JA', () => {
    // Utan den bevisar inget nej-prov i filen någonting.
    expect(bedöm()).toEqual({
      allowed: true,
      blockedReason: null,
      senasteUtskickId: 'send-1',
      addressChangedSinceBounce: true,
    })
  })

  // ── DEN NEGATIVA KONTROLLEN ───────────────────────────────────────────────

  it('NEGATIVKONTROLL: en LEVERERAD påminnelse går inte att skicka om', () => {
    const dom = bedöm({ utfall: LEVERERAD })
    expect(dom.allowed).toBe(false)
    expect(dom.blockedReason).toMatch(/kom fram/i)
  })

  it('och skälet SÄGS — en grå knapp utan förklaring är ett tyst nej', () => {
    for (const dom of [
      bedöm({ utfall: LEVERERAD }),
      bedöm({ utfall: [] }),
      bedöm({ senasteUtskick: null }),
      bedöm({ collectionStage: 'NONE' }),
      bedöm({ tenantEmail: null }),
    ]) {
      expect(dom.allowed).toBe(false)
      expect(dom.blockedReason ?? '').not.toHaveLength(0)
    }
  })

  // ── DE FYRA GRINDARNA ─────────────────────────────────────────────────────

  it.each([
    ['utanför kravsteget', { collectionStage: 'NONE' as const }, /inte i påminnelsesteget/i],
    ['inget utskick alls', { senasteUtskick: null }, /har skickats ännu/i],
    ['utfall saknas — kan vara på väg', { utfall: [] }, /leveransbesked/i],
    ['ingen adress att skicka till', { tenantEmail: null }, /saknar e-postadress/i],
  ])('%s → nej', (_namn, over, mönster) => {
    const dom = bedöm(over)
    expect(dom.allowed).toBe(false)
    expect(dom.blockedReason).toMatch(mönster)
  })

  // ── ADRESSEN ──────────────────────────────────────────────────────────────

  it('SAMMA adress som studsade → tillåten, men flaggad', () => {
    // Tillåten med flit: operatören kan ha rättat något annat, eller vilja
    // försöka igen ändå. Men den måste VETA — ett omförsök till samma trasiga
    // adress ger samma studs, och det var hela skälet till att det inte är
    // automatiskt.
    const dom = bedöm({ tenantEmail: GAMMAL_ADRESS })
    expect(dom.allowed).toBe(true)
    expect(dom.addressChangedSinceBounce).toBe(false)
  })

  it('adressen jämförs NORMALISERAT — versaler och blanksteg är samma adress', () => {
    const dom = bedöm({ tenantEmail: `  ${GAMMAL_ADRESS.toUpperCase()} ` })
    expect(dom.addressChangedSinceBounce).toBe(false)
  })

  it('ett utskick UTAN fingeravtryck ger "vet ej", inte "ändrad"', () => {
    // Ett falskt lugn här skickar ett brev till samma trasiga adress.
    const dom = bedöm({ senasteUtskick: { id: 'send-1', toHash: null } })
    expect(dom.allowed).toBe(true)
    expect(dom.addressChangedSinceBounce).toBeNull()
  })

  it('ett NEJ svarar aldrig på adressfrågan', () => {
    // `addressChangedSinceBounce` är bara meningsfull när omsändningen är
    // möjlig. Att svara true/false i ett nej hade inbjudit gränssnittet att
    // visa en varning om något som ändå inte går att göra.
    expect(bedöm({ utfall: LEVERERAD }).addressChangedSinceBounce).toBeNull()
  })
})
