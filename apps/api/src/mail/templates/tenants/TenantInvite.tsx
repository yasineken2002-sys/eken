import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface TenantInviteProps {
  tenantName: string
  organizationName: string
  /** Färdig URL till `/auth/verify?token=...` med 7-dagars TTL. */
  magicUrl: string
}

export function TenantInvite({ tenantName, organizationName, magicUrl }: TenantInviteProps) {
  return (
    <EmailLayout
      preview={`Du är inbjuden till hyresgästportalen hos ${organizationName}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom din hyresvärd har skapat ett portalkonto åt dig."
    >
      <Heading as="h2" style={h2Style}>
        Välkommen till hyresgästportalen
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Din hyresvärd <strong>{organizationName}</strong> har skapat ett konto åt dig i
        hyresgästportalen Eveno.
      </Text>

      <Section style={ctaSection}>
        <Button href={magicUrl} style={buttonStyle}>
          Logga in på portalen
        </Button>
      </Section>

      <Text style={textStyle}>I portalen kan du:</Text>

      <Section style={listBox}>
        <Text style={listItem}>· Se dina hyresavier och fakturor</Text>
        <Text style={listItem}>· Anmäla fel i din lägenhet</Text>
        <Text style={listItem}>· Läsa nyheter från din hyresvärd</Text>
        <Text style={listItem}>· Ladda ner ditt hyreskontrakt</Text>
      </Section>

      <Text style={hintStyle}>
        Länken är giltig i 7 dagar och kan bara användas en gång. Klistra in URL:en nedan om knappen
        inte fungerar:
      </Text>
      <Text style={urlStyle}>{magicUrl}</Text>
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
  margin: '24px 0',
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

const listBox: React.CSSProperties = {
  margin: '8px 0 24px',
  padding: '0 8px',
}

const listItem: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.8',
  margin: 0,
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
  margin: '0 0 8px',
  padding: '12px 16px',
  backgroundColor: '#F4F6F4',
  borderRadius: '6px',
  border: '1px solid #E5E7EB',
}
