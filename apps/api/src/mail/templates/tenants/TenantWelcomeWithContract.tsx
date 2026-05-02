import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface TenantWelcomeWithContractProps {
  /** Hyresgästens visningsnamn (förnamn eller företagsnamn). */
  tenantName: string
  /** Organisationsnamn som visas i header/footer. */
  organizationName: string
  /** Färdig URL till `/activate?token=...`. */
  activationUrl: string
  /** Hur länge länken är giltig (default 72h). */
  validForHours?: number
}

export function TenantWelcomeWithContract({
  tenantName,
  organizationName,
  activationUrl,
  validForHours = 72,
}: TenantWelcomeWithContractProps) {
  return (
    <EmailLayout
      preview={`Välkommen till ${organizationName} — signera kontraktet och aktivera ditt konto`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom din hyresvärd har skapat ett hyreskontrakt åt dig."
    >
      <Heading as="h2" style={h2Style}>
        Välkommen till hyresgästportalen
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Din hyresvärd <strong>{organizationName}</strong> har skapat ett hyreskontrakt åt dig och
        bjudit in dig till hyresgästportalen Eveno.
      </Text>

      <Text style={textStyle}>
        Klicka på knappen nedan för att granska och signera kontraktet samt välja ditt eget
        lösenord. Därefter kan du logga in när du vill med din e-post och ditt lösenord.
      </Text>

      <Section style={ctaSection}>
        <Button href={activationUrl} style={buttonStyle}>
          Granska och signera kontraktet
        </Button>
      </Section>

      <Section style={infoBox}>
        <Text style={infoLabel}>Så går aktiveringen till</Text>
        <Text style={infoStep}>1. Granska kontraktet i webbläsaren</Text>
        <Text style={infoStep}>2. Signera digitalt med din underskrift</Text>
        <Text style={infoStep}>3. Välj ett eget lösenord</Text>
        <Text style={infoStep}>4. Klart — du loggas in direkt på portalen</Text>
      </Section>

      <Text style={hintStyle}>
        Länken är giltig i <strong>{validForHours} timmar</strong>. Om den hinner gå ut kan din
        hyresvärd skicka en ny.
      </Text>
      <Text style={urlStyle}>{activationUrl}</Text>

      <Text style={securityStyle}>
        Om du inte väntar dig detta mail kan du bortse från det. Inget händer förrän du klickar på
        länken och själv väljer ett lösenord.
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

const infoBox: React.CSSProperties = {
  backgroundColor: '#F4F6F4',
  borderRadius: '8px',
  border: '1px solid #E5E7EB',
  padding: '20px 24px',
  margin: '24px 0',
}

const infoLabel: React.CSSProperties = {
  color: '#2D6A4F',
  fontSize: '12px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 12px',
}

const infoStep: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '0 0 6px',
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
