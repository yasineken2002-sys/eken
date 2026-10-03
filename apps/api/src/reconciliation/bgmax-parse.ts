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
 *    Kontrollposterna är däremot KÄNDA och krävs (PARSER-006): filen ska börja med TK01
 *    (layoutnamn "BGMAX" pos 3–22, version pos 23–24) och sluta med TK70, vars antal
 *    betalningar, avdrag, extra referenser och insättningar (pos 3–10, 11–18, 19–26, 27–34)
 *    ska stämma med filen. Annars kan filen vara avklippt eller fel format, och HELA filen
 *    stoppas — ett komplett utfall för en ofullständig fil är värre än inget.
 *  - Valuta: TK05 pos 23–25 och TK15 pos 69–71 ska båda vara "SEK" (manualens enda värde).
 *    Annat eller motsägande → avsnittet stoppas. Ingen växling.
 *  - Extra referensnummerposter (TK22/TK23, manualen 2.2.5) hör till betalningen/avdraget med
 *    samma avsändarbankgiro och BGC-löpnummer. De betyder att betalningen avser FLERA referenser
 *    (eller bär ett avdrag, TK23). Eveno fördelar inte en betalning över flera referenser
 *    automatiskt: den betalningen stoppas synligt.
 *  - `stopp` anger betalningsdagen för varje stoppad post/avsnitt (null om okänd). Importen
 *    flyttar inte betalningsunderlagets "data t.o.m."-datum förbi en dag där pengar stoppats.
 */
export interface BgMaxPost {
  /** Avsändarens bankgiro (pos 3–12), '0000000000' om okänt. */
  avsandarBankgiro: string
  /** Referens/OCR (pos 13–37), trimmad. */
  referens: string
  belopp: number
  beloppOre: number
  /** BGC-löpnummer (pos 58–69). */
  bgcLopnummer: string
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
  /** Ett element per stopp: betalningsdagen där pengar inte importerades (null = okänd dag). */
  stopp: Array<{ dag: Date | null }>
}

const kr = (ore: number) => (ore / 100).toFixed(2).replace('.', ',')

