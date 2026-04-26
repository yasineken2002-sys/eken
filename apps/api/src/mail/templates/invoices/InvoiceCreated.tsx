import { Heading, Row, Column, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'
import { formatSek, formatDate } from '../shared/format'

export interface InvoiceCreatedProps {
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
  /** Eventuell URL till PDF:en (om mailet skickas utan bilaga). */
  pdfUrl?: string
}

export function InvoiceCreated({
  tenantName,
  invoiceNumber,
  total,
  dueDate,
  organizationName,
}: InvoiceCreatedProps) {
  return (
    <EmailLayout
      preview={`Faktura ${invoiceNumber} — ${formatSek(total)} förfaller ${formatDate(dueDate)}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom du är registrerad som hyresgäst hos oss."
    >
      <Heading as="h2" style={h2Style}>
        Ny faktura
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Bifogat hittar du faktura <strong>{invoiceNumber}</strong>. Sammanfattning nedan.
      </Text>

      <Section style={detailBox}>
        <Row>
          <Column style={labelCol}>
            <Text style={labelText}>Fakturanummer</Text>
          </Column>
          <Column style={valueCol}>
            <Text style={valueText}>{invoiceNumber}</Text>
          </Column>
        </Row>
        <Row>
          <Column style={labelCol}>
            <Text style={labelText}>Belopp</Text>
          </Column>
          <Column style={valueCol}>
            <Text style={amountText}>{formatSek(total)}</Text>
          </Column>
        </Row>
        <Row>
          <Column style={labelCol}>
            <Text style={labelText}>Förfaller</Text>
          </Column>
          <Column style={valueCol}>
            <Text style={valueText}>{formatDate(dueDate)}</Text>
          </Column>
        </Row>
      </Section>

      <Text style={textStyle}>Vänligen betala senast {formatDate(dueDate)}.</Text>
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

const labelCol: React.CSSProperties = {
  width: '40%',
  paddingRight: '16px',
}

const valueCol: React.CSSProperties = {
  textAlign: 'right',
}

const labelText: React.CSSProperties = {
  color: '#6B7280',
  fontSize: '13px',
  margin: '6px 0',
}

const valueText: React.CSSProperties = {
  color: '#111827',
  fontSize: '14px',
  fontWeight: 600,
  margin: '6px 0',
  textAlign: 'right',
}

const amountText: React.CSSProperties = {
  color: '#2D6A4F',
  fontSize: '18px',
  fontWeight: 700,
  margin: '6px 0',
  textAlign: 'right',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
