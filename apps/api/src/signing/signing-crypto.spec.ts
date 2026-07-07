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
