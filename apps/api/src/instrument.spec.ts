import { skrubbaEvent, ärBrus } from './instrument'
import type { ErrorEvent } from '@sentry/nestjs'

/**
 * SENTRY-SKRUBBNINGEN (#576:s steg 2 blottade den).
 *
 * `beforeSend` filtrerade brus — 401/403 och flyktiga nätverksfel — men inte
 * personuppgifter. Ett fel i en väg som hanterar en hyresgäst kunde alltså bära
 * namn, e-post eller personnummer till en extern tjänst utan att något i
 * kodbasen kunde se det.
 *
 * Proven nedan mäter BÅDA riktningarna. Att maskera är lätt att bevisa; att
 * INTE maskera det som ska passera är det som gör provet skarpt — en skrubbning
 * som maskerar allt är lika oanvändbar som ingen alls, och den skulle passera
 * varje "maskeras?"-prov.
 */

const event = (över: Partial<ErrorEvent> = {}): ErrorEvent =>
  ({ event_id: 'x', ...över }) as ErrorEvent

describe('skrubbaEvent — maskerar', () => {
  it('maskerar e-post, personnummer och Authorization i ETT event', () => {
    // Fallet uppdraget beskriver: alla tre i samma payload.
    const ut = skrubbaEvent(
      event({
        message: 'Kunde inte skicka till anna.andersson@exempel.se',
        exception: {
          values: [{ type: 'Error', value: 'Hyresgäst 19850101-1234 saknar adress' }],
        },
        request: {
          headers: {
            authorization: 'Bearer eyJhbGciOi.hemlig.token',
            'content-type': 'application/json',
          },
        },
      }),
    )

    expect(ut.message).toBe('Kunde inte skicka till [e-post]')
    expect(ut.exception?.values?.[0]?.value).toBe('Hyresgäst [personnummer] saknar adress')
    // Huvudet STRYKS, inte maskeras — en bärare har inget innehåll att spara.
    expect(ut.request?.headers).not.toHaveProperty('authorization')
    // Och det ofarliga huvudet är kvar, annars är felet omöjligt att felsöka.
    expect(ut.request?.headers?.['content-type']).toBe('application/json')
  })

  it('maskerar personnummer i alla fyra skrivsätten', () => {
    // 10/12 siffror, med och utan avgränsare. Missas en form är maskeringen
    // grön för det fall någon råkade prova.
    for (const pn of ['8501011234', '850101-1234', '198501011234', '19850101-1234']) {
      const ut = skrubbaEvent(event({ message: `pn=${pn} slut` }))
      // Formen står i utfallet via `pn` i strängen, så ett fel pekar ut vilken.
      expect(`${pn} → ${ut.message}`).toBe(`${pn} → pn=[personnummer] slut`)
    }
  })

  it('maskerar OCR-nummer men INTE godtyckliga långa tal', () => {
    // Precisionen: bara siffersekvenser som passerar Luhn maskeras. Ett belopp
    // i ören eller ett millisekund-tidsstämpel ska överleva, annars blir
    // felmeddelanden obrukbara utan att något skyddas.
    // Beräknat med den DELADE luhnChecksum, inte med en egen kopia: min första
    // fixtur (00000181) hade fel kontrollsiffra, eftersom min omskrivning
    // dubblade fel position. generateOcrNumber(18) ger 00000180.
    const ocr = '00000180'
    expect(skrubbaEvent(event({ message: `ocr ${ocr}` })).message).toBe('ocr [ocr]')
    expect(skrubbaEvent(event({ message: 'ms 17885200000001' })).message).toBe('ms 17885200000001')
    // Och längdgolvet bär: '1250' passerar Luhn men är fyra siffror, alltså ett
    // belopp och inget OCR. Utan golvet hade varje belopp maskerats.
    expect(skrubbaEvent(event({ message: 'belopp 1250 kr' })).message).toBe('belopp 1250 kr')
  })

  it('behåller bara user.id — aldrig e-post', () => {
    // Den vanligaste läckan, och den ser harmlös ut eftersom Sentry ber om den.
    const ut = skrubbaEvent(
      event({ user: { id: 'u-1', email: 'a@b.se', ip_address: '1.2.3.4', username: 'anna' } }),
    )
    expect(ut.user).toEqual({ id: 'u-1' })
  })

  it('tar bort cookies och känsliga fältnamn ur request-bodyn', () => {
    const ut = skrubbaEvent(
      event({
        request: {
          cookies: { session: 'hemlig' },
          data: { epost: 'a@b.se', personalNumber: '8501011234', ort: 'Göteborg' },
        },
      }),
    )
    expect(ut.request).not.toHaveProperty('cookies')
    const data = ut.request?.data as Record<string, unknown>
    // Fältnamnet stryks av SENSITIVE_FIELD_NAMES — samma lista som AI-lagret.
    expect(data).not.toHaveProperty('personalNumber')
    // Fritexten maskeras även när fältnamnet är okänt.
    expect(data['epost']).toBe('[e-post]')
    expect(data['ort']).toBe('Göteborg')
  })

  it('når breadcrumbs, extra och contexts', () => {
    const ut = skrubbaEvent(
      event({
        breadcrumbs: [{ message: 'mejl till a@b.se', data: { to: 'c@d.se' } }],
        extra: { note: 'pn 850101-1234' },
        contexts: { egen: { fält: 'x@y.se' } },
      }),
    )
    expect(ut.breadcrumbs?.[0]?.message).toBe('mejl till [e-post]')
    expect((ut.breadcrumbs?.[0]?.data as Record<string, unknown>)['to']).toBe('[e-post]')
    expect((ut.extra as Record<string, unknown>)['note']).toBe('pn [personnummer]')
  })
})

describe('skrubbaEvent — lämnar oförändrat', () => {
  it('rör inte ett event utan personuppgifter', () => {
    // MOTPROVET. Utan det passerar en skrubbning som maskerar allt.
    const ut = skrubbaEvent(
      event({
        message: 'Kunde inte nå Redis på port 6379',
        exception: { values: [{ type: 'Error', value: 'ECONNREFUSED efter 3 försök' }] },
        request: { headers: { 'content-type': 'application/json' }, data: { fastighetId: 'f-1' } },
        extra: { belopp: 1250, antal: 3 },
      }),
    )
    expect(ut.message).toBe('Kunde inte nå Redis på port 6379')
    expect(ut.exception?.values?.[0]?.value).toBe('ECONNREFUSED efter 3 försök')
    expect(ut.request?.headers?.['content-type']).toBe('application/json')
    expect((ut.request?.data as Record<string, unknown>)['fastighetId']).toBe('f-1')
    expect(ut.extra).toEqual({ belopp: 1250, antal: 3 })
  })

  it('tål ett tomt event', () => {
    expect(() => skrubbaEvent(event())).not.toThrow()
  })
})

describe('ärBrus — oförändrat brusfilter', () => {
  it('filtrerar 401/403 och flyktiga nätverksfel', () => {
    expect(ärBrus({ originalException: { status: 401 } })).toBe(true)
    expect(ärBrus({ originalException: { getStatus: () => 403 } })).toBe(true)
    expect(ärBrus({ originalException: { code: 'ECONNRESET' } })).toBe(true)
  })

  it('släpper igenom riktiga fel', () => {
    expect(ärBrus({ originalException: { status: 500 } })).toBe(false)
    expect(ärBrus(undefined)).toBe(false)
  })
})
