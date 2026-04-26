import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'
import { formatSek, formatDate } from '../shared/format'

export interface InvoiceReminderProps {
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
}

export function InvoiceReminder({
  tenantName,
  invoiceNumber,
  total,
  dueDate,
  organizationName,
}: InvoiceReminderProps) {
  return (
    <EmailLayout
      preview={`Påminnelse — faktura ${invoiceNumber} förfaller snart`}
      organizationName={organizationName}
      whyReceived="Du får detta mail som vänlig påminnelse om en faktura som snart förfaller."
    >
      <Section style={badgeWrap}>
        <Text style={badgeStyle}>Påminnelse</Text>
      </Section>

      <Heading as="h2" style={h2Style}>
        Faktura {invoiceNumber} förfaller snart
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Vi vill påminna om att faktura <strong>{invoiceNumber}</strong> på{' '}
        <strong>{formatSek(total)}</strong> förfaller <strong>{formatDate(dueDate)}</strong>.
      </Text>

      <Text style={textStyle}>
        Om du redan betalat — bortse från detta meddelande. Annars: tack för att du betalar i tid.
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

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
