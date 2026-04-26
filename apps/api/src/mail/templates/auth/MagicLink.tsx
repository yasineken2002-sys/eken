import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface MagicLinkProps {
  /** Hyresgästens visningsnamn (förnamn eller företagsnamn). */
  tenantName: string
  /** Färdig URL till `/auth/verify?token=...`. */
  magicUrl: string
  /** Organisationsnamn som visas i header/footer. */
  organizationName: string
  /** Hur länge länken är giltig (default 24h). */
  validForHours?: number
}

export function MagicLink({
  tenantName,
  magicUrl,
  organizationName,
  validForHours = 24,
}: MagicLinkProps) {
  return (
    <EmailLayout
      preview={`Logga in på din hyresgästportal hos ${organizationName}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom någon — troligen du — begärde en inloggningslänk till hyresgästportalen för denna e-postadress."
    >
      <Heading as="h2" style={h2Style}>
        Logga in på portalen
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>

      <Text style={textStyle}>
        Klicka på knappen nedan för att logga in på hyresgästportalen. Länken är giltig i{' '}
        {validForHours} timmar och kan bara användas en gång.
      </Text>

      <Section style={ctaSection}>
        <Button href={magicUrl} style={buttonStyle}>
          Öppna min portal
        </Button>
      </Section>

      <Text style={hintStyle}>
        Om knappen inte fungerar — kopiera länken nedan och klistra in i din webbläsare:
      </Text>
      <Text style={urlStyle}>{magicUrl}</Text>

      <Text style={securityStyle}>
        Begärde du inte denna länk? Då kan du bortse från detta mail. Ditt konto är säkert — utan
        att klicka på länken händer ingenting.
      </Text>
    </EmailLayout>
  )
}

const h2Style: React.CSSProperties = {
  color: '#111827',
  fontSize: '20px',
  fontWeight: 600,
  margin: '0 0 16px',
}

const textStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '15px',
  lineHeight: '1.6',
  margin: '0 0 16px',
}

const ctaSection: React.CSSProperties = {
  margin: '32px 0',
  textAlign: 'center',
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#2D6A4F',
  color: '#FFFFFF',
  fontSize: '15px',
  fontWeight: 600,
  textDecoration: 'none',
  padding: '14px 32px',
  borderRadius: '8px',
  display: 'inline-block',
}

const hintStyle: React.CSSProperties = {
  color: '#6B7280',
  fontSize: '13px',
  lineHeight: '1.5',
  margin: '24px 0 8px',
}

const urlStyle: React.CSSProperties = {
  color: '#2D6A4F',
  fontSize: '12px',
  fontFamily: 'monospace',
  wordBreak: 'break-all',
  margin: '0 0 24px',
  padding: '12px 16px',
  backgroundColor: '#F4F6F4',
  borderRadius: '6px',
  border: '1px solid #E5E7EB',
}

const securityStyle: React.CSSProperties = {
  color: '#9CA3AF',
  fontSize: '12px',
  lineHeight: '1.5',
  margin: '24px 0 0',
  padding: '16px',
  backgroundColor: '#F9FAFB',
  borderRadius: '6px',
  borderLeft: '3px solid #D1D5DB',
}
