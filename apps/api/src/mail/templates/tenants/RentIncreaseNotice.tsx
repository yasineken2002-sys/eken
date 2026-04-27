import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface RentIncreaseNoticeProps {
  tenantName: string
  organizationName: string
  unitAddress?: string
  currentRent: number
  newRent: number
  increasePercent: number
  effectiveDate: string
  reason: string
  contactEmail?: string
  contactPhone?: string
}

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

export function RentIncreaseNotice({
  tenantName,
  organizationName,
  unitAddress,
  currentRent,
  newRent,
  increasePercent,
  effectiveDate,
  reason,
  contactEmail,
  contactPhone,
}: RentIncreaseNoticeProps) {
  const increase = newRent - currentRent
  return (
    <EmailLayout
      preview={`Meddelande om hyreshöjning från ${effectiveDate}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom du har ett aktivt hyresavtal hos oss."
    >
      <Heading as="h2" style={h2Style}>
        Meddelande om hyreshöjning
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>

      <Text style={textStyle}>
        Vi vill härmed informera dig om en kommande hyreshöjning för din bostad
        {unitAddress ? <strong> ({unitAddress})</strong> : null}.
      </Text>

      <Section style={detailBox}>
        <Row label="Nuvarande hyra" value={`${formatSek(currentRent)}/mån`} />
        <Row
          label="Höjning"
          value={`+${formatSek(increase)}/mån (${increasePercent.toFixed(2)}%)`}
        />
        <Row label="Ny hyra" value={`${formatSek(newRent)}/mån`} bold />
        <Row label="Gäller från" value={effectiveDate} />
      </Section>

      <Section style={reasonBox}>
        <Text style={labelText}>Anledning</Text>
        <Text style={reasonText}>{reason}</Text>
      </Section>

      <Text style={textStyle}>
        Enligt svensk hyresrätt har du som hyresgäst rätt att överklaga en hyreshöjning. Om vi inte
        kommer överens kan ärendet hänskjutas till <strong>Hyresnämnden</strong> för prövning.
      </Text>

      <Text style={textStyle}>
        Vill du godkänna den nya hyran direkt eller har du frågor är du varmt välkommen att kontakta
        oss
        {contactEmail ? (
          <>
            {' '}
            på <strong>{contactEmail}</strong>
          </>
        ) : null}
        {contactPhone ? (
          <>
            {' '}
            eller telefon <strong>{contactPhone}</strong>
          </>
        ) : null}
        .
      </Text>

      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
      <Text style={rowLabel}>{label}</Text>
      <Text style={bold ? rowValueBold : rowValue}>{value}</Text>
    </div>
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
  padding: '16px 24px',
  margin: '24px 0',
  border: '1px solid #E5E7EB',
}

const reasonBox: React.CSSProperties = {
  backgroundColor: '#FEFCE8',
  borderRadius: '8px',
  padding: '16px 20px',
  margin: '0 0 24px',
  border: '1px solid #FDE68A',
}

const labelText: React.CSSProperties = {
  color: '#6B7280',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  margin: '0 0 6px',
  fontWeight: 700,
}

const reasonText: React.CSSProperties = {
  color: '#92400E',
  fontSize: '14px',
  margin: '0',
  lineHeight: '1.5',
}

const rowLabel: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  margin: '0',
}

const rowValue: React.CSSProperties = {
  color: '#111827',
  fontSize: '14px',
  fontWeight: 600,
  margin: '0',
}

const rowValueBold: React.CSSProperties = {
  color: '#111827',
  fontSize: '15px',
  fontWeight: 700,
  margin: '0',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
