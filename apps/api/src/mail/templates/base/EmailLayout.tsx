import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components'
import * as React from 'react'
import { EmailFooter } from './EmailFooter'

export interface EmailLayoutProps {
  /** Visas i inbox-listan i e-postklienten — håll under 90 tecken. */
  preview: string
  /** Organisationsnamn som visas i header och footer. */
  organizationName?: string
  /** Beskrivning av varför mottagaren får mailet — visas i footern. */
  whyReceived?: string
  children: React.ReactNode
}

/**
 * Gemensam layout för alla Eken-mail. Ärvs av varje template.
 * Designprinciper:
 *   - 600px max-width, fungerar i Gmail/Outlook/Apple Mail
 *   - Inga bilder (Outlook blockerar bilder by default → alt-text bara räcker inte)
 *   - Tabellbaserad layout via React Email-komponenter (e-post-CSS är begränsat)
 *   - Eken-grön (#2D6A4F) som accentfärg
 */
export function EmailLayout({
  preview,
  organizationName = 'Eken Fastigheter',
  whyReceived,
  children,
}: EmailLayoutProps) {
  return (
    <Html lang="sv">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <Heading as="h1" style={brandStyle}>
              {organizationName}
            </Heading>
            <Text style={taglineStyle}>Fastighetssystem</Text>
          </Section>

          <Section style={contentStyle}>{children}</Section>

          <EmailFooter
            organizationName={organizationName}
            {...(whyReceived ? { whyReceived } : {})}
          />
        </Container>
      </Body>
    </Html>
  )
}

const bodyStyle: React.CSSProperties = {
  backgroundColor: '#F4F6F4',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  margin: 0,
  padding: '32px 16px',
  color: '#111827',
}

const containerStyle: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  borderRadius: '12px',
  maxWidth: '600px',
  margin: '0 auto',
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
}

const headerStyle: React.CSSProperties = {
  backgroundColor: '#2D6A4F',
  padding: '32px 40px 24px',
  textAlign: 'left',
}

const brandStyle: React.CSSProperties = {
  color: '#FFFFFF',
  fontSize: '22px',
  fontWeight: 700,
  margin: 0,
  letterSpacing: '-0.01em',
}

const taglineStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.75)',
  fontSize: '13px',
  fontWeight: 500,
  margin: '4px 0 0',
  letterSpacing: '0.02em',
}

const contentStyle: React.CSSProperties = {
  padding: '32px 40px',
}
