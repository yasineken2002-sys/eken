import { Button, Heading, Section, Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from '../base/EmailLayout'

export interface TenantSignatureConfirmationProps {
  tenantName: string
  organizationName: string
  documentsUrl: string
  signedAt: string
}

export function TenantSignatureConfirmation({
  tenantName,
  organizationName,
  documentsUrl,
  signedAt,
}: TenantSignatureConfirmationProps) {
  return (
    <EmailLayout
      preview={`Tack — ditt hyreskontrakt hos ${organizationName} är signerat`}
      organizationName={organizationName}
      whyReceived="Du får detta mail som kvittens på att du signerat ditt hyreskontrakt digitalt."
    >
      <Heading as="h2" style={h2Style}>
        Tack — kontraktet är signerat
      </Heading>

      <Text style={textStyle}>Hej {tenantName},</Text>
      <Text style={textStyle}>
        Vi bekräftar att du digitalt signerade ditt hyreskontrakt hos{' '}
        <strong>{organizationName}</strong> den <strong>{signedAt}</strong>. Kontraktet är låst med
        en SHA-256-hash så att innehållet inte kan ändras i efterhand.
      </Text>

      <Text style={textStyle}>
        Du hittar det signerade kontraktet, samt övriga dokument från din hyresvärd, under
        Dokument-fliken i hyresgästportalen.
      </Text>

      <Section style={ctaSection}>
        <Button href={documentsUrl} style={buttonStyle}>
          Öppna mina dokument
        </Button>
      </Section>

      <Text style={hintStyle}>
        Spara gärna detta mail som kvitto på signeringen. Om du har frågor om kontraktet, kontakta
        din hyresvärd direkt.
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
  backgroundColor: '#2D6A4F',
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
  margin: '24px 0 0',
}
