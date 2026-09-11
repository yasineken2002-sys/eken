import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface UserInviteProps {
  /** Mottagarens namn (förnamn + efternamn). */
  recipientName: string
  /** Användarens roll, formaterad svenska (t.ex. "Administratör"). */
  roleLabel: string
  /** Vem som skickade inbjudan (t.ex. "Anna Andersson"). */
  invitedBy: string
  /** Färdig URL till `/accept-invite?token=...`. */
  acceptUrl: string
  /** Organisationsnamn som visas i header/footer. */
  organizationName: string
  /** Hur länge länken är giltig (default 7 dagar). */
  validForDays?: number
}

export function UserInvite({
  recipientName,
  roleLabel,
  invitedBy,
  acceptUrl,
  organizationName,
  validForDays = 7,
}: UserInviteProps) {
  return (
    <EmailLayout
      preview={`Du har blivit inbjuden till ${organizationName}`}
      organizationName={organizationName}
      whyReceived={`Du får detta mail eftersom ${invitedBy} har bjudit in dig som användare i ${organizationName} på Eveno.`}
    >
      <Heading as="h2" style={h2Style}>
        Välkommen till {organizationName}
      </Heading>

      <Text style={textStyle}>Hej {recipientName},</Text>

      <Text style={textStyle}>
        <strong>{invitedBy}</strong> har bjudit in dig som <strong>{roleLabel}</strong> i{' '}
        {organizationName} på Eveno — fastighetssystemet som hanterar hela portföljen, från
        hyresavtal till bokföring.
      </Text>

      <Text style={textStyle}>
        Klicka på knappen nedan för att aktivera ditt konto och välja ditt lösenord. Länken är
        giltig i {validForDays} dagar.
      </Text>

      <Section style={ctaSection}>
        <Button href={acceptUrl} style={buttonStyle}>
          Aktivera mitt konto
        </Button>
      </Section>

      <Text style={hintStyle}>
        Om knappen inte fungerar — kopiera länken nedan och klistra in i din webbläsare:
      </Text>
      <Text style={urlStyle}>{acceptUrl}</Text>

      <Text style={securityStyle}>
        Förväntade du dig inte denna inbjudan? Då kan du bortse från detta mail. Inget händer förrän
        du klickar på länken och sätter ett lösenord.
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
