import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface TenantWelcomeProps {
  tenantName: string
  organizationName: string
  /** Adress för enheten hyresgästen flyttar in i. */
  unitAddress?: string
  /** Tillträdesdatum (valfritt). */
  moveInDate?: Date | string
}

export function TenantWelcome({
  tenantName,
  organizationName,
  unitAddress,
  moveInDate,
}: TenantWelcomeProps) {
  return (
    <EmailLayout
      preview={`Välkommen som hyresgäst hos ${organizationName}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom du har registrerats som hyresgäst hos oss."
    >
      <Heading as="h2" style={h2Style}>
        Välkommen!
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Vi är glada att hälsa dig välkommen som hyresgäst hos <strong>{organizationName}</strong>.
      </Text>

      {unitAddress ? (
        <Section style={detailBox}>
          <Text style={labelText}>Din enhet</Text>
          <Text style={valueText}>{unitAddress}</Text>
          {moveInDate ? (
            <>
              <Text style={labelText}>Tillträde</Text>
              <Text style={valueText}>{new Date(moveInDate).toLocaleDateString('sv-SE')}</Text>
            </>
          ) : null}
        </Section>
      ) : null}

      <Text style={textStyle}>
        Inom kort skickar vi din inloggningslänk till hyresgästportalen, där du kan se ditt
        hyresavtal, fakturor och hyresavier samt anmäla felanmälningar.
      </Text>

      <Text style={textStyle}>
        Om du har några frågor är du varmt välkommen att höra av dig till oss.
      </Text>

      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
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

const detailBox: React.CSSProperties = {
  backgroundColor: '#F9FAFB',
  borderRadius: '8px',
  padding: '20px 24px',
  margin: '24px 0',
  border: '1px solid #E5E7EB',
}

const labelText: React.CSSProperties = {
  color: '#6B7280',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 4px',
  fontWeight: 600,
}

const valueText: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 600,
  margin: '0 0 16px',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
