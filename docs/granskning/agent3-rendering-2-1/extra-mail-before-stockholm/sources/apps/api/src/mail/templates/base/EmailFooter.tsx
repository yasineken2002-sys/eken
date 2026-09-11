import { Hr, Section, Text } from '@react-email/components'
import * as React from 'react'

export interface EmailFooterProps {
  organizationName: string
  /** Förklaring av varför mottagaren får detta mail (transactional, ingen unsubscribe-länk). */
  whyReceived?: string
}

export function EmailFooter({ organizationName, whyReceived }: EmailFooterProps) {
  return (
    <Section style={footerStyle}>
      <Hr style={hrStyle} />

      {whyReceived ? <Text style={whyStyle}>{whyReceived}</Text> : null}

      <Text style={addressStyle}>
        <strong>{organizationName}</strong>
      </Text>

      <Text style={legalStyle}>
        Detta är ett transaktionsmail. Svara inte direkt på detta meddelande.
      </Text>

      <Text style={poweredStyle}>Skickat via Eveno — fastighetssystem för proffs</Text>
    </Section>
  )
}

const footerStyle: React.CSSProperties = {
  padding: '24px 40px 32px',
  backgroundColor: '#FAFBFA',
}

const hrStyle: React.CSSProperties = {
  border: 'none',
  borderTop: '1px solid #E5E7EB',
  margin: '0 0 24px',
}

const whyStyle: React.CSSProperties = {
  color: '#6B7280',
  fontSize: '12px',
  lineHeight: '1.5',
  margin: '0 0 16px',
}

const addressStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '13px',
  fontWeight: 600,
  margin: '0 0 8px',
}

const legalStyle: React.CSSProperties = {
  color: '#9CA3AF',
  fontSize: '11px',
  lineHeight: '1.5',
  margin: '0 0 12px',
}

const poweredStyle: React.CSSProperties = {
  color: '#9CA3AF',
  fontSize: '11px',
  margin: 0,
}
