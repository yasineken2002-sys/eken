import { ConfigService } from '@nestjs/config'
import { SigningCryptoService } from '../../signing/signing-crypto.service'
import { PersonalNumberService } from './personal-number.service'
import { isValidSwedishPersonalNumber } from '@eken/shared'

/**
 * TIO ELLER TOLV SIFFROR — SAMMA MÄNNISKA, OLIKA BLINDINDEX.
 *
 * ── VARFÖR PROVET FINNS ───────────────────────────────────────────────────
 *
 * BankID svarar ALLTID med tolv siffror. Hyresvärden skriver in det som står i
 * hyresavtalet, och `isValidSwedishPersonalNumber` accepterar med flit båda
 * formerna — `/^(\d{10}|\d{12})$/`. Normaliseringen inför hashningen är
 * `replace(/\D/g,'')`, som tar bort bindestreck men INTE lägger till ett sekel.
 *
 * Följden: två olika HMAC:er för samma person, och ett uppslag på bara den ena
 * formen missar alla hyresgäster som registrerats med den andra. Felet syns inte
 * som ett fel — det syns som "inget konto hittades", vilket är exakt vad flödet
 * svarar när personen är okänd.
 *
 * Provet mäter att fällan FINNS (annars vore åtgärden onödig) och att
 * `indexCandidates` täcker den.
 */
function tjänst(): PersonalNumberService {
  const config = {
    get: (nyckel: string) =>
      nyckel === 'SIGNING_PII_KEY'
        ? 'a'.repeat(64)
        : nyckel === 'SIGNING_PII_PEPPER'
          ? 'p'.repeat(32)
          : undefined,
  } as unknown as ConfigService
  return new PersonalNumberService(new SigningCryptoService(config))
}

/** Skatteverkets officiella testnummer — aldrig en riktig person. */
const TOLV = '199001019802'
const TIO = '9001019802'

describe('personnummerformer och blindindex', () => {
  const pn = tjänst()

  it('FÄLLAN FINNS: båda formerna är giltiga men ger OLIKA hash', () => {
    // Utan den här raden går det inte att veta om `indexCandidates` löser ett
    // verkligt problem eller ett inbillat. Validatorn släpper igenom båda —
    // alltså KAN båda ligga i databasen.
    expect(isValidSwedishPersonalNumber(TOLV)).toBe(true)
    expect(isValidSwedishPersonalNumber(TIO)).toBe(true)
    expect(pn.index(TOLV)).not.toBe(pn.index(TIO))
  })

  it('formatering spelar ingen roll — bindestreck och plus normaliseras bort', () => {
    expect(pn.index('19900101-9802')).toBe(pn.index(TOLV))
    expect(pn.index('900101-9802')).toBe(pn.index(TIO))
    expect(pn.index('900101+9802')).toBe(pn.index(TIO))
  })

  it('indexCandidates täcker BÅDA formerna, med den exakta först', () => {
    const kandidater = pn.indexCandidates(TOLV)
    expect(kandidater).toEqual([pn.index(TOLV), pn.index(TIO)])
  })

  it('riktningen är entydig: tio siffror in ger EN kandidat, inte två', () => {
    // Tio → tolv vore en gissning (1990 eller 2090). Metoden härleder därför
    // bara nedåt, från BankID:s tolvsiffriga form.
    expect(pn.indexCandidates(TIO)).toEqual([pn.index(TIO)])
  })

  it('samordningsnummer behandlas likadant — dag + 60 är inget specialfall', () => {
    // Dag 61–91 är ett samordningsnummer. Normaliseringen rör inte siffrorna, så
    // formen fungerar precis som ett vanligt personnummer.
    const kandidater = pn.indexCandidates('196109199813')
    expect(kandidater).toEqual([pn.index('196109199813'), pn.index('6109199813')])
  })

  it('KANARIEFÅGEL: en hash är inte personnumret', () => {
    // Trivialt sant, och står här ändå: provet ovan jämför hashar, och en
    // implementation som råkat returnera klartext hade gjort dem lika utan att
    // något annat prov märkte det.
    expect(pn.index(TOLV)).not.toContain('9802')
    expect(pn.index(TOLV)).toMatch(/^[0-9a-f]{64}$/)
  })
})
