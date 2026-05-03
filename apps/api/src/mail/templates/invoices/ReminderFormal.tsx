import { Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'
import { formatSek, formatDate } from '../shared/format'

export interface ReminderFormalProps {
  tenantName: string
  invoiceNumber: string
  originalTotal: number
  feeAmount: number
  newTotal: number
  dueDate: Date | string
  daysOverdue: number
  organizationName: string
  ocrNumber?: string | null
  bankgiro?: string | null
  collectionDay: number
}

export function ReminderFormal({
  tenantName,
  invoiceNumber,
  originalTotal,
  feeAmount,
  newTotal,
  dueDate,
  daysOverdue,
  organizationName,
  ocrNumber,
  bankgiro,
  collectionDay,
}: ReminderFormalProps) {
  return (
    <EmailLayout
      preview={`Påminnelse — faktura ${invoiceNumber} förfallen ${daysOverdue} dagar`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom en faktura registrerad på dig är förfallen."
    >
      <Section style={badgeWrap}>
        <Text style={badgeStyle}>Påminnelse — avgift tillkommer</Text>
      </Section>

      <Heading as="h2" style={h2Style}>
        Påminnelse — faktura {invoiceNumber}
      </Heading>

      <Text style={textStyle}>{tenantName},</Text>

      <Text style={textStyle}>
        Trots tidigare påminnelse är faktura <strong>{invoiceNumber}</strong> ännu inte betald. Den
        förföll <strong>{formatDate(dueDate)}</strong> ({daysOverdue} dagar sedan).
      </Text>

      <Text style={textStyle}>
        I enlighet med <strong>lag (1981:739) om ersättning för inkassokostnader</strong> har en
        påminnelseavgift på <strong>{formatSek(feeAmount)}</strong> lagts till. Det totala beloppet
        att betala är nu:
      </Text>

      <Section style={amountBox}>
        <Text style={amountStyle}>{formatSek(newTotal)}</Text>
        <Text style={amountSub}>
          (Originalbelopp {formatSek(originalTotal)} + påminnelseavgift {formatSek(feeAmount)})
        </Text>
      </Section>

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
        </Section>
      )}

      <Text style={warningStyle}>
        Om betalning inte sker inom kort kommer ärendet att lämnas över för inkassoåtgärder cirka{' '}
        {collectionDay} dagar efter förfallodatum. Då tillkommer ytterligare avgifter enligt samma
        lag.
      </Text>

      <Text style={textStyle}>
        Behöver du komma överens om en avbetalningsplan? Hör av dig så snart som möjligt så pausar
        vi vidare påminnelser.
      </Text>

      <Text style={signatureStyle}>
        Med vänlig hälsning,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

const badgeWrap: React.CSSProperties = { margin: '0 0 12px' }

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  backgroundColor: '#FEE2E2',
  color: '#991B1B',
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

const amountBox: React.CSSProperties = {
  background: '#FEF2F2',
  border: '1px solid #FCA5A5',
  borderRadius: '10px',
  padding: '20px',
  margin: '16px 0',
  textAlign: 'center',
}

const amountStyle: React.CSSProperties = {
  color: '#B91C1C',
  fontSize: '32px',
  fontWeight: 700,
  margin: 0,
}

const amountSub: React.CSSProperties = {
  color: '#7F1D1D',
  fontSize: '12px',
  margin: '6px 0 0',
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

const warningStyle: React.CSSProperties = {
  color: '#7F1D1D',
  fontSize: '14px',
  lineHeight: '1.6',
  background: '#FEF2F2',
  border: '1px solid #FECACA',
  borderRadius: '8px',
  padding: '12px 14px',
  margin: '16px 0',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
