import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { EmailLayout } from '../base/EmailLayout'

/**
 * Neutral portal-inbjudan för massutskick. Till skillnad från
 * TenantWelcomeWithContract nämner den INTE kontraktssignering — importerade
 * hyresgäster saknar ofta en kontrakts-PDF. Länken pekar på aktiveringsflödet
 * (välj lösenord), samma token-mekanik som välkomstmejlet.
 */
export interface TenantPortalInviteProps {
  tenantName: string
  organizationName: string
  /** Färdig aktiveringslänk `${PORTAL_URL}/activate?token=...`. */
  activationUrl: string
  /** Hur länge länken är giltig (timmar). Default 72. */
  validForHours?: number
}

export function TenantPortalInvite({
  tenantName,
  organizationName,
  activationUrl,
  validForHours = 72,
}: TenantPortalInviteProps) {
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
        hyresgästportalen Eveno. Aktivera kontot och välj ett lösenord för att komma igång.
      </Text>

      <Section style={ctaSection}>
        <Button href={activationUrl} style={buttonStyle}>
          Aktivera ditt konto
        </Button>
      </Section>

      <Text style={textStyle}>I portalen kan du:</Text>

      <Section style={listBox}>
        <Text style={listItem}>· Se dina hyresavier och fakturor</Text>
        <Text style={listItem}>· Anmäla fel i din lägenhet</Text>
        <Text style={listItem}>· Läsa nyheter från din hyresvärd</Text>
        <Text style={listItem}>· Ladda ner dina dokument</Text>
      </Section>

      <Text style={hintStyle}>
        Länken är giltig i {validForHours} timmar. Klistra in URL:en nedan om knappen inte fungerar:
      </Text>
      <Text style={urlStyle}>{activationUrl}</Text>
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
  backgroundColor: DEFAULT_BRAND_COLOR,
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
  color: DEFAULT_BRAND_COLOR,
  fontSize: '12px',
  fontFamily: 'monospace',
  wordBreak: 'break-all',
  margin: '0 0 8px',
  padding: '12px 16px',
  backgroundColor: '#F4F6F4',
  borderRadius: '6px',
  border: '1px solid #E5E7EB',
}
