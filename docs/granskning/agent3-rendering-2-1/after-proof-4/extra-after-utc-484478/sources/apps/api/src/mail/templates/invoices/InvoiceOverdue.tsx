import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'
import { formatSek, formatDate } from '../shared/format'

export interface InvoiceOverdueProps {
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
}

export function InvoiceOverdue({
  tenantName,
  invoiceNumber,
  total,
  dueDate,
  organizationName,
}: InvoiceOverdueProps) {
  return (
    <EmailLayout
      preview={`Förfallen faktura ${invoiceNumber} — vänligen betala omgående`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom en faktura registrerad på dig har förfallit."
    >
      <Section style={badgeWrap}>
        <Text style={badgeStyle}>Förfallen</Text>
      </Section>

      <Heading as="h2" style={h2Style}>
        Obetald faktura
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Faktura <strong>{invoiceNumber}</strong> förföll <strong>{formatDate(dueDate)}</strong> och
        är ännu inte betald.
      </Text>

      <Text style={amountStyle}>{formatSek(total)}</Text>

      <Text style={textStyle}>
        Vänligen betala det utestående beloppet snarast. Kontakta oss om du har frågor eller behöver
        en avbetalningsplan — vi hjälper dig gärna.
      </Text>

      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

const badgeWrap: React.CSSProperties = {
  margin: '0 0 12px',
}

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: '#FEE2E2',
  color: '#B91C1C',
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

const amountStyle: React.CSSProperties = {
  color: '#B91C1C',
  fontSize: '32px',
  fontWeight: 700,
  margin: '24px 0',
  textAlign: 'center',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
