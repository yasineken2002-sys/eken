import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { GorAlltidSaHar, klartext } from './GorAlltidSaHar'

import type { KanDelegera } from '../api/inbox.api'

/**
 * "GÖR ALLTID SÅ HÄR" — knappen och dess bekräftelse.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att servern faktiskt avvisar en delegation som inte får skapas. Gråheten här är
 * en ARTIGHET — `POST` prövar samma villkor på nytt — och den spärren ägs av
 * `delegation-birth.db.spec.ts` mot riktig Postgres.
 */
const kan = (över: Partial<KanDelegera> = {}): KanDelegera => ({
  kan: true,
  förifylltVillkor: { category: 'PLUMBING', propertyId: 'p1' },
  utförareFinns: false,
  ...över,
})

const rendera = (props: Partial<Parameters<typeof GorAlltidSaHar>[0]> = {}) => {
  const onSkapa = vi.fn()
  render(
    <GorAlltidSaHar
      status="APPROVED"
      kan={kan()}
      toolName="create_property"
      onSkapa={onSkapa}
      {...props}
    />,
  )
  return onSkapa
}

const knapp = () => screen.queryByRole('button', { name: 'Gör alltid så här' })

describe('när knappen alls finns', () => {
  it.each(['AWAITING_APPROVAL', 'REJECTED', 'EXPIRED'])(
    'ett %s förslag har ingen knapp',
    (status) => {
      // Ett avslaget eller väntande förslag har inget mönster att bygga en vana
      // på — knappen ska inte finnas, inte bara vara grå.
      rendera({ status })
      expect(knapp()).toBeNull()
    },
  )

  it('ett GODKÄNT förslag har den', () => {
    rendera()
    expect(knapp()).toBeTruthy()
  })
})

describe('grå tills mönstret finns', () => {
  it('grå efter FÖRSTA godkännandet, med serverns skäl', () => {
    rendera({
      kan: kan({
        kan: false,
        skäl: 'Aktiveras efter att du godkänt samma typ av förslag en gång till.',
      }),
    })
    expect(knapp()?.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/en gång till/)).toBeTruthy()
  })

  it('aktiv när servern säger ja', () => {
    rendera()
    expect(knapp()?.hasAttribute('disabled')).toBe(false)
  })

  it('grå medan svaret hämtas — och säger det', () => {
    // "Kontrollerar…" och inte tomhet: en grå knapp utan skäl läses som ett fel.
    rendera({ kan: undefined, laddar: true })
    expect(knapp()?.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Kontrollerar…')).toBeTruthy()
  })

  it('ett klick på en grå knapp öppnar ingen bekräftelse', () => {
    rendera({ kan: kan({ kan: false, skäl: 'nej' }) })
    fireEvent.click(knapp()!)
    expect(screen.queryByTestId('delegationsbekraftelse')).toBeNull()
  })
})

describe('bekräftelsen visar exakt vad som delegeras', () => {
  const öppna = (props: Partial<Parameters<typeof GorAlltidSaHar>[0]> = {}) => {
    const onSkapa = rendera(props)
    fireEvent.click(knapp()!)
    return onSkapa
  }

  it('verktyget i KLARTEXT, aldrig den tekniska termen', () => {
    öppna()
    expect(screen.getByText('lägga upp en fastighet')).toBeTruthy()
    expect(screen.queryByText('create_property')).toBeNull()
  })

  it('villkorets fält med svenska etiketter', () => {
    öppna()
    expect(screen.getByText('Typ av ärende')).toBeTruthy()
    expect(screen.getByText('PLUMBING')).toBeTruthy()
    expect(screen.getByText('Fastighet')).toBeTruthy()
  })

  it('utgångsdatumet', () => {
    öppna()
    expect(screen.getByText('om 90 dagar')).toBeTruthy()
  })

  it('ETT TOMT villkor sägs i klartext — inte som en tom rad', () => {
    // Utan avgränsning är den bredaste möjliga rätten. En tom rad hade fått den
    // att se ut som en detalj.
    öppna({ kan: kan({ förifylltVillkor: {} }) })
    expect(screen.getByText(/Utan avgränsning/)).toBeTruthy()
  })
})

describe('meningen om utföraren läses ur serverns konstant', () => {
  it('visas när det INTE finns en utförare', () => {
    öppnaOchKlicka({ kan: kan({ utförareFinns: false }) })
    expect(screen.getByText(/utför fortfarande ingenting/)).toBeTruthy()
  })

  it('FÖRSVINNER när servern säger att utföraren finns', () => {
    // Hela poängen med att läsa den ur en konstant: texten är sann bara så länge
    // det inte finns en utförare, och den dag etapp 8–9 landar ska den inte bli
    // en osanning i det enda gränssnitt hyresvärden har.
    öppnaOchKlicka({ kan: kan({ utförareFinns: true }) })
    expect(screen.queryByText(/utför fortfarande ingenting/)).toBeNull()
  })

  function öppnaOchKlicka(props: Partial<Parameters<typeof GorAlltidSaHar>[0]>) {
    rendera(props)
    fireEvent.click(knapp()!)
  }
})

