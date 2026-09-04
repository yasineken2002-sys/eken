import * as crypto from 'node:crypto'
import { JwtService } from '@nestjs/jwt'

import { CHOOSE_TOKEN_TTL_MS, signChooseToken, verifyChooseToken } from './bankid-choose-token'

const HEMLIGHET = 'x'.repeat(48)
const NU = new Date('2026-09-04T12:00:00Z')

describe('väljar-token — signering och verifiering', () => {
  it('rundtur: det som signerades kommer ut', () => {
    const t = signChooseToken({ orderRef: 'o1', subjectHash: 'h1' }, HEMLIGHET, NU)
    expect(verifyChooseToken(t, HEMLIGHET, NU)).toEqual({
      orderRef: 'o1',
      subjectHash: 'h1',
      exp: NU.getTime() + CHOOSE_TOKEN_TTL_MS,
    })
  })

  it('utgången → null', () => {
    const t = signChooseToken({ orderRef: 'o1', subjectHash: 'h1' }, HEMLIGHET, NU)
    const efter = new Date(NU.getTime() + CHOOSE_TOKEN_TTL_MS + 1)
    expect(verifyChooseToken(t, HEMLIGHET, efter)).toBeNull()
  })

  it('annan hemlighet → null', () => {
    const t = signChooseToken({ orderRef: 'o1', subjectHash: 'h1' }, HEMLIGHET, NU)
    expect(verifyChooseToken(t, 'y'.repeat(48), NU)).toBeNull()
  })

  it('manipulerad payload → null (signaturen täcker den)', () => {
    const t = signChooseToken({ orderRef: 'o1', subjectHash: 'h1' }, HEMLIGHET, NU)
    const [p, body, sig] = t.split('.') as [string, string, string]
    const ny = Buffer.from(
      JSON.stringify({ orderRef: 'o2', subjectHash: 'h1', exp: NU.getTime() + 60_000 }),
    ).toString('base64url')
    expect(verifyChooseToken(`${p}.${ny}.${sig}`, HEMLIGHET, NU)).toBeNull()
    expect(body).not.toBe(ny)
  })

  it('skräpformer → null, aldrig kast', () => {
    for (const t of ['', 'abc', 'v1.abc', 'v2.a.b', 'a.b.c', 'v1..', 'v1.a.b.c']) {
      expect(verifyChooseToken(t, HEMLIGHET, NU)).toBeNull()
    }
  })
})

/**
 * ── DEN AVGÖRANDE FRÅGAN: KAN DEN ANVÄNDAS SOM ACCESS-TOKEN? ──────────────
 *
 * Ett kontoval sker EFTER identifieringen men INNAN någon session finns. Om
 * token råkade fungera som Bearer vore hela flödet kringgånget: den som
 * identifierat sig hade fått en session utan att välja konto, och utan att
 * systemet vet vilken organisation hen agerar i.
 */
describe('väljar-token är INTE en access-token', () => {
  const t = signChooseToken({ orderRef: 'o1', subjectHash: 'h1' }, HEMLIGHET, NU)

  it('1. FORMEN: den är inget JWT — JwtService avvisar den vid parsningen', () => {
    // Prefixet `v1.` är inget JOSE-huvud. `@nestjs/jwt` och `passport-jwt`
    // använder samma underliggande verifiering och faller på samma ställe,
    // FÖRE signaturkontrollen — alltså oavsett vilken nyckel som används.
    const jwtService = new JwtService({ secret: HEMLIGHET })
    expect(() => jwtService.verify(t)).toThrow()
    expect(jwtService.decode(t)).toBeNull()

    // Strukturellt: ett JWT:s första segment är base64url av ett JSON-huvud med
    // `alg`. Vårt första segment är literalen `v1`.
    const första = t.split('.')[0] as string
    expect(första).toBe('v1')
    expect(() => JSON.parse(Buffer.from(första, 'base64url').toString('utf8'))).toThrow()
  })

  it('2. NYCKELN: signaturen är HMAC med en HÄRLEDD nyckel, inte JWT_SECRET', () => {
    const [, body, sig] = t.split('.') as [string, string, string]
    const härledd = crypto.createHash('sha256').update(`${HEMLIGHET}|bankid-choose-v1`).digest()

    const medHärledd = crypto.createHmac('sha256', härledd).update(body).digest('base64url')
    const medRå = crypto.createHmac('sha256', HEMLIGHET).update(body).digest('base64url')

    expect(sig).toBe(medHärledd)
    expect(sig).not.toBe(medRå)
    // En läckt väljar-token säger alltså ingenting om JWT_SECRET.
  })

  it('3. PAYLOADEN saknar det en session behöver (sub, organizationId, role)', () => {
    const p = verifyChooseToken(t, HEMLIGHET, NU)
    expect(p).not.toBeNull()
    const nycklar = Object.keys(p as object).sort()
    expect(nycklar).toEqual(['exp', 'orderRef', 'subjectHash'])
    for (const förbjuden of ['sub', 'organizationId', 'role', 'email']) {
      expect(nycklar).not.toContain(förbjuden)
    }
    // JwtStrategy.validate kastar 401 på saknad sub/organizationId — det finns
    // inget att bygga en användare av, även om formen hade accepterats.
  })

  it('4. LIVSLÄNGDEN är två minuter, inte femton', () => {
    expect(CHOOSE_TOKEN_TTL_MS).toBe(2 * 60 * 1000)
  })
})
