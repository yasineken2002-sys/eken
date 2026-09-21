import { describe, it, expect, vi, beforeEach } from 'vitest'
// `fireEvent` och inte `user-event`: portalen har inte det paketet, och att
// lägga till ett beroende för två klick hade varit att ändra lockfilen för
// bekvämlighet. Klicken här är enkla och behöver ingen simulerad användare.
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InspectionsPage } from './InspectionsPage'

/**
 * JSDOM-PROV — OCH VAD DET INTE ÄR.
 *
 * Det här är inte ett webbläsarprov. Det kan inte säga något om layout, om
 * nedladdningen faktiskt startar eller om sidan går att använda på en telefon.
 * Webbläsarkörningen är skild och redovisas för sig.
 *
 * Det provet MÄTER är texterna — och just texterna är där den här vyn kan göra
 * skada. Tre påståenden får aldrig glida ihop (mottagen betalning, beslutad
 * återbetalning, genomförd utbetalning), och ordet "verifierad" får aldrig stå
 * någonstans innan kontrollen körts. Båda är egenskaper hos renderingen, inte
 * hos API:et, och de går sönder av en välmenande textändring.
 */

const api = vi.hoisted(() => ({
  fetchInspections: vi.fn(),
  fetchInspection: vi.fn(),
  fetchInspectionImageCheck: vi.fn(),
  fetchInspectionImageUrl: vi.fn(),
  downloadInspectionPdf: vi.fn(),
  fetchDeposits: vi.fn(),
}))

vi.mock('@/api/portal.api', () => ({
  ...api,
  extractApiError: (_err: unknown, fallback = 'Något gick fel') => fallback,
}))

vi.mock('@/lib/download', () => ({
  openPresignedDownload: vi.fn(),
  sanitizeFilename: (n: string) => n,
}))

function rendera() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InspectionsPage />
    </QueryClientProvider>,
  )
}

const SUMMA_AR = 'En summering av de avdragsrader som visas här, inte ett saldo ur bokföringen.'

const DEPOSITION_BESLUTAD = {
  id: 'dep-1',
  belopp: 19000,
  status: 'PARTIALLY_REFUNDED',
  lease: null,
  mottagenBetalning: {
    registreradAt: '2024-01-05T00:00:00.000Z',
    proveniens: 'KALLA_EJ_FASTSTALLD' as const,
    kommentar:
      'Ingen matchad bankbetalning är kopplad till depositionens underlag. ' +
      'Uppgiften kan komma från en manuell registrering hos hyresvärden — ' +
      'Eveno kan inte fastställa källan.',
  },
  avdrag: [{ anledning: 'Skada badrumsgolv', belopp: 4500 }],
  avdragSumma: 4500,
  avdragSummaFullstandig: true,
  avdragUtanBelopp: 0,
  avdragSummaAr: SUMMA_AR,
  beslutadAterbetalning: { belopp: 14500, beslutadAt: '2026-03-10T00:00:00.000Z' },
  genomfordUtbetalning: {
    kalla: null,
    kommentar:
      'Eveno har ingen källa som bekräftar att pengarna lämnat hyresvärdens konto. ' +
      'Uppgiften ovan är hyresvärdens beslut och bokföring, inte en bankbekräftelse.',
  },
}

const PROTOKOLL_RAD = {
  id: 'insp-1',
  type: 'MOVE_OUT' as const,
  status: 'SIGNED',
  scheduledDate: '2026-03-02T09:00:00.000Z',
  completedAt: '2026-03-02T10:30:00.000Z',
  signedAt: '2026-03-04T10:00:00.000Z',
  version: 2,
  antalVersioner: 2,
  harRattelser: true,
  unit: { id: 'u1', name: 'Lgh 1001', unitNumber: '1001', property: { name: 'Ekgatan 1' } },
}