export function tolkaBgMax(text: string): BgMaxTolkning {
  const rader = text.split(/\r?\n/).filter((l) => l.length > 0)
  const ut: BgMaxTolkning = { avsnitt: [], fel: [], stopp: [] }

  // ── Filnivå (PARSER-006): start- och slutpost krävs och ska stämma ──────────
  const filfel = kontrolleraFil(rader)
  if (filfel) {
    ut.fel.push(`${filfel} Hela filen importeras inte; hämta om filen från banken.`)
    ut.stopp.push({ dag: null })
    return ut
  }

  let öppet: {
    betalningar: BgMaxPost[]
    avdrag: BgMaxPost[]
    extraRef: Array<{ tk: string; avsandarBankgiro: string; bgcLopnummer: string; radnr: number }>
    valuta: string
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
      bgcLopnummer: rad.slice(57, 69),
    }
  }

  const stäng = (tk15: string | null, radnr: number) => {
    if (!öppet) return
    const a = öppet
    öppet = null
    const beskriv = `Avsnittet som börjar på rad ${a.startrad}`
    if (tk15 === null) {
      ut.fel.push(`${beskriv} saknar insättningspost (TK15) — avsnittet importeras inte.`)
      ut.stopp.push({ dag: null })
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
      ut.stopp.push({ dag: null })
      return
    }
    const stoppaAvsnitt = (text: string) => {
      ut.fel.push(text)
      ut.stopp.push({ dag: datum })
    }
    const valuta15 = tk15.slice(68, 71)
    if (a.valuta !== 'SEK' || valuta15 !== 'SEK') {
      stoppaAvsnitt(
        `${beskriv} (betalningsdag ${ds}): valuta "${a.valuta.trim()}" i öppningsposten och "${valuta15.trim()}" i ` +
          'insättningsposten — bara SEK stöds och ingen växling görs. Avsnittet importeras inte.',
      )
      return
    }
    if (a.radfel > 0) {
      stoppaAvsnitt(
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
      stoppaAvsnitt(
        `${beskriv}: insättningsposten anger ${Number.isFinite(insattOre) ? kr(insattOre) : '?'} kr i ${Number.isFinite(antal) ? antal : '?'} poster, ` +
          `men avsnittet innehåller ${kr(summa)} kr i ${a.betalningar.length + a.avdrag.length} poster — avsnittet importeras inte.`,
      )
      return
    }
    if (a.avdrag.some((p) => /^0+$/.test(p.avsandarBankgiro))) {
      stoppaAvsnitt(
        `${beskriv} (betalningsdag ${ds}) innehåller avdrag (TK21) utan känd betalare — avdraget kan inte knytas till rätt betalning. ` +
          `Hela avsnittet (insättning ${kr(insattOre)} kr) importeras inte; hantera det manuellt.`,
      )
      return
    }
    // Extra referensnummer (TK22/TK23) hör till posten med samma avsändarbankgiro och löpnummer.
    const nyckel = (p: { avsandarBankgiro: string; bgcLopnummer: string }) =>
      `${p.avsandarBankgiro}:${p.bgcLopnummer}`
    const poster = new Set([...a.betalningar, ...a.avdrag].map(nyckel))
    const föräldralös = a.extraRef.find((x) => !poster.has(nyckel(x)))
    if (föräldralös) {
      stoppaAvsnitt(
        `${beskriv} (betalningsdag ${ds}): extra referensnummerpost på rad ${föräldralös.radnr} hör inte till någon betalning ` +
          'i avsnittet — avsnittet kan inte stämmas av och importeras inte.',
      )
      return
    }
    const medExtraRef = new Set(a.extraRef.map(nyckel))
    for (const p of a.betalningar.filter((b) => medExtraRef.has(nyckel(b)))) {
      const typer = [
        ...new Set(a.extraRef.filter((x) => nyckel(x) === nyckel(p)).map((x) => `TK${x.tk}`)),
      ]
      ut.fel.push(
        `Betalningsdag ${ds}: betalningen på ${kr(p.beloppOre)} kr (referens ${p.referens || '–'}, löpnummer ${p.bgcLopnummer}) ` +
          `har extra referensnummer (${typer.join('/')}) och avser alltså flera referenser eller bär ett avdrag. ` +
          'Den fördelas inte automatiskt och importeras inte; hantera den manuellt.',
      )
      ut.stopp.push({ dag: datum })
    }
    const medAvdrag = new Set(a.avdrag.map((p) => p.avsandarBankgiro))
    if (medAvdrag.size > 0) ut.stopp.push({ dag: datum })
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
      betalningar: a.betalningar.filter(
        (p) => !medAvdrag.has(p.avsandarBankgiro) && !medExtraRef.has(nyckel(p)),
      ),
    })
  }

  rader.forEach((rad, i) => {
    const radnr = i + 1
    const tk = rad.slice(0, 2)
    if (tk === '05') {
      if (öppet) stäng(null, radnr)
      öppet = {
        betalningar: [],
        avdrag: [],
        extraRef: [],
        valuta: rad.slice(22, 25),
        radfel: 0,
        startrad: radnr,
      }
    } else if (tk === '20' || tk === '21') {
      if (!öppet) {
        ut.fel.push(
          `Rad ${radnr}: ${tk === '20' ? 'betalningspost' : 'avdragspost'} utanför ett avsnitt — importeras inte.`,
        )
        ut.stopp.push({ dag: null })
        return
      }
      const p = läsPost(rad, radnr)
      if (!p) öppet.radfel++
      else (tk === '20' ? öppet.betalningar : öppet.avdrag).push(p)
    } else if (tk === '22' || tk === '23') {
      if (!öppet) {
        ut.fel.push(`Rad ${radnr}: extra referensnummerpost utanför ett avsnitt — importeras inte.`)
        ut.stopp.push({ dag: null })
        return
      }
      öppet.extraRef.push({
        tk,
        avsandarBankgiro: rad.slice(2, 12),
        bgcLopnummer: rad.slice(57, 69),
        radnr,
      })
    } else if (tk === '15') {
      if (!öppet) {
        ut.fel.push(`Rad ${radnr}: insättningspost utan öppningspost — importeras inte.`)
        ut.stopp.push({ dag: null })
      } else stäng(rad, radnr)
    }
  })
  if (öppet) stäng(null, rader.length)
  return ut
}

/**
 * Filens ram (manualen 2.1, tabell 2 och 17). Returnerar ett läsbart fel, eller null om
 * ramen stämmer. Raderna är redan fria från tomrader.
 */
function kontrolleraFil(rader: string[]): string | null {
  const första = rader[0]
  if (!första || första.slice(0, 2) !== '01') {
    return 'Filen saknar startpost (TK01) — den är inte en komplett BgMax-fil.'
  }
  if (första.slice(2, 22).trim() !== 'BGMAX' || !/^\d{2}$/.test(första.slice(22, 24))) {
    return `Startposten anger layout "${första.slice(2, 22).trim()}" version "${första.slice(22, 24)}" — bara BGMAX stöds.`
  }
  const sista = rader[rader.length - 1]!
  if (sista.slice(0, 2) !== '70') {
    return 'Filen saknar slutpost (TK70) — den kan vara avklippt.'
  }
  const tk = (k: string) => rader.filter((r) => r.slice(0, 2) === k).length
  if (tk('01') !== 1 || tk('70') !== 1) {
    return 'Filen har fler än en startpost eller slutpost — den kan vara sammanslagen eller skadad.'
  }
  const fält = [sista.slice(2, 10), sista.slice(10, 18), sista.slice(18, 26), sista.slice(26, 34)]
  const faktiskt = [tk('20'), tk('21'), tk('22') + tk('23'), tk('15')]
  if (fält.some((f) => !/^\d{8}$/.test(f)) || fält.some((f, i) => Number(f) !== faktiskt[i])) {
    return (
      `Slutposten anger ${fält.map((f) => Number(f)).join('/')} men filen innehåller ${faktiskt.join('/')} ` +
      '(betalningar/avdrag/extra referenser/insättningar) — filen kan vara avklippt eller skadad.'
    )
  }
  return null
}
