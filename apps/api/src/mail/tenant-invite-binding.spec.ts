import type { MailJobPayload } from './mail.types'
import { tenantInviteTokenHash } from './tenant-invite-binding'

const TOKEN = 'a'.repeat(64)
// SHA-256 av 64 ASCII-tecken "a", inte av URL:en eller någon extra kömetadata.
const TOKEN_HASH = 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'
const PORTAL_URL = 'https://portal.example.invalid'

function legacyJob(activationUrl = `${PORTAL_URL}/activate?token=${TOKEN}`): MailJobPayload {
  return {
    template: 'tenant-portal-invite',
    props: {
      tenantName: 'Syntetisk hyresgäst',
      organizationName: 'Syntetisk hyresvärd',
      activationUrl,
      validForHours: 72,
    },
    to: 'tenant@example.invalid',
    subject: 'Aktivera ditt portalkonto',
    organizationId: 'synthetic-organization',
    correlation: { kind: 'tenant-invite', tenantId: 'synthetic-tenant' },
  }
}

describe('tenantInviteTokenHash', () => {
  it('binder befintlig köpayload utan nytt hashfält till tokenen i den faktiska länken', () => {
    const job = legacyJob()
    expect(job.correlation).toEqual({ kind: 'tenant-invite', tenantId: 'synthetic-tenant' })
    expect(tenantInviteTokenHash(job, PORTAL_URL)).toBe(TOKEN_HASH)
  })

  it.each([
    ['standardadress', 'http://localhost:5174', 'http://localhost:5174/activate'],
    ['baspath', `${PORTAL_URL}/hyresgast`, `${PORTAL_URL}/hyresgast/activate`],
    ['avslutande snedstreck', `${PORTAL_URL}/`, `${PORTAL_URL}//activate`],
  ])('bevarar buildActivationUrls sökväg med %s', (_label, portalUrl, activationPath) => {
    const job = legacyJob(`${activationPath}?token=${TOKEN}`)
    expect(tenantInviteTokenHash(job, portalUrl)).toBe(TOKEN_HASH)
  })

  it.each([
    ['userinfo', `https://name:password@portal.example.invalid/activate?token=${TOKEN}`],
    ['fragment', `${PORTAL_URL}/activate?token=${TOKEN}#annat`],
  ])('nekar %s även när origin, sökväg och token annars stämmer', (_label, activationUrl) => {
    expect(tenantInviteTokenHash(legacyJob(activationUrl), PORTAL_URL)).toBeNull()
  })

  it('nekar saknade eller feltypade props och activationUrl utan att kasta', () => {
    const invalidProps: unknown[] = [
      undefined,
      null,
      42,
      `${PORTAL_URL}/activate?token=${TOKEN}`,
      [],
      {},
      { activationUrl: 42 },
    ]
    for (const props of invalidProps) {
      expect(tenantInviteTokenHash({ ...legacyJob(), props }, PORTAL_URL)).toBeNull()
    }
  })

  it('ger ingen bindning åt orelaterade mallar trots riktig token och invite-korrelation', () => {
    for (const template of ['custom', 'password-reset', 'tenant-invite'] as const) {
      expect(tenantInviteTokenHash({ ...legacyJob(), template }, PORTAL_URL)).toBeNull()
    }
  })
})