const PROTOKOLL_DETALJ = {
  ...PROTOKOLL_RAD,
  overallCondition: 'Godtagbart skick',
  correctionReason: 'Reparationskostnaden avsåg fel lägenhet',
  correctedAt: '2026-03-05T00:00:00.000Z',
  items: [
    {
      id: 'i1',
      room: 'Badrum',
      item: 'Golv',
      condition: 'DAMAGED' as const,
      notes: 'Spricka i klinker',
      repairCost: 4500,
    },
  ],
  images: [
    {
      id: 'img-1',
      filename: 'badrum.jpg',
      caption: null,
      room: 'Badrum',
      size: 2345,
      createdAt: '2026-03-02T10:00:00.000Z',
    },
  ],
  versioner: [
    {
      id: 'insp-0',
      version: 1,
      arGallande: false,
      correctionReason: null,
      correctedAt: null,
      signedAt: '2026-03-04T10:00:00.000Z',
      completedAt: null,
    },
    {
      id: 'insp-1',
      version: 2,
      arGallande: true,
      correctionReason: 'Reparationskostnaden avsåg fel lägenhet',
      correctedAt: '2026-03-05T00:00:00.000Z',
      signedAt: '2026-03-06T00:00:00.000Z',
      completedAt: null,
    },
  ],
  arGallande: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchInspections.mockResolvedValue([])
  api.fetchDeposits.mockResolvedValue([])
})

describe('depositionen — tre uppgifter som inte får glida ihop', () => {
  it('BESLUTAD ÅTERBETALNING VISAS ALDRIG SOM GENOMFÖRD UTBETALNING', async () => {
    api.fetchDeposits.mockResolvedValue([DEPOSITION_BESLUTAD])
    rendera()

    // Beslutet finns, med sitt belopp.
    expect(await screen.findByText('Beslutad återbetalning')).toBeInTheDocument()
    // Texten säger nu uttryckligen att beslutet inte är en utförd betalning.
    expect(screen.getByText(/Beslutad och bokförd/)).toBeInTheDocument()
    expect(screen.getByText(/inte att det skett/)).toBeInTheDocument()

    // Utbetalningen är en EGEN rad, och den är okänd.
    expect(screen.getByText('Genomförd utbetalning')).toBeInTheDocument()
    expect(screen.getByText('Uppgift saknas')).toBeInTheDocument()
    expect(screen.getByText(/ingen källa som bekräftar/)).toBeInTheDocument()

    // Och ingenstans påstås en bekräftelse från banken.
    expect(screen.queryByText(/bankbekräftad|bekräftad av banken|utbetald/i)).toBeNull()
  })

  it('en obetald deposition säger att betalningen INTE är registrerad', async () => {
    api.fetchDeposits.mockResolvedValue([
      {
        ...DEPOSITION_BESLUTAD,
        status: 'PENDING',
        mottagenBetalning: null,
        avdrag: [],
        avdragSumma: 0,
        beslutadAterbetalning: null,
      },
    ])
    rendera()

    expect(await screen.findByText('Ej registrerad')).toBeInTheDocument()
    expect(screen.getByText('Depositionen är inte registrerad som mottagen.')).toBeInTheDocument()
    expect(screen.getByText('Ingen återbetalning är beslutad ännu.')).toBeInTheDocument()
  })

  it('tomt tillstånd när ingen deposition finns — inte en tom ruta', async () => {
    rendera()
    expect(
      await screen.findByText('Ingen deposition är registrerad på ditt avtal'),
    ).toBeInTheDocument()
  })
})

describe('protokollen', () => {
  it('tomt tillstånd säger att PÅGÅENDE besiktningar inte visas', async () => {
    rendera()
    expect(
      await screen.findByText('Inga besiktningsprotokoll är tillgängliga ännu'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Pågående\s+besiktningar visas inte/)).toBeInTheDocument()
  })

  it('listan visar vilken version som gäller och att protokollet rättats', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    rendera()

    expect(await screen.findByText('Utflyttningsbesiktning')).toBeInTheDocument()
    expect(screen.getByText('Gällande version 2')).toBeInTheDocument()
    expect(screen.getByText('Rättad 1 gång(er)')).toBeInTheDocument()
  })

  it('detaljen visar rättelsehistoriken med orsak', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    api.fetchInspection.mockResolvedValue(PROTOKOLL_DETALJ)
    rendera()

    fireEvent.click(await screen.findByRole('button', { name: 'Visa protokollet' }))

    expect(await screen.findByText('Rättelsehistorik')).toBeInTheDocument()
    expect(screen.getByText(/Reparationskostnaden avsåg fel lägenhet/)).toBeInTheDocument()
    expect(screen.getByText('Version 2 – gäller')).toBeInTheDocument()
    expect(screen.getByText('Ersatt')).toBeInTheDocument()
  })

  it('en ERSATT version säger att den inte gäller', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    api.fetchInspection.mockResolvedValue({ ...PROTOKOLL_DETALJ, arGallande: false })
    rendera()

    fireEvent.click(await screen.findByRole('button', { name: 'Visa protokollet' }))
    expect(
      await screen.findByText(/Den här versionen har ersatts av en senare/),
    ).toBeInTheDocument()
  })
})

