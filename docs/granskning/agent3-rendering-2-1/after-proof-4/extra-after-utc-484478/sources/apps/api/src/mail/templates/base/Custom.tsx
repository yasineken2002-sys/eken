import { Text } from '@react-email/components'
import * as React from 'react'
import { EmailLayout } from './EmailLayout'

export interface CustomProps {
  /** Visas i inbox-listan i e-postklienten — kapas till 90 tecken om längre. */
  preview: string
  /** Hyresgästens visningsnamn. */
  tenantName: string
  /** Organisationsnamn som visas i header och footer. */
  organizationName: string
  /** Förrenderad HTML från service-lagret. Måste redan vara säker — sanitiseras inte. */
  bodyHtml: string
  /** Förklaring för footern av varför mottagaren får mailet. */
  whyReceived?: string
}

/**
 * Wrapper-template för historiskt fri-HTML-anrop (sendCustomEmail).
 * Service-lagret bygger sin HTML och skickar in den hit; vi wrappar den
 * i Eveno-layouten så att headern och footern blir konsekventa.
 *
 * user-html-sink-allow: den enda avsiktliga raw-HTML-sänkan i API:t. `bodyHtml`
 * byggs av anroparen och måste passera `renderUserParagraphs` i mail/user-html.ts,
 * som är kodbasens enda sanerare; check-user-html-sanitizer.mjs fäller en andra.
 * Att sänkan ligger här och inte i anroparen är medvetet — mallen ska rendera,
 * inte sanera — men det gör kvitteringen till en del av mallens kontrakt.
 */
export function Custom({
  preview,
  tenantName: _tenantName,
  organizationName,
  bodyHtml,
  whyReceived,
}: CustomProps) {
  return (
    <EmailLayout
      preview={preview}
      organizationName={organizationName}
      {...(whyReceived ? { whyReceived } : {})}
    >
      <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      <Text style={signatureStyle}>
        Vänliga hälsningar,
        <br />
        <strong>{organizationName}</strong>
      </Text>
    </EmailLayout>
  )
}

const signatureStyle: React.CSSProperties = {
  color: '#374151',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '24px 0 0',
}
