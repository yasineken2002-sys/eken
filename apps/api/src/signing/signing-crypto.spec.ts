import { SigningCryptoService } from './signing-crypto.service'

// 32-byte hex-nyckel + pepper (testvärden).
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const PEPPER = 'test-pepper-1234567890'

function svc(env: Record<string, string> = { SIGNING_PII_KEY: KEY, SIGNING_PII_PEPPER: PEPPER }) {
  return new SigningCryptoService({ get: (k: string) => env[k] } as never)
}

describe('SigningCryptoService', () => {
  it('configured=true med giltig nyckel + pepper, false utan', () => {
    expect(svc().configured).toBe(true)
    expect(svc({}).configured).toBe(false)
    expect(svc({ SIGNING_PII_KEY: 'kort', SIGNING_PII_PEPPER: PEPPER }).configured).toBe(false)
  })

  it('encrypt/decrypt round-trippar och ciphertext ≠ klartext', () => {
    const s = svc()
    const pn = '199001011234'
    const enc = s.encrypt(pn)
    expect(enc).not.toContain(pn)
    expect(s.decrypt(enc)).toBe(pn)
  })

  it('encrypt är icke-deterministisk (olika iv varje gång)', () => {
    const s = svc()
    expect(s.encrypt('199001011234')).not.toBe(s.encrypt('199001011234'))
  })

  it('blindIndex är deterministiskt och normaliserar bort skiljetecken', () => {
    const s = svc()
    expect(s.blindIndex('19900101-1234')).toBe(s.blindIndex('199001011234'))
    expect(s.blindIndex('900101-1234')).not.toBe(s.blindIndex('199001011234'))
  })

  it('blindIndex läcker inte personnumret', () => {
    const idx = svc().blindIndex('199001011234')
    expect(idx).not.toContain('9001')
    expect(idx).toMatch(/^[0-9a-f]{64}$/)
  })

  it('kastar om okonfigurerat', () => {
    expect(() => svc({}).blindIndex('199001011234')).toThrow(/ej konfigurerat/i)
  })
})

describe('SigningCryptoService — läsning med två nycklar (rotationsbarhet)', () => {
  const NY = 'aa'.repeat(32)
  const GAMMAL = 'bb'.repeat(32)
  const TREDJE = 'cc'.repeat(32)
  const PN = '199001011234'

  /** Lyssnar på varningen så att GRENEN kan mätas, inte bara svaret. */
  function medLyssnare(env: Record<string, string>) {
    const s = svc(env)
    const varningar: string[] = []
    jest
      .spyOn((s as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation((m: string) => {
        varningar.push(m)
      })
    return { s, varningar }
  }

  /** Rad krypterad med en given nyckel, som den ligger i databasen. */
  const radMed = (key: string, pn = PN) =>
    svc({ SIGNING_PII_KEY: key, SIGNING_PII_PEPPER: PEPPER }).encrypt(pn)

  afterEach(() => jest.restoreAllMocks())

  it('utan _OLD är beteendet oförändrat: rätt nyckel läser, fel nyckel KASTAR', () => {
    const { s, varningar } = medLyssnare({ SIGNING_PII_KEY: NY, SIGNING_PII_PEPPER: PEPPER })
    expect(s.decrypt(radMed(NY))).toBe(PN)
    expect(() => s.decrypt(radMed(GAMMAL))).toThrow()
    expect(varningar).toHaveLength(0)
  })

  it('NEGATIVKONTROLL: rad med gamla nyckeln + bara nya satt → kastar', () => {
    const s = svc({ SIGNING_PII_KEY: NY, SIGNING_PII_PEPPER: PEPPER })
    expect(() => s.decrypt(radMed(GAMMAL))).toThrow()
  })

  it('med båda satta lyckas samma rad via fallbacken', () => {
    const { s, varningar } = medLyssnare({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: GAMMAL,
      SIGNING_PII_PEPPER: PEPPER,
    })
    expect(s.decrypt(radMed(GAMMAL))).toBe(PN)
    expect(varningar).toHaveLength(1)
    expect(varningar[0]).toMatch(/SIGNING_PII_KEY_OLD/)
    expect(varningar[0]).toMatch(/inte slutförd/i)
  })

  it('KANARIEFÅGEL: en rad med NYA nyckeln får inte gå via _OLD-grenen', () => {
    const { s, varningar } = medLyssnare({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: GAMMAL,
      SIGNING_PII_PEPPER: PEPPER,
    })
    expect(s.decrypt(radMed(NY))).toBe(PN)
    // Rätt svar räcker inte — fallbacken får inte ha använts.
    expect(varningar).toHaveLength(0)
  })

  it('en rad från en TREDJE nyckel kastar även med båda satta', () => {
    const { s } = medLyssnare({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: GAMMAL,
      SIGNING_PII_PEPPER: PEPPER,
    })
    expect(() => s.decrypt(radMed(TREDJE))).toThrow()
  })

  it('kastar det PRIMÄRA felet när båda nycklarna faller — aldrig null', () => {
    const utan = svc({ SIGNING_PII_KEY: NY, SIGNING_PII_PEPPER: PEPPER })
    const med = svc({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: GAMMAL,
      SIGNING_PII_PEPPER: PEPPER,
    })
    const rad = radMed(TREDJE)
    let a = ''
    let b = ''
    try {
      utan.decrypt(rad)
    } catch (e) {
      a = (e as Error).message
    }
    try {
      med.decrypt(rad)
    } catch (e) {
      b = (e as Error).message
    }
    expect(a).not.toBe('')
    expect(b).toBe(a)
  })

  it('en felformad _OLD ger ingen fallback (och tystar inte det primära felet)', () => {
    const { s, varningar } = medLyssnare({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: 'inte-hex',
      SIGNING_PII_PEPPER: PEPPER,
    })
    expect(() => s.decrypt(radMed(GAMMAL))).toThrow()
    expect(varningar).toHaveLength(0)
  })

  it('_OLD påverkar varken configured, encrypt eller blindIndex', () => {
    const utan = svc({ SIGNING_PII_KEY: NY, SIGNING_PII_PEPPER: PEPPER })
    const med = svc({
      SIGNING_PII_KEY: NY,
      SIGNING_PII_KEY_OLD: GAMMAL,
      SIGNING_PII_PEPPER: PEPPER,
    })
    expect(med.configured).toBe(utan.configured)
    expect(med.blindIndex(PN)).toBe(utan.blindIndex(PN))
    // encrypt ska alltid använda den AKTUELLA nyckeln.
    expect(utan.decrypt(med.encrypt(PN))).toBe(PN)
  })

  it('_OLD ensam (utan SIGNING_PII_KEY) gör inte tjänsten konfigurerad', () => {
    expect(svc({ SIGNING_PII_KEY_OLD: GAMMAL, SIGNING_PII_PEPPER: PEPPER }).configured).toBe(false)
  })
})
