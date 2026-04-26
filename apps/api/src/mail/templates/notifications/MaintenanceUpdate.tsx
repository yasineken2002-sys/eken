import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export type MaintenanceStatusLabel =
  | 'Mottagen'
  | 'Pågående'
  | 'Schemalagd'
  | 'Avslutad'
  | 'Stängd'
  | 'Avbruten'

export interface MaintenanceUpdateProps {
  tenantName: string
  organizationName: string
  /** Människovänligt ärendenummer (t.ex. M-2026-0042). */
  ticketNumber: string
  ticketTitle: string
  newStatus: MaintenanceStatusLabel
  /** Senaste kommentaren från hyresvärden, om någon. */
  comment?: string
  /** Direktlänk till ärendet i portalen. */
  portalUrl?: string
}

export function MaintenanceUpdate({
  tenantName,
  organizationName,
  ticketNumber,
  ticketTitle,
  newStatus,
  comment,
  portalUrl,
}: MaintenanceUpdateProps) {
  return (
    <EmailLayout
      preview={`Uppdatering på ärende ${ticketNumber} — ${newStatus}`}
      organizationName={organizationName}
      whyReceived="Du får detta mail eftersom du har en pågående felanmälan registrerad hos oss."
    >
      <Heading as="h2" style={h2Style}>
        Uppdatering på ditt ärende
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>Status för din felanmälan har uppdaterats.</Text>

      <Section style={detailBox}>
        <Text style={labelText}>Ärende</Text>
        <Text style={valueText}>
          {ticketNumber} — {ticketTitle}
        </Text>

        <Text style={labelText}>Ny status</Text>
        <Text style={statusValue(newStatus)}>{newStatus}</Text>
      </Section>

      {comment ? (
        <Section style={commentBox}>
          <Text style={commentLabel}>Meddelande från hyresvärden</Text>
          <Text style={commentText}>{comment}</Text>
        </Section>
      ) : null}

      {portalUrl ? (
        <Section style={ctaSection}>
          <Button href={portalUrl} style={buttonStyle}>
            Öppna ärendet i portalen
          </Button>
        </Section>
      ) : null}

      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

function statusColor(status: MaintenanceStatusLabel): string {
  switch (status) {
    case 'Avslutad':
    case 'Stängd':
      return '#15803D'
    case 'Pågående':
    case 'Schemalagd':
      return '#1D4ED8'
    case 'Avbruten':
      return '#B91C1C'
    default:
      return '#374151'
  }
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

function statusValue(status: MaintenanceStatusLabel): React.CSSProperties {
  return {
    color: statusColor(status),
    fontSize: '15px',
    fontWeight: 700,
    margin: 0,
  }
}

const commentBox: React.CSSProperties = {
  backgroundColor: '#FFFBEB',
  border: '1px solid #FCD34D',
  borderRadius: '8px',
  padding: '16px 20px',
  margin: '0 0 24px',
}

const commentLabel: React.CSSProperties = {
  color: '#92400E',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 4px',
  fontWeight: 600,
}

const commentText: React.CSSProperties = {
  color: '#451A03',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: 0,
}

const ctaSection: React.CSSProperties = {
  margin: '0 0 24px',
  textAlign: 'center',
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#2D6A4F',
  color: '#FFFFFF',
  fontSize: '14px',
  fontWeight: 600,
  textDecoration: 'none',
  padding: '12px 24px',
  borderRadius: '8px',
  display: 'inline-block',
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '0',
}
