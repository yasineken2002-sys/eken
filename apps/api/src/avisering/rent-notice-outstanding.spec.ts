/**
 * #344 — avi-sidans krav bär restskulden, inte bruttot.
 *
 * Portalens avi-vy och påminnelsebrevet (mejl + PDF) visade alla
 * `rentNoticePayableTotal` — avins bruttobelopp. Betalade hyresgästen 4 000 av
 * 9 000 kom nästa morgon ett formellt krav på 9 000.
 *
 * VÄRRE ÄN #329: `RentNoticeStatus` saknar ett PARTIAL-läge, så den delbetalda
 * avin ligger kvar i kravtrappan utan att någon rör den. Felet är nåbart via
 * REN AUTOMATIK — cronen skickar av sig själv. #329 krävde en manuell
 * statusändring.
 *
 * Och systemet VISSTE: eskaleringsgrinden läser `ocrOutstanding` några rader
 * innan brevet skrivs, just för att avgöra om påminnelsen ska skickas alls.
 */

import { Prisma, RentNoticeType } from '@prisma/client'
import { rentNoticeOutstanding, computeRentDebt } from './rent-debt.service'

const D = (n: number) => new Prisma.Decimal(n)

/**
 * DISKRIMINERANDE: hyra 8 000 + förbrukning 250 + övrig debitering 500 +
 * avgift 60 = 8 810 brutto. Betalt 4 000 → 4 810 kvar. Ränta 120 ska ALDRIG
 * ingå i det OCR-reglerbara beloppet. Sex tal, inga sammanfaller.
 */
function notice(
  opts: { payments?: number[]; fee?: number; interest?: number; credits?: number[] } = {},
) {
  return {
    type: RentNoticeType.RENT,
    totalAmount: D(8000),
    consumptionAmount: D(250),
    miscChargeAmount: D(500),
    reminderFeeAmount: D(opts.fee ?? 60),
    interestAccruedAmount: D(opts.interest ?? 120),
    payments: (opts.payments ?? []).map((a) => ({ amount: D(a) })),
    credits: (opts.credits ?? []).map((a) => ({ amount: D(a) })),
  }
}

