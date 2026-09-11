import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'
import { formatSek, formatDate } from '../shared/format'

export interface ReminderFriendlyProps {
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  daysOverdue: number
  organizationName: string
  ocrNumber?: string | null
  bankgiro?: string | null
}

export function ReminderFriendly({
  tenantName,
  invoiceNumber,
  total,
  dueDate,
  daysOverdue,
  organizationName,
  ocrNumber,
  bankgiro,
}: ReminderFriendlyProps) {
  return (
    <EmailLayout
      preview={`Vänlig påminnelse — faktura ${invoiceNumber}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail som vänlig påminnelse om en faktura som passerat förfallodatum."
    >
      <Section style={badgeWrap}>
        <Text style={badgeStyle}>Vänlig påminnelse</Text>
      </Section>

      <Heading as="h2" style={h2Style}>
        Hej {tenantName} 👋
      </Heading>

      <Text style={textStyle}>
        Vi vill bara påminna om att faktura <strong>{invoiceNumber}</strong> på{' '}
        <strong>{formatSek(total)}</strong> förföll <strong>{formatDate(dueDate)}</strong>
        {daysOverdue > 0 ? ` (${daysOverdue} dagar sedan)` : ''}.
      </Text>

      <Text style={textStyle}>
        Om betalningen redan är på väg — bortse från detta meddelande. Annars: vi tar inte ut någon
        avgift för denna påminnelse.
      </Text>

      {(ocrNumber || bankgiro) && (
        <Section style={paymentBox}>
          {bankgiro && (
            <Text style={paymentLine}>
              <span style={paymentLabel}>Bankgiro:</span> <strong>{bankgiro}</strong>
            </Text>
          )}
          {ocrNumber && (
            <Text style={paymentLine}>
              <span style={paymentLabel}>OCR-nummer:</span> <strong>{ocrNumber}</strong>
            </Text>
          )}
          <Text style={paymentLine}>
            <span style={paymentLabel}>Att betala:</span> <strong>{formatSek(total)}</strong>
          </Text>
        </Section>
      )}

      <Text style={textStyle}>
        Om du har frågor eller behöver komma överens om en avbetalningsplan, hör gärna av dig — vi
        hjälper dig så gott vi kan.
      </Text>

      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

const badgeWrap: React.CSSProperties = { margin: '0 0 12px' }

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: '#FEF3C7',
  color: '#92400E',
  fontSize: '12px',
  fontWeight: 600,
  padding: '4px 12px',
  borderRadius: '9999px',
  margin: 0,
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

const paymentBox: React.CSSProperties = {
  background: '#F9FAFB',
  border: '1px solid #E5E7EB',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '16px 0',
}

const paymentLine: React.CSSProperties = {
  margin: '4px 0',
  fontSize: '14px',
  color: '#374151',
}

const paymentLabel: React.CSSProperties = {
  color: '#6B7280',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
