import { createHash } from 'node:crypto'
import type { MailJobPayload } from './mail.types'

/** Bind även äldre köjobb till den faktiska länken, utan ett nytt payloadfält. */
export function tenantInviteTokenHash(job: MailJobPayload, portalUrl: string): string | null {
  if (job.template !== 'tenant-portal-invite' || job.correlation?.kind !== 'tenant-invite') {
    return null
  }
  const props = job.props
  if (
    !props ||
    typeof props !== 'object' ||
    Array.isArray(props) ||
    !('activationUrl' in props) ||
    typeof props.activationUrl !== 'string'
  )
    return null

  try {
    // Samma URL-konstruktion som TenantAuthService.buildActivationUrl, även
    // för en konfigurerad baspath. Bara den avsedda portalens länk får skickas.
    const expected = new URL(`${portalUrl}/activate`)
    const actual = new URL(props.activationUrl)
    const tokens = actual.searchParams.getAll('token')
    if (
      !['https:', 'http:'].includes(expected.protocol) ||
      actual.origin !== expected.origin ||
      actual.pathname !== expected.pathname ||
      actual.username ||
      actual.password ||
      actual.hash ||
      tokens.length !== 1 ||
      [...actual.searchParams].length !== 1 ||
      !/^[0-9a-f]{64}$/.test(tokens[0]!)
    )
      return null
    return createHash('sha256').update(tokens[0]!).digest('hex')
  } catch {
    return null
  }
}
