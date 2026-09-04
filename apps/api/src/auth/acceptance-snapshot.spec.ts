import { acceptansSnapshot } from './auth.service'
import { LEGAL_DOCUMENT_HASHES, CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '@eken/shared'

/**
 * #577 — ACCEPTANSRADEN SKA BÄRA VILKEN TEXT, INTE BARA VILKET NUMMER.
 *
 * `termsVersion` säger vilket NUMMER kunden godkände. En redaktionell ändring
 * är tillåten utan versionsbump (regeln står i platform.ts), och då betecknar
 * samma nummer två olika texter — varpå frågan inte går att besvara i
 * efterhand. Hashen fanns i manifestet hela tiden; den skrevs bara aldrig ner.
 *
 * Integritetspolicyn journalfördes inte alls, trots att registreringsrutan
 * säger "Användarvillkor OCH Integritetspolicy".
 */
describe('acceptansSnapshot — vad som fryses i raden', () => {
  it('tar version OCH hash ur manifestet, för BÅDA dokumenten', () => {
    const s = acceptansSnapshot(new Date('2026-09-04T12:00:00.000Z'))

    expect(s.termsVersion).toBe(LEGAL_DOCUMENT_HASHES.terms.version)
    expect(s.termsHash).toBe(LEGAL_DOCUMENT_HASHES.terms.sha256)
    expect(s.privacyVersion).toBe(LEGAL_DOCUMENT_HASHES.privacy.version)
    expect(s.privacyHash).toBe(LEGAL_DOCUMENT_HASHES.privacy.sha256)
  })

  it('hasharna är riktiga sha256, inte platshållare', () => {
    // Motprov mot att fälten fylls med tom sträng eller undefined och att
    // provet ovan då jämför två tomheter med varandra.
    for (const h of [s().termsHash, s().privacyHash]) {
      expect(h).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('versionerna är samma som de publika konstanterna', () => {
    // Manifestet och LEGAL_DOCUMENT_VERSIONS måste vara i synk — vakten
    // check-legal-text-version kräver det. Provet fångar om acceptansraden
    // skulle börja läsa ur den ena medan sidorna visar den andra.
    expect(s().termsVersion).toBe(CURRENT_TERMS_VERSION)
    expect(s().privacyVersion).toBe(CURRENT_PRIVACY_VERSION)
  })

  it('bär den tidpunkt anroparen gav — inte en egen', () => {
    // Registreringen skriver två rader. Får de olika tidsstämplar ser en
    // revision ut som två acceptanser.
    const nu = new Date('2026-01-02T03:04:05.000Z')
    expect(acceptansSnapshot(nu).nu).toBe(nu)
  })

  it('returnerar PRIMITIVER, inte en vy mot konstanten', () => {
    // Frysningen vilar på att värdena är kopior. Vore något en getter mot
    // LEGAL_DOCUMENT_HASHES hade raden följt med när manifestet ändras.
    const snap = acceptansSnapshot(new Date())
    for (const nyckel of ['termsVersion', 'termsHash', 'privacyVersion', 'privacyHash'] as const) {
      const d = Object.getOwnPropertyDescriptor(snap, nyckel)
      expect(d?.get).toBeUndefined()
      expect(typeof snap[nyckel]).toBe('string')
    }
  })
})

function s() {
  return acceptansSnapshot(new Date())
}

/**
 * SKRIVVÄGEN. Snapshoten är värdelös om den inte når raden — och det är fyra
 * skrivningar (Organization och User, vid registrering och vid re-acceptance).
 * Provet mäter `acceptTerms`, där båda raderna skrivs i en transaktion.
 */
describe('acceptTerms — vad som faktiskt skrivs till raden', () => {
  it('skriver version OCH hash för BÅDA dokumenten, på både User och Organization', async () => {
    const skrivningar: Array<Record<string, unknown>> = []
    const fånga = { update: (a: { data: Record<string, unknown> }) => skrivningar.push(a.data) }
    const prisma = {
      user: fånga,
      organization: fånga,
      $transaction: (ops: unknown[]) => Promise.resolve(ops),
    }

    // Bara prisma används av acceptTerms; övriga beroenden rörs inte.
    const { AuthService } = await import('./auth.service')
    const tjänst = Object.create(AuthService.prototype) as {
      prisma: unknown
      acceptTerms: (u: string, o: string, v: string) => Promise<unknown>
    }
    tjänst.prisma = prisma

    await tjänst.acceptTerms('u-1', 'o-1', CURRENT_TERMS_VERSION)

    expect(skrivningar).toHaveLength(2)
    for (const rad of skrivningar) {
      expect(rad['termsVersion']).toBe(LEGAL_DOCUMENT_HASHES.terms.version)
      expect(rad['termsHash']).toBe(LEGAL_DOCUMENT_HASHES.terms.sha256)
      expect(rad['privacyVersion']).toBe(LEGAL_DOCUMENT_HASHES.privacy.version)
      expect(rad['privacyHash']).toBe(LEGAL_DOCUMENT_HASHES.privacy.sha256)
    }
  })

  it('ger båda raderna SAMMA tidpunkt', () => {
    // Två skrivningar med var sitt `new Date()` ser i en revision ut som två
    // acceptanser. Snapshoten bär tidpunkten just därför.
    const nu = new Date()
    const a = acceptansSnapshot(nu)
    const b = acceptansSnapshot(nu)
    expect(a.nu).toBe(b.nu)
  })
})