describe('beslutet', () => {
  it('första klicket skapar INGENTING — det öppnar bekräftelsen', () => {
    const onSkapa = rendera()
    fireEvent.click(knapp()!)
    expect(onSkapa).not.toHaveBeenCalled()
    expect(screen.getByTestId('delegationsbekraftelse')).toBeTruthy()
  })

  it('Tillbaka stänger utan att skapa', () => {
    const onSkapa = rendera()
    fireEvent.click(knapp()!)
    fireEvent.click(screen.getByRole('button', { name: 'Tillbaka' }))
    expect(onSkapa).not.toHaveBeenCalled()
    expect(knapp()).toBeTruthy()
  })

  it('det ANDRA klicket skickar det förifyllda villkoret', () => {
    const onSkapa = rendera()
    fireEvent.click(knapp()!)
    fireEvent.click(screen.getByRole('button', { name: 'Ja, delegera' }))
    expect(onSkapa).toHaveBeenCalledWith({ category: 'PLUMBING', propertyId: 'p1' }, undefined)
  })

  it('ett TOMT villkor skickas som undefined, inte som {}', () => {
    // `{}` och `null` betyder samma sak för grinden, men bara det ena säger
    // "utan avgränsning" i databasen.
    const onSkapa = rendera({ kan: kan({ förifylltVillkor: {} }) })
    fireEvent.click(knapp()!)
    fireEvent.click(screen.getByRole('button', { name: 'Ja, delegera' }))
    expect(onSkapa).toHaveBeenCalledWith(undefined, undefined)
  })
})

describe('klartext', () => {
  it('faller tillbaka på det tekniska namnet för ett okänt verktyg', () => {
    // Hellre en teknisk term än en påhittad svensk mening om fel sak.
    expect(klartext('zz_okant_verktyg')).toBe('zz_okant_verktyg')
  })
})

describe('frekvensvillkoret — fältet finns BARA när servern säger att det krävs', () => {
  const öppna = (över: Partial<KanDelegera>) => {
    const onSkapa = rendera({ kan: kan(över) })
    fireEvent.click(knapp()!)
    return onSkapa
  }

  it('INGET fält för ett verktyg som inte kräver tak', () => {
    // Ingen lista i webben: `kräverFrekvensvillkor` kommer från servern, som
    // härleder det ur effektkatalogen. Ett fält som visas alltid hade bett
    // hyresvärden om ett tak för verktyg som inte behöver ett.
    öppna({ kräverFrekvensvillkor: false })
    expect(screen.queryByLabelText('Högsta antal')).toBeNull()
  })

  it('inte heller när fältet SAKNAS i svaret — frånvaro är inte ett ja', () => {
    öppna({})
    expect(screen.queryByLabelText('Högsta antal')).toBeNull()
  })

  it('FÄLT för ett verktyg som kräver tak, förifyllt med serverns tal', () => {
    öppna({
      kräverFrekvensvillkor: true,
      förifylltFrekvensvillkor: { maxAntal: 1, periodDagar: 1 },
    })
    expect((screen.getByLabelText('Högsta antal') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('Antal dagar') as HTMLInputElement).value).toBe('1')
  })

  it('taket FÖLJER MED till servern', () => {
    const onSkapa = öppna({
      kräverFrekvensvillkor: true,
      förifylltFrekvensvillkor: { maxAntal: 1, periodDagar: 1 },
    })
    fireEvent.change(screen.getByLabelText('Högsta antal'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Antal dagar'), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ja, delegera' }))
    expect(onSkapa).toHaveBeenCalledWith(
      { category: 'PLUMBING', propertyId: 'p1' },
      { maxAntal: 3, periodDagar: 7 },
    )
  })

  it('utan krav skickas INGET tak — inte ett tomt objekt', () => {
    const onSkapa = öppna({ kräverFrekvensvillkor: false })
    fireEvent.click(screen.getByRole('button', { name: 'Ja, delegera' }))
    expect(onSkapa).toHaveBeenCalledWith({ category: 'PLUMBING', propertyId: 'p1' }, undefined)
  })

  it.each([
    ['0', '1'],
    ['1', '0'],
    ['', '1'],
    ['2.5', '1'],
  ])('ETT OGILTIGT tak (%s per %s) spärrar knappen', (antal, dagar) => {
    // Samma regel som serverns `giltigFrekvens`: heltal, minst 1. Ett tak på
    // noll är inte ett tak — det är en avstängning i förklädnad.
    öppna({
      kräverFrekvensvillkor: true,
      förifylltFrekvensvillkor: { maxAntal: 1, periodDagar: 1 },
    })
    fireEvent.change(screen.getByLabelText('Högsta antal'), { target: { value: antal } })
    fireEvent.change(screen.getByLabelText('Antal dagar'), { target: { value: dagar } })
    expect(
      (screen.getByRole('button', { name: 'Ja, delegera' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('SKÄLET till taket står utskrivet — annars ser fälten ut som en inställning', () => {
    öppna({
      kräverFrekvensvillkor: true,
      förifylltFrekvensvillkor: { maxAntal: 1, periodDagar: 1 },
    })
    expect(screen.getByText(/obevakad körning inte ska kunna bli obegränsad/)).toBeTruthy()
  })
})
