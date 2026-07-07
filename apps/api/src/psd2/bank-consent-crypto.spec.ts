import { BankConsentCryptoService } from './bank-consent-crypto.service'

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const make = (key?: string) => new BankConsentCryptoService({ get: () => key } as never)

describe('BankConsentCryptoService', () => {
  it('krypterar och dekrypterar tur och retur (AES-256-GCM)', () => {
    const svc = make(KEY)
    const token = 'access-token-hemlig-xyz'
    const enc = svc.encrypt(token)
    expect(enc).not.toContain(token) // chiffertext, inte klartext
    expect(svc.decrypt(enc)).toBe(token)
  })

  it('ger olika chiffertext varje gång (slumpad IV)', () => {
    const svc = make(KEY)
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'))
  })

  it('manipulerad chiffertext förkastas (authTag)', () => {
    const svc = make(KEY)
    const enc = svc.encrypt('token')
    const tampered = Buffer.from(enc, 'base64')
    const i = tampered.length - 1
    tampered[i] = tampered[i]! ^ 0x01
    expect(() => svc.decrypt(tampered.toString('base64'))).toThrow()
  })

  it('utan giltig nyckel: configured=false och encrypt kastar', () => {
    const svc = make(undefined)
    expect(svc.configured).toBe(false)
    expect(() => svc.encrypt('x')).toThrow(/PSD2_TOKEN_KEY/)
  })
})