describe('bilagornas kontroll', () => {
  it('ORDET "VERIFIERAD" STÅR INGENSTANS INNAN KONTROLLEN KÖRTS', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    api.fetchInspection.mockResolvedValue(PROTOKOLL_DETALJ)
    rendera()

    fireEvent.click(await screen.findByRole('button', { name: 'Visa protokollet' }))
    expect(await screen.findByText('Bilagor')).toBeInTheDocument()

    // Bilagan listas — men ingenting sägs om dess äkthet.
    expect(screen.getByText('badrum.jpg')).toBeInTheDocument()
    expect(screen.queryByText(/verifierad|oförändrat/i)).toBeNull()
    expect(api.fetchInspectionImageCheck).not.toHaveBeenCalled()

    // Kontrollen startas bara av knappen.
    expect(screen.getByRole('button', { name: 'Kontrollera bilagorna' })).toBeInTheDocument()
  })

  it('ett AVVIKANDE utfall visas som avvikande, inte som en not', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    api.fetchInspection.mockResolvedValue(PROTOKOLL_DETALJ)
    api.fetchInspectionImageCheck.mockResolvedValue({
      inspectionId: 'insp-1',
      sammanfattning: 'AVVIKANDE',
      kontrolleradAt: '2026-09-21T10:00:00.000Z',
      bilder: [{ imageId: 'img-1', filename: 'badrum.jpg', utfall: 'AVVIKANDE' }],
    })
    rendera()

    fireEvent.click(await screen.findByRole('button', { name: 'Visa protokollet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Kontrollera bilagorna' }))

    await waitFor(() =>
      expect(
        screen.getAllByText(/Innehållet är INTE detsamma som när bilden laddades upp/).length,
      ).toBeGreaterThan(0),
    )
    // Och "verifierad" står fortfarande ingenstans.
    expect(screen.queryByText(/är oförändrat sedan det laddades upp/)).toBeNull()
  })

  it('en bilaga UTAN sparad digest märks som okontrollerbar, inte som godkänd', async () => {
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    api.fetchInspection.mockResolvedValue(PROTOKOLL_DETALJ)
    api.fetchInspectionImageCheck.mockResolvedValue({
      inspectionId: 'insp-1',
      sammanfattning: 'DIGEST_SAKNAS',
      kontrolleradAt: '2026-09-21T10:00:00.000Z',
      bilder: [{ imageId: 'img-1', filename: 'badrum.jpg', utfall: 'DIGEST_SAKNAS' }],
    })
    rendera()

    fireEvent.click(await screen.findByRole('button', { name: 'Visa protokollet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Kontrollera bilagorna' }))

    await waitFor(() =>
      expect(
        screen.getAllByText(/laddades upp innan kontrollen fanns och går inte att kontrollera/)
          .length,
      ).toBeGreaterThan(0),
    )
    expect(screen.queryByText(/är oförändrat sedan det laddades upp/)).toBeNull()
  })
})