describe('#344 — rentNoticeOutstanding', () => {
  it('delbetald avi → payable är restskulden, inte bruttot', () => {
    const { payable } = rentNoticeOutstanding(notice({ payments: [4000] }))
    expect(payable).toBe(4810) // 8 810 − 4 000, INTE 8 810
  })

  it('obetald avi → payable är bruttot (oförändrat beteende)', () => {
    expect(rentNoticeOutstanding(notice()).payable).toBe(8810)
  })

  it('RÄNTAN ingår aldrig — den går inte att betala med avins OCR', () => {
    // `claim` skulle innehålla räntan; `ocrOutstanding` gör det inte. Ett krav
    // som räknar in räntan ber om ett belopp mottagaren inte kan betala på det
    // sätt brevet anvisar.
    const withInterest = rentNoticeOutstanding(notice({ payments: [4000], interest: 120 }))
    const withoutInterest = rentNoticeOutstanding(notice({ payments: [4000], interest: 0 }))
    expect(withInterest.payable).toBe(withoutInterest.payable)
  })

  it('posterna är NOMINELLA — avins belopp och avgiften, som de bokfördes', () => {
    const { nominalBeforeFee, fee, nominalTotal } = rentNoticeOutstanding(
      notice({ payments: [4000] }),
    )
    expect(nominalBeforeFee).toBe(8750) // 8 000 + 250 + 500, oberoende av betalt
    expect(fee).toBe(60)
    expect(nominalTotal).toBe(8810)
  })

  it('RADERNA SUMMERAR — även när betalningen ätit in på påminnelseavgiften', () => {
    // FAR:s fynd i granskningen. Första versionen returnerade
    // `payableBeforeFee = max(0, ocrOutstanding − fee)`. Betalt 8 800 av
    // 8 750 kapital + 60 avgift ger ocrOutstanding = 10; den klampade raden blev
    // 0 medan avgiftsraden stod kvar på 60. Brevet visade `0 + 60` under en
    // total på `10` — ett formellt krav (lag 1981:739 5 §) vars poster inte gick
    // ihop. Nåbart: avgiften bokförs vid eskaleringen, brevet renderas först i
    // PDF-jobbet, och en bankbetalning kan landa däremellan.
    const { payable, nominalBeforeFee, fee, paid, overpaid } = rentNoticeOutstanding(
      notice({ payments: [8800] }),
    )
    expect(payable).toBe(10)
    expect(nominalBeforeFee + fee - paid + overpaid).toBe(payable)
  })

  it('RADERNA SUMMERAR — i alla fyra lägena, inte bara det vanliga', () => {
    for (const payments of [[], [4000], [8800], [10000]]) {
      const { payable, nominalBeforeFee, fee, paid, overpaid } = rentNoticeOutstanding(
        notice({ payments }),
      )
      expect(nominalBeforeFee + fee - paid + overpaid).toBe(payable)
    }
  })

  it('överbetalning redovisas som EGEN post — annars summerar raderna negativt', () => {
    // 10 000 betalt mot 8 810 nominellt. `payable` klampas till 0; utan
    // `overpaid` hade posterna summerat till −1 190 under en total på 0.
    const { payable, overpaid } = rentNoticeOutstanding(notice({ payments: [10000] }))
    expect(payable).toBe(0)
    expect(overpaid).toBe(1190)
  })

  it('nominalTotal är ALDRIG klampat — portalens "Kvar av" hänger på det', () => {
    // Vid överbetalning är `payableTotal + paid` = 0 + 10 000 = 10 000, dvs.
    // gränssnittet hade påstått att avin var på det INBETALDA beloppet.
    // `nominalTotal` är avins faktiska fordran, oberoende av betalningar.
    expect(rentNoticeOutstanding(notice({ payments: [10000] })).nominalTotal).toBe(8810)
    expect(rentNoticeOutstanding(notice()).nominalTotal).toBe(8810)
  })

  it('paid LÄSES UR ALLOKERINGARNA, aldrig som brutto − restskuld', () => {
    // Överbetalning: 10 000 mot 8 810 brutto. `payable` klampas till 0, men
    // `paid` måste visa de faktiska 10 000. Härledningen `brutto − payable`
    // hade gett 8 810 och gömt överbetalningen — #342:s must-fix.
    const { payable, paid } = rentNoticeOutstanding(notice({ payments: [10000] }))
    expect(payable).toBe(0)
    expect(paid).toBe(10000)
    expect(paid).not.toBe(8810)
  })

  it('flera allokeringar summeras', () => {
    expect(rentNoticeOutstanding(notice({ payments: [1500, 2500] })).paid).toBe(4000)
  })

  it('bygger på computeRentDebt — ingen egen aritmetik', () => {
    // Spärren: samma uttryck som eskaleringsgrinden läser. Skulle helpern börja
    // räkna själv kan de två glida isär, och grinden och brevet skulle tala om
    // olika skulder.
    const n = notice({ payments: [4000] })
    const debt = computeRentDebt({
      type: n.type,
      totalAmount: n.totalAmount,
      consumptionAmount: n.consumptionAmount,
      miscChargeAmount: n.miscChargeAmount,
      reminderFeeAmount: n.reminderFeeAmount,
      interestAccruedAmount: n.interestAccruedAmount,
      credits: [],
      allocations: n.payments.map((p) => p.amount),
    })
    expect(rentNoticeOutstanding(n).payable).toBe(debt.ocrOutstanding)
    expect(rentNoticeOutstanding(n).paid).toBe(debt.paid)
  })

  // ── DEPOSITIONSAVIN — regression funnen av bevisriggen ────────────────────
  //
  // `computeRentDebt` kortsluter till nollor för DEPOSIT. Det är rätt för
  // KRAVTRAPPANS grind (en deposition ska aldrig drivas in där), men det är ett
  // skuldpåstående — inte ett beloppspåstående. #344 var den första ändringen som
  // ledde en VISNINGSyta genom den kortslutningen, och portalen började visa
  // `0 kr` på en depositionsavi hyresgästen faktiskt ska betala.
  //
  // Bevisat mot riktig Postgres innan fixen: en 7 400 kr-deposition, skapad av
  // den skarpa aktiveringsvägen och skickad av det skarpa utskicksjobbet, kom
  // fram i portalen som 0 kr.
  it('DEPOSIT-avi → depositionens BELOPP, inte noll', () => {
    const dep = { ...notice({ payments: [], fee: 0, interest: 0 }), type: RentNoticeType.DEPOSIT }
    // 8 000 + 250 + 500 = 8 750. Före fixen: 0.
    expect(rentNoticeOutstanding(dep).payable).toBe(8750)
    expect(rentNoticeOutstanding(dep).nominalTotal).toBe(8750)
  })

  it('DEPOSIT-avi → registrerad betalning dras av (bankmatchningen skapar allokering)', () => {
    const dep = {
      ...notice({ payments: [1000], fee: 0, interest: 0 }),
      type: RentNoticeType.DEPOSIT,
    }
    expect(rentNoticeOutstanding(dep).paid).toBe(1000)
    expect(rentNoticeOutstanding(dep).payable).toBe(7750)
  })

  it('DEPOSIT-avin når ALDRIG kravtrappan — computeRentDebt är fortsatt noll där', () => {
    // Spärren åt andra hållet: fixen ovan får inte göra depositionen synlig för
    // eskaleringsgrinden, som läser computeRentDebt (inte den här helpern).
    const dep = notice({ payments: [1000] })
    expect(
      computeRentDebt({
        type: RentNoticeType.DEPOSIT,
        totalAmount: dep.totalAmount,
        consumptionAmount: dep.consumptionAmount,
        miscChargeAmount: dep.miscChargeAmount,
        reminderFeeAmount: dep.reminderFeeAmount,
        interestAccruedAmount: dep.interestAccruedAmount,
        credits: [],
        allocations: dep.payments.map((p) => p.amount),
      }).ocrOutstanding,
    ).toBe(0)
  })
})
