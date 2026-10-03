/**
 * Tolkning av en BgMax-fil enligt Bankgirot, "Bankgiro Inbetalningar – Teknisk manual",
 * oktober 2023. Ren funktion: ingen I/O, ingen bokföring.
 *
 * Filens struktur (manualen 2.1): startpost (TK01), ett eller flera AVSNITT, slutpost (TK70).
 * Ett avsnitt börjar med öppningspost (TK05) och avslutas med insättningspost (TK15).
 * Avsnittets betalningar (TK20) och avdrag (TK21) står däremellan.
 *
 *  - Betalningsdagen finns i TK15 pos 38–45 (SSÅÅMMDD) och gäller avsnittets poster. TK05 bär
 *    INGET datum (pos 23–25 är valuta). Datumet kan därför först bestämmas när avsnittet är slut.
 *  - TK15 pos 51–68 är insättningens belopp = betalningar − avdrag, pos 72–79 antal betalnings-
 *    och avdragsposter. Avviker avsnittet från det stoppas det synligt.
 *  - Ett avdrag (TK21) har samma uppbyggnad som en betalning och avser t.ex. en kreditfaktura.
 *    Summan av en BETALARES betalningar ska vara minst lika stor som dennes avdrag. Avdraget
 *    är alltså inte knutet till närmast föregående TK20, och det är aldrig en inbetalning.
 *    Eveno kan inte koppla avdrag mot kreditfakturor automatiskt: en betalares betalningar och
 *    avdrag stoppas synligt (pengarna har ändå kommit in netto — de ska hanteras manuellt).
 *    Avdrag från okänd betalare (avsändarbankgiro 0) gör hela avsnittet otolkbart → stopp.
 *  - Okända posttyper ignoreras (manualen 2: "bör … ignorera posttyper den inte känner igen").
 */
export interface BgMaxPost {
  /** Avsändarens bankgiro (pos 3–12), '0000000000' om okänt. */
  avsandarBankgiro: string
  /** Referens/OCR (pos 13–37), trimmad. */
  referens: string
  belopp: number
  beloppOre: number
}

export interface BgMaxAvsnitt {
  /** Betalningsdag ur TK15 (UTC-midnatt) — null om avsnittet stoppats före TK15. */
  betalningsdag: Date | null
  /** Betalningar som får importeras automatiskt. */
  betalningar: BgMaxPost[]
}

export interface BgMaxTolkning {
  avsnitt: BgMaxAvsnitt[]
  /** Läsbara stopp och radfel. Varje stoppad post eller avsnitt redovisas här. */
  fel: string[]
}

const kr = (ore: number) => (ore / 100).toFixed(2).replace('.', ',')

