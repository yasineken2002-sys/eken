import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { EmailLayout } from '../base/EmailLayout'

export interface TenantActivationReminderProps {
  /** Hyresgästens visningsnamn (förnamn eller företagsnamn). */
  tenantName: string
  /** Organisationsnamn som visas i header/footer. */
  organizationName: string
  /** Färdig URL till `/activate?token=...` (ny token utfärdad av cron). */
  activationUrl: string
  /** Hur länge den nya länken är giltig. Default 72 h (full TTL). */
  validForHours?: number
}

export function TenantActivationReminder({
  tenantName,
  organizationName,
  activationUrl,
  validForHours = 72,
}: TenantActivationReminderProps) {
  return (
    <EmailLayout
      preview={`Påminnelse: aktivera ditt hyreskonto hos ${organizationName}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom din aktiveringslänk inte använts än."
    >
      <Heading as="h2" style={h2Style}>
        Påminnelse: aktivera ditt hyreskonto
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Vi skickade en aktiveringslänk för ditt hyreskonto hos <strong>{organizationName}</strong>{' '}
        men ser att du inte hunnit använda den än.
      </Text>
      <Text style={textStyle}>
        Klicka på knappen nedan för att granska och signera kontraktet samt välja ditt eget
        lösenord. Det tar ungefär en minut.
      </Text>

      <Section style={ctaSection}>
        <Button href={activationUrl} style={buttonStyle}>
          Aktivera kontot nu
        </Button>
      </Section>

      <Text style={hintStyle}>
        Den nya länken är giltig i <strong>{validForHours} timmar</strong>. Tidigare länk fungerar
        inte längre — använd alltid den senaste.
      </Text>
      <Text style={urlStyle}>{activationUrl}</Text>

      <Text style={securityStyle}>
        Om du inte vill aktivera kontot kan du bortse från detta mail. Inget händer förrän du själv
        klickar på länken och väljer ett lösenord.
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
  backgroundColor: DEFAULT_BRAND_COLOR,
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
  color: DEFAULT_BRAND_COLOR,
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
