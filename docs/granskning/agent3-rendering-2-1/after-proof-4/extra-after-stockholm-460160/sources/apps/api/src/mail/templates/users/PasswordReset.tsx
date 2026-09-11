import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface PasswordResetProps {
  /** Användarens namn (förnamn + efternamn). */
  recipientName: string
  /** Färdig URL till `/reset-password?token=...`. */
  resetUrl: string
  /** Organisationsnamn som visas i header/footer. */
  organizationName: string
  /** Hur länge länken är giltig (default 1h). */
  validForHours?: number
}

export function PasswordReset({
  recipientName,
  resetUrl,
  organizationName,
  validForHours = 1,
}: PasswordResetProps) {
  return (
    <EmailLayout
      preview={`Återställ ditt lösenord till ${organizationName}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom någon — troligen du — begärde att återställa lösenordet för detta konto. Om det inte var du kan du ignorera mailet."
    >
      <Heading as="h2" style={h2Style}>
        Återställ ditt lösenord
      </Heading>

      <Text style={textStyle}>Hej {recipientName},</Text>

      <Text style={textStyle}>
        Vi tog emot en begäran om att återställa lösenordet till ditt konto hos{' '}
        <strong>{organizationName}</strong>. Klicka på knappen nedan för att välja ett nytt
        lösenord. Länken är giltig i {validForHours} timme och kan bara användas en gång.
      </Text>

      <Section style={ctaSection}>
        <Button href={resetUrl} style={buttonStyle}>
          Välj nytt lösenord
        </Button>
      </Section>

      <Text style={hintStyle}>
        Om knappen inte fungerar — kopiera länken nedan och klistra in i din webbläsare:
      </Text>
      <Text style={urlStyle}>{resetUrl}</Text>

      <Text style={securityStyle}>
        Begärde du inte denna återställning? Då kan du bortse från detta mail. Ditt nuvarande
        lösenord fortsätter gälla — utan att klicka på länken händer ingenting.
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
  backgroundColor: '#2563EB',
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
  color: '#2563EB',
  fontSize: '12px',
  fontFamily: 'monospace',
  wordBreak: 'break-all',
  margin: '0 0 24px',
  padding: '12px 16px',
  backgroundColor: '#F3F4F6',
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