export function tolkaBgMax(text: string): BgMaxTolkning {
  const rader = text.split(/\r?\n/).filter((l) => l.length > 0)
  const ut: BgMaxTolkning = { avsnitt: [], fel: [] }
  let öppet: {
    betalningar: BgMaxPost[]
    avdrag: BgMaxPost[]
    radfel: number
    startrad: number
  } | null = null

  const läsPost = (rad: string, radnr: number): BgMaxPost | null => {
    const beloppOre = Number.parseInt(rad.slice(37, 55).trim(), 10)
    if (!/^\d{18}$/.test(rad.slice(37, 55)) || !Number.isSafeInteger(beloppOre) || beloppOre <= 0) {
      ut.fel.push(`Rad ${radnr}: ogiltigt belopp`)
      return null
    }
    return {
      avsandarBankgiro: rad.slice(2, 12),
      referens: rad.slice(12, 37).trim(),
      beloppOre,
      belopp: beloppOre / 100,
    }
  }

  const stäng = (tk15: string | null, radnr: number) => {
    if (!öppet) return
    const a = öppet
    öppet = null
    const beskriv = `Avsnittet som börjar på rad ${a.startrad}`
    if (tk15 === null) {
      ut.fel.push(`${beskriv} saknar insättningspost (TK15) — avsnittet importeras inte.`)
      return
    }
    const ds = tk15.slice(37, 45)
    const datum = /^\d{8}$/.test(ds)
      ? new Date(`${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}T00:00:00.000Z`)
      : null
    if (
      !datum ||
      Number.isNaN(datum.getTime()) ||
      datum.toISOString().slice(0, 10).replace(/-/g, '') !== ds
    ) {
      ut.fel.push(
        `${beskriv}: insättningsposten (rad ${radnr}) har ingen giltig betalningsdag — avsnittet importeras inte.`,
      )
      return
    }
    if (a.radfel > 0) {
      ut.fel.push(
        `${beskriv} innehåller ${a.radfel} oläsbara poster — avsnittet importeras inte, eftersom insättningen då inte kan stämmas av.`,
      )
      return
    }
    const insattOre = Number.parseInt(tk15.slice(50, 68), 10)
    const antal = Number.parseInt(tk15.slice(71, 79), 10)
    const summa =
      a.betalningar.reduce((s, p) => s + p.beloppOre, 0) -
      a.avdrag.reduce((s, p) => s + p.beloppOre, 0)
    if (
      !/^\d{18}$/.test(tk15.slice(50, 68)) ||
      !/^\d{8}$/.test(tk15.slice(71, 79)) ||
      insattOre !== summa ||
      antal !== a.betalningar.length + a.avdrag.length
    ) {
      ut.fel.push(
        `${beskriv}: insättningsposten anger ${Number.isFinite(insattOre) ? kr(insattOre) : '?'} kr i ${Number.isFinite(antal) ? antal : '?'} poster, ` +
          `men avsnittet innehåller ${kr(summa)} kr i ${a.betalningar.length + a.avdrag.length} poster — avsnittet importeras inte.`,
      )
      return
    }
    if (a.avdrag.some((p) => /^0+$/.test(p.avsandarBankgiro))) {
      ut.fel.push(
        `${beskriv} (betalningsdag ${ds}) innehåller avdrag (TK21) utan känd betalare — avdraget kan inte knytas till rätt betalning. ` +
          `Hela avsnittet (insättning ${kr(insattOre)} kr) importeras inte; hantera det manuellt.`,
      )
      return
    }
    const medAvdrag = new Set(a.avdrag.map((p) => p.avsandarBankgiro))
    for (const bg of medAvdrag) {
      const b = a.betalningar.filter((p) => p.avsandarBankgiro === bg)
      const d = a.avdrag.filter((p) => p.avsandarBankgiro === bg)
      ut.fel.push(
        `Betalningsdag ${ds}: betalare med bankgiro ${bg} har ${b.length} betalning(ar) på ${kr(b.reduce((s, p) => s + p.beloppOre, 0))} kr ` +
          `och ${d.length} avdrag (TK21) på ${kr(d.reduce((s, p) => s + p.beloppOre, 0))} kr (referens ${d.map((p) => p.referens || '–').join(', ')}). ` +
          `Avdrag kopplas inte automatiskt — betalarens poster importeras inte; hantera dem manuellt mot kreditfakturan.`,
      )
    }
    ut.avsnitt.push({
      betalningsdag: datum,
      betalningar: a.betalningar.filter((p) => !medAvdrag.has(p.avsandarBankgiro)),
    })
  }

  rader.forEach((rad, i) => {
    const radnr = i + 1
    const tk = rad.slice(0, 2)
    if (tk === '05') {
      if (öppet) stäng(null, radnr)
      öppet = { betalningar: [], avdrag: [], radfel: 0, startrad: radnr }
    } else if (tk === '20' || tk === '21') {
      if (!öppet) {
        ut.fel.push(
          `Rad ${radnr}: ${tk === '20' ? 'betalningspost' : 'avdragspost'} utanför ett avsnitt — ignoreras.`,
        )
        return
      }
      const p = läsPost(rad, radnr)
      if (!p) öppet.radfel++
      else (tk === '20' ? öppet.betalningar : öppet.avdrag).push(p)
    } else if (tk === '15') {
      if (!öppet) ut.fel.push(`Rad ${radnr}: insättningspost utan öppningspost — ignoreras.`)
      else stäng(rad, radnr)
    }
  })
  if (öppet) stäng(null, rader.length)
  return ut
}