describe('bevisnivån i statusmärken och belopp', () => {
  it('STATUSMÄRKET PÅSTÅR INTE EN UTFÖRD BETALNING', async () => {
    // Märket sa "Återbetald med avdrag" samtidigt som raden under sa att
    // genomförd utbetalning är okänd. Av de två läses märket först.
    api.fetchDeposits.mockResolvedValue([DEPOSITION_BESLUTAD])
    rendera()

    expect(await screen.findByText('Återbetalning beslutad — med avdrag')).toBeInTheDocument()
    expect(screen.queryByText('Återbetald med avdrag')).toBeNull()
    expect(screen.queryByText('Återbetald')).toBeNull()
  })

  it('en FÖRVERKAD deposition beskrivs som ett beslut', async () => {
    api.fetchDeposits.mockResolvedValue([{ ...DEPOSITION_BESLUTAD, status: 'FORFEITED' }])
    rendera()
    expect(
      await screen.findByText('Förverkad genom beslut — ingen återbetalning'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Förverkad')).toBeNull()
  })

  it('INGET AKTÖRSPÅSTÅENDE om vem som registrerade betalningen', async () => {
    api.fetchDeposits.mockResolvedValue([DEPOSITION_BESLUTAD])
    rendera()

    expect(await screen.findByText('Källa ej fastställd.')).toBeInTheDocument()
    expect(screen.queryByText(/Registrerad av hyresvärden/)).toBeNull()
    expect(screen.getByText(/kan komma från en manuell registrering/)).toBeInTheDocument()
  })

  it('en BANKMATCHAD betalning säger att den är kopplad till en bankbetalning', async () => {
    api.fetchDeposits.mockResolvedValue([
      {
        ...DEPOSITION_BESLUTAD,
        mottagenBetalning: {
          registreradAt: '2024-01-05T00:00:00.000Z',
          proveniens: 'BANKMATCHNING_FINNS' as const,
          kommentar:
            'En matchad bankbetalning är kopplad till underlaget. Det visar inte i sig ' +
            'att hela depositionen är bankbekräftad eller hur mottagningsdatumet registrerades.',
        },
      },
    ])
    rendera()

    expect(await screen.findByText('Kopplad till en matchad bankbetalning.')).toBeInTheDocument()
    // AVGRÄNSNINGEN SKA SYNAS, inte bara finnas i svaret: en matchning gör
    // varken hela depositionen bankbekräftad eller säger hur datumet
    // registrerades.
    expect(
      screen.getByText(/inte i sig att hela depositionen är bankbekräftad/),
    ).toBeInTheDocument()
    expect(screen.getByText(/hur mottagningsdatumet registrerades/)).toBeInTheDocument()
    // Och fortfarande ingen påstådd bankBEKRÄFTELSE av utbetalningen.
    expect(screen.getByText('Uppgift saknas')).toBeInTheDocument()
  })

  it('ÖREN VISAS när de finns, hela kronor visas utan decimaler', async () => {
    api.fetchDeposits.mockResolvedValue([
      {
        ...DEPOSITION_BESLUTAD,
        belopp: 19000,
        avdrag: [
          { anledning: 'Skada badrumsgolv', belopp: 4500.5 },
          { anledning: 'Städning', belopp: 300 },
        ],
        avdragSumma: 4800.5,
      },
    ])
    rendera()

    expect(await screen.findByText(/4\s?500,50/)).toBeInTheDocument()
    expect(screen.getByText(/Städning: 300 kr/)).toBeInTheDocument()
    // Summan bär också örena — ingen avrundning till hela kronor.
    expect(screen.getByText(/4\s?800,50/)).toBeInTheDocument()
  })

  it('ETT SAKNAT AVDRAGSBELOPP VISAS SOM SAKNAT, inte som noll kronor', async () => {
    api.fetchDeposits.mockResolvedValue([
      {
        ...DEPOSITION_BESLUTAD,
        avdrag: [
          { anledning: 'Skada badrumsgolv', belopp: 4500 },
          { anledning: null, belopp: null },
        ],
        avdragSumma: 4500,
        avdragSummaFullstandig: false,
        avdragUtanBelopp: 1,
      },
    ])
    rendera()

    expect(await screen.findByText(/Anledning saknas: belopp saknas/)).toBeInTheDocument()
    expect(screen.getByText(/Summan är ofullständig: 1 rad saknar belopp/)).toBeInTheDocument()
    // Och ingen rad som ser ut som ett avdrag på noll kronor.
    expect(screen.queryByText(/: 0 kr/)).toBeNull()
  })

  it('SUMMANS INNEBÖRD STÅR UTSKRIVEN — den är ingen bokförd siffra', async () => {
    api.fetchDeposits.mockResolvedValue([DEPOSITION_BESLUTAD])
    rendera()
    expect(await screen.findByText(SUMMA_AR)).toBeInTheDocument()
  })
})

describe('fel- och återförsökstillstånd', () => {
  it('depositionen felar för sig — protokollen visas ändå', async () => {
    api.fetchDeposits.mockRejectedValue(new Error('nätverk'))
    api.fetchInspections.mockResolvedValue([PROTOKOLL_RAD])
    rendera()

    expect(await screen.findByText('Utflyttningsbesiktning')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Försök igen' }).length).toBeGreaterThan(0)
  })

  it('återförsök anropar API:et igen', async () => {
    api.fetchDeposits.mockRejectedValue(new Error('nätverk'))
    api.fetchInspections.mockResolvedValue([])
    rendera()

    const retry = await screen.findByRole('button', { name: 'Försök igen' })
    api.fetchDeposits.mockResolvedValue([DEPOSITION_BESLUTAD])
    fireEvent.click(retry)

    expect(await screen.findByText('Genomförd utbetalning')).toBeInTheDocument()
  })
})
