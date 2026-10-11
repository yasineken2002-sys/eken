import { isExactEmptyFirstPage } from './fortnox-pagination'
import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { ogiltigforklaraAktiveringar } from '../kundstart/activation-invalidation'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import {
  arIntaktskonto,
  bedomKonto,
  harledBehandlingar,
  stoppForIntakter,
  type Behandling,
  type FortnoxKontoFakta,
} from './fortnox-intaktsgrind'
import { brytdatumIso } from '../kundstart/cutover'
import {
  BEHANDLING_TEXT,
  ROLL_TEXT,
  SAKNAS,
  drift,
  godkannandeHinder,
  iKontoklass,
  klassText,
  malfaktaUrSvar,
  teknik,
  type Malfakta,
  type Roll,
} from './fortnox-kontomappning'
import { klassaVerifikat, originalUtfall } from './fortnox-radklass'
import {
  buildFortnoxVoucherDraft,
  type FortnoxVoucherDraftConfig,
  type LocalJournalEntrySnapshot,
} from './export/fortnox-voucher-draft'
import type {
  FortnoxVoucherDraftBuilder,
  FortnoxVoucherDraftOutcome,
} from './fortnox-export.service'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

/**
 * Förhandskontroll av ett Eveno-verifikat mot Fortnox huvudbok — DRY RUN.
 *
 * Laddar verifikatet org-bundet (belopp som Decimal.toString(), aldrig Number),
 * hämtar varje referens som transformern kräver ur det ANSLUTNA Fortnox-företaget
 * i samma stund och anropar den frysta, rena transformern:
 *
 *  - företag:      GET /3/companyinformation — DatabaseNumber och orgnr måste stämma
 *                  med anslutningen.
 *  - räkenskapsår: GET /3/financialyears (alla sidor); exakt ett år ska innehålla
 *                  bokföringsdatumet. Både query-id och payloadens Year sätts till
 *                  års-id:t (SEMANTIK-TILLÄGG-01: Year är års-id i Fortnox exempel).
 *  - serie:        kundens uttryckliga val (FortnoxConnection.exportVoucherSeries),
 *                  verifierad med GET /3/voucherseries/{kod}. Inget val → BLOCKED.
 *  - konton:       TESTKUND-008: varje rad kräver en GODKÄND kontomappningsrad för sin
 *                  (roll, källkonto, behandling), härledd ur källan (fortnox-radklass.ts).
 *                  Målkontot läses färskt (GET /3/accounts/{mål}?financialyear=id) och jämförs
 *                  med revisionens ögonblicksbild. Ingen 1:1-väg och inget gissat konto.
 *  - dimensioner:  OMIT, eftersom JournalEntryLine saknar dimension (inget härleds).
 *  - rättelse:     E-F1 — ett rättelseverifikat förhandskontrolleras bara om originalet
 *                  har en BEKRÄFTAD export till samma Fortnox-företag.
 *
 * `liveExportAllowed` är alltid false; detta bygger inget sändflöde.
 */
@Injectable()
export class VerifiedVoucherDraftBuilder implements FortnoxVoucherDraftBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
  ) {}

  async build(organizationId: string, journalEntryId: string): Promise<FortnoxVoucherDraftOutcome> {
    const block = (code: string, message: string): FortnoxVoucherDraftOutcome => ({
      ok: false,
      reasons: [`${code}: ${message}`],
    })

    const entry = await this.prisma.journalEntry.findFirst({
      where: { id: journalEntryId, organizationId },
      include: {
        lines: {
          include: {
            account: {
              select: { id: true, organizationId: true, number: true, type: true, name: true },
            },
          },
        },
      },
    })
    if (!entry) return block('NOT_FOUND', 'Verifikatet finns inte i organisationen')
    // KUNDSTART-001 A7: öppningen skapar inga verifikat. Skulle ett verifikat ändå bära
    // en öppningskälla stoppas det här — öppningens belopp finns redan i Fortnox (IB).
    if (typeof entry.sourceId === 'string' && entry.sourceId.startsWith('opening:'))
      return block(
        'OPENING_COMPONENT',
        'Öppningskomponenter (före brytdatum) är redan bokförda i Fortnox och exporteras aldrig',
      )
    // KUNDSTART K-B7: EXPORTGRÄNS. Ett verifikat daterat före organisationens brytdatum
    // exporteras aldrig — perioden är historik som redan kan finnas i Fortnox (gamla
    // systemet eller bankkoppling). Samma regel prövas igen i send() och i skrivaren.
    {
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { billingCutoverDate: true },
      })
      if (org?.billingCutoverDate && entry.date < org.billingCutoverDate)
        return block(
          'BEFORE_CUTOVER',
          `Verifikatet är daterat ${entry.date.toISOString().slice(0, 10)}, före brytdatum ` +
            `${org.billingCutoverDate.toISOString().slice(0, 10)}: historik som redan kan finnas i ` +
            'Fortnox. Det exporteras aldrig — stäm av manuellt.',
        )
    }

    const conn = await this.prisma.fortnoxConnection.findUnique({ where: { organizationId } })
    if (!conn || conn.status !== 'ACTIVE') return block('NOT_CONNECTED', 'Fortnox är inte anslutet')
    if (!conn.fortnoxOrgNumber)
      return block('COMPANY_UNVERIFIED', 'Fortnox-företagets organisationsnummer saknas')
    if (!conn.exportOmitDimensionsAt || !conn.exportOmitDimensionsBy) {
      return block(
        'DIMENSION_DECISION_MISSING',
        'Ta ställning till dimensioner: Evenos verifikat saknar kostnadsställe/projekt; export utan dimension måste väljas uttryckligen',
      )
    }
    if (!conn.exportVoucherSeries)
      return block(
        'VOUCHER_SERIES_NOT_CHOSEN',
        'Välj verifikatserie för export i Fortnox-inställningarna',
      )

    if (entry.reversalOfEntryId) {
      const original = await this.prisma.fortnoxVoucherExport.findFirst({
        where: {
          organizationId,
          journalEntryId: entry.reversalOfEntryId,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
        },
        select: { id: true },
      })
      if (!original) {
        const u = await originalUtfall(
          this.prisma,
          organizationId,
          entry.reversalOfEntryId,
          conn.fortnoxDatabaseNumber,
        )
        return block(
          'ORIGINAL_NOT_CONFIRMED',
          u.typ === 'OKANT'
            ? `Originalets ${u.text}; rättelsen exporteras inte förrän originalet är bekräftat`
            : `Originalet är ${u.typ === 'CONFIRMED' ? 'bekräftat' : u.text} — rättelsen kan inte exporteras förrän originalverifikatet är bekräftat exporterat till samma Fortnox-företag`,
        )
      }
    }

    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        return block('NOT_CONNECTED', 'Fortnox-anslutningen kan inte användas just nu')
      throw err
    }
    const reader = new RefreshingLedgerReader(this.reader, this.connections, organizationId, auth)
    const at = new Date().toISOString()
    const date = entry.date.toISOString().slice(0, 10)

    try {
      const ci = await reader.get<{
        CompanyInformation?: { DatabaseNumber?: unknown; OrganizationNumber?: unknown }
      }>(auth.token, '/3/companyinformation')
      if (ci?.CompanyInformation?.DatabaseNumber !== conn.fortnoxDatabaseNumber) {
        return block('WRONG_COMPANY', 'Fortnox svarade för ett annat företag än det anslutna')
      }
      const orgNumber =
        typeof ci.CompanyInformation.OrganizationNumber === 'string'
          ? ci.CompanyInformation.OrganizationNumber
          : null
      if (orgNumber !== conn.fortnoxOrgNumber)
        return block(
          'WRONG_COMPANY',
          'Organisationsnumret i Fortnox har ändrats sedan anslutningen',
        )

      const years = await allPages<{
        Id?: unknown
        FromDate?: unknown
        ToDate?: unknown
        AccountingMethod?: unknown
      }>(reader, auth.token, '/3/financialyears', 'FinancialYears')
      const matching = years.filter(
        (y) =>
          typeof y.FromDate === 'string' &&
          typeof y.ToDate === 'string' &&
          y.FromDate <= date &&
          date <= y.ToDate,
      )
      if (matching.length !== 1 || !Number.isSafeInteger(matching[0]?.Id)) {
        return block(
          'FINANCIAL_YEAR_UNVERIFIED',
          `Exakt ett räkenskapsår i Fortnox måste omfatta ${date}`,
        )
      }
      const fy = matching[0] as { Id: number; FromDate: string; ToDate: string }
      // KUNDSTART K-B8: Evenos verifikat förutsätter faktureringsmetoden (1510/39xx vid avi,
      // 1930/1510 vid betalning). Räkenskapsårets AccountingMethod ur SAMMA svar måste vara
      // exakt ACCRUAL — CASH, saknat eller okänt är BLOCKED. Ett observerat avsteg upphäver
      // dessutom beständigt en kundaktivering (även om sändningen redan stoppas här).
      // Kundens metod ändras aldrig.
      const metod = (matching[0] as { AccountingMethod?: unknown }).AccountingMethod
      if (metod !== 'ACCRUAL') {
        const vilken = typeof metod === 'string' && metod ? metod : 'okänd'
        await ogiltigforklaraAktiveringar(
          this.prisma,
          organizationId,
          `Räkenskapsåret ${fy.FromDate}–${fy.ToDate} har bokföringsmetod ${vilken}, inte ACCRUAL.`,
        )
        return block(
          'ACCOUNTING_METHOD_UNSUPPORTED',
          `Eveno stödjer bara faktureringsmetoden (ACCRUAL) i denna version; räkenskapsåret ` +
            `${fy.FromDate}–${fy.ToDate} i Fortnox har metod ${vilken}. Kundens metod ändras inte.`,
        )
      }

      const series = await getRef<{ VoucherSeries?: { Code?: unknown; Year?: unknown } }>(
        reader,
        auth.token,
        `/3/voucherseries/${conn.exportVoucherSeries}`,
        'VOUCHER_SERIES_UNVERIFIED',
        `Verifikatserien ${conn.exportVoucherSeries} finns inte i Fortnox`,
        { financialyear: fy.Id },
      )
      // E3: serien måste uttryckligen gälla det valda året (Year ingår i svarsschemat).
      if (
        series?.VoucherSeries?.Code === conn.exportVoucherSeries &&
        series.VoucherSeries.Year !== fy.Id
      ) {
        return block(
          'VOUCHER_SERIES_YEAR_UNVERIFIED',
          `Verifikatserien ${conn.exportVoucherSeries} är inte verifierad för räkenskapsår ${fy.Id}`,
        )
      }
      if (series?.VoucherSeries?.Code !== conn.exportVoucherSeries) {
        return block(
          'VOUCHER_SERIES_UNVERIFIED',
          `Verifikatserien ${conn.exportVoucherSeries} finns inte i Fortnox`,
        )
      }

      const binding = (ref: string) => ({
        organizationId,
        externalDatabaseNumber: conn.fortnoxDatabaseNumber,
        evidenceRef: `${ref}@${at}`,
      })
      // ── TESTKUND-008: kontomappning (KONTRAKT-008 §4). Ingen 1:1-väg: varje rad kräver en
      // godkänd mappningsrad för sin (roll, källkonto, behandling), härledd ur källan. ──
      const faktaCache = new Map<number, Malfakta>()
      const lasKonto = async (n: number): Promise<Malfakta> => {
        const c = faktaCache.get(n)
        if (c) return c
        let f: Malfakta
        try {
          f = malfaktaUrSvar(
            n,
            await reader.get<{ Account?: Record<string, unknown> }>(
              auth.token,
              `/3/accounts/${n}`,
              { financialyear: fy.Id },
            ),
          )
        } catch (err) {
          if (err instanceof FortnoxReadError && err.kind === 'invalid') f = SAKNAS
          else throw err
        }
        faktaCache.set(n, f)
        return f
      }
      const klass = await klassaVerifikat(
        this.prisma,
        organizationId,
        entry,
        conn.fortnoxDatabaseNumber,
      )
      // V5a: en godkänd revision per (organisation, räkenskapsår); verifikatets år avgör.
      const revision = await this.prisma.fortnoxAccountMappingRevision.findFirst({
        where: { organizationId, status: 'APPROVED', financialYearId: fy.Id },
        include: { rows: true },
      })
      const radFor = (roll: string, konto: number, behandling: string) =>
        revision?.rows.find(
          (r) =>
            r.role === roll && r.sourceAccountNumber === konto && r.vatTreatment === behandling,
        )

      // #946-GRINDEN står kvar för varje intäktsrad som inte täcks av en godkänd mappningsrad med
      // belagd momsfri bostadshyra (K8.3): utan en sådan stoppas den exakt som tidigare.
      const otackta = entry.lines.filter(
        (l) =>
          arIntaktskonto(l.account) &&
          !(
            klass.ok &&
            klass.rader.get(l.id)?.roll === 'HYRESINTAKT' &&
            radFor('HYRESINTAKT', l.account.number, 'MOMSFRI')
          ),
      )
      if (otackta.length > 0) {
        const behandlingar = await harledBehandlingar(this.prisma, organizationId, entry)
        const perKonto = new Map<number, { namn: string; b: Behandling[] }>()
        for (const l of otackta) {
          const k = perKonto.get(l.account.number) ?? { namn: l.account.name, b: [] }
          k.b.push(behandlingar.get(l.id) ?? { typ: 'OBEVISAD', skal: 'ingen behandling härledd' })
          perKonto.set(l.account.number, k)
        }
        const bedomningar = []
        for (const [n, k] of perKonto) {
          const f = await lasKonto(n)
          const finns = f.exists && (f.year === null || f.year === fy.Id)
          const fakta: FortnoxKontoFakta = {
            number: n,
            finns,
            active: finns ? f.active === true : null,
            name: f.name,
            vatCode: f.vatCodePresent ? f.vatCode : undefined,
          }
          bedomningar.push(bedomKonto(n, k.namn, fakta, k.b))
        }
        const stopp = stoppForIntakter(bedomningar)
        if (stopp) return block(stopp.kod, stopp.text)
      }
      if (!klass.ok) return block(klass.kod, klass.skal)
      if (!revision)
        return block(
          'ACCOUNT_MAPPING_MISSING',
          `Ingen godkänd kontomappning för räkenskapsår ${fy.Id} (${fy.FromDate}–${fy.ToDate}) — ` +
            'godkänn en kontomappning i Fortnox-inställningarna',
        )
      if (
        revision.connectionId !== conn.id ||
        revision.connectionGeneration !== conn.generation ||
        revision.fortnoxDatabaseNumber !== conn.fortnoxDatabaseNumber ||
        revision.fortnoxOrgNumber !== orgNumber ||
        brytdatumIso(revision.financialYearFrom) !== fy.FromDate ||
        brytdatumIso(revision.financialYearTo) !== fy.ToDate
      )
        return block(
          'ACCOUNT_MAPPING_STALE',
          `Kontomappningen (revision ${revision.revision}) godkändes för en annan Fortnox-anslutning, ` +
            'ett annat företag eller andra årsgränser — skapa och godkänn en ny revision',
        )
      // V1 / TESTKUND-027 (L3.2, B2.5): en rättelse — avmatchning, annullering eller makulering —
      // bokas på originalets EXPORTERADE målkonto och mappningsrevision, lästa ur originalexportens
      // frysta utkast. Dagens mappning används aldrig för rättelsen (ingen tyst omkontering, och
      // ingen blockering bara för att mappningen ändrats efteråt).
      // V-5 (KONTRAKTSBESKED-P2-028): rättelsens Fortnox-rader tas ur ORIGINALEXPORTENS frysta
      // utkast — proveniensrad (lokalt konto, mål, belopp, sida) + payloadrad (konto, dimension) +
      // kontomappningsrad (revision, ögonblick) — aldrig ur originalets JE eller dagens mappning.
      type ProvRad = {
        journalEntryLineId?: unknown
        localAccountNumber?: unknown
        externalAccountNumber?: unknown
        amountOre?: unknown
        side?: unknown
      }
      type KmRad = {
        journalEntryLineId: string
        mappningsradId: string
        ogonblick: {
          namn: string | null
          aktiv: boolean | null
          momskod: string | null
          ar: number | null
        }
      }
      let original: {
        exportId: string
        nyckel: string
        revisionId: string
        revision: number
        contentSha256: string
        rader: Array<{
          prov: ProvRad
          payload: Record<string, unknown>
          km: KmRad | undefined
          anvand: boolean
        }>
      } | null = null
      if (klass.ok && klass.rattelseAv) {
        const orig = await this.prisma.fortnoxVoucherExport.findFirst({
          where: {
            organizationId,
            journalEntryId: klass.rattelseAv,
            state: 'CONFIRMED',
            fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
          },
          select: {
            id: true,
            draft: true,
            externalYear: true,
            externalSeries: true,
            externalNumber: true,
          },
        })
        if (!orig) {
          const u = await originalUtfall(
            this.prisma,
            organizationId,
            klass.rattelseAv,
            conn.fortnoxDatabaseNumber,
          )
          return block(
            'ORIGINAL_NOT_CONFIRMED',
            u.typ === 'OKANT'
              ? `Originalets ${u.text}; rättelsen exporteras inte förrän originalet är bekräftat`
              : `Originalet är ${u.typ === 'CONFIRMED' ? 'bekräftat' : u.text} — rättelsen kan inte exporteras förrän originalverifikatet är bekräftat exporterat till samma Fortnox-företag`,
          )
        }
        const d = orig.draft as {
          payload?: { Voucher?: { VoucherRows?: Array<Record<string, unknown>> } }
          provenance?: { lines?: ProvRad[] }
          kontomappning?: {
            revisionId?: unknown
            revision?: unknown
            contentSha256?: unknown
            rader?: KmRad[]
          }
        } | null
        const prov = d?.provenance?.lines ?? []
        const pay = d?.payload?.Voucher?.VoucherRows ?? []
        const km = d?.kontomappning
        if (
          !km ||
          typeof km.revisionId !== 'string' ||
          typeof km.revision !== 'number' ||
          typeof km.contentSha256 !== 'string' ||
          prov.length === 0 ||
          prov.length !== pay.length
        )
          return block(
            'ORIGINAL_MAPPING_UNKNOWN',
            'Originalexporten saknar frysta rader eller kontomappningsproveniens — rättelsen kan inte bokas på originalets konton; stäm av manuellt i Fortnox',
          )
        original = {
          exportId: orig.id,
          nyckel: `${orig.externalYear}|${orig.externalSeries}|${orig.externalNumber}`,
          revisionId: km.revisionId,
          revision: km.revision,
          contentSha256: km.contentSha256,
          rader: prov.map((p, i) => ({
            prov: p,
            payload: pay[i]!,
            km: (km.rader ?? []).find((r) => r.journalEntryLineId === p.journalEntryLineId),
            anvand: false,
          })),
        }
      }

      const accounts: Array<FortnoxVoucherDraftConfig['accounts'][number]> = []
      const malPerKonto = new Map<string, number>()
      const mappningsrader: Array<{
        journalEntryLineId: string
        roll: string
        behandling: string
        kallkonto: number
        malkonto: number
        mappningsradId: string
        ogonblick: {
          namn: string | null
          aktiv: boolean | null
          momskod: string | null
          ar: number | null
        }
      }> = []
      for (const l of entry.lines) {
        const rk = klass.rader.get(l.id)!
        if (original) {
          // V-5: exakt en oanvänd frusen originalrad med samma lokala konto, samma belopp i öre och
          // MOTSATT sida. Annars stopp (ingen gissning, ingen omkontering).
          const ore = (x: string | null) => (x === null ? 0 : Math.round(Number(x) * 100))
          const minSida = l.debit !== null ? 'Debit' : 'Credit'
          const belopp =
            minSida === 'Debit'
              ? ore(l.debit === null ? null : l.debit.toString())
              : ore(l.credit === null ? null : l.credit.toString())
          const r = original.rader.find(
            (x) =>
              !x.anvand &&
              x.prov.localAccountNumber === l.account.number &&
              String(x.prov.amountOre) === String(belopp) &&
              x.prov.side === (minSida === 'Debit' ? 'Credit' : 'Debit'),
          )
          if (!r)
            return block(
              'REVERSAL_ROWS_MISMATCH',
              `Rättelsens rad på konto ${l.account.number} (${(belopp / 100).toFixed(2)} kr ${minSida === 'Debit' ? 'debet' : 'kredit'}) motsvarar ingen rad i originalexporten ${original.nyckel} — stäm av manuellt i Fortnox`,
            )
          r.anvand = true
          const malkonto = r.prov.externalAccountNumber
          if (!Number.isSafeInteger(malkonto) || r.payload.Account !== malkonto)
            return block(
              'ORIGINAL_MAPPING_UNKNOWN',
              `Originalexportens rad saknar entydigt Fortnox-konto (${String(malkonto)})`,
            )
          // Dimensioner: denna version exporterar utan dimension; ett original med dimension kan inte
          // återföras exakt här och stoppas sanningsenligt.
          if (r.payload.CostCenter || r.payload.Project)
            return block(
              'REVERSAL_DIMENSION_UNSUPPORTED',
              `Originalexporten ${original.nyckel} bär kostnadsställe/projekt — rättelsen återförs inte automatiskt; stäm av manuellt i Fortnox`,
            )
          const mk = malkonto as number
          if (!iKontoklass(rk.roll as Roll, mk))
            return block(
              'ACCOUNT_CLASS_MISMATCH',
              `Originalets mål ${mk} ligger utanför kontoklassen ${klassText(rk.roll as Roll)}`,
            )
          const nu = await lasKonto(mk)
          if (!nu.exists || nu.active !== true)
            return block(
              'ACCOUNT_MAPPING_DRIFT',
              `Originalets Fortnox-konto ${mk} finns inte eller är inaktivt i räkenskapsår ${fy.Id} — ` +
                'rättelsen kan inte bokas på originalets konto; stäm av manuellt i Fortnox',
            )
          const tk = teknik(rk.roll, rk.behandling, nu, fy.Id, mk)
          if (tk.teknik !== 'FORENLIG')
            return block(
              tk.teknik === 'KONFLIKT' ? 'ACCOUNT_VAT_MISMATCH' : 'ACCOUNT_MAPPING_DRIFT',
              `Fortnox-konto ${mk}: ${tk.skal}`,
            )
          const tidigareO = malPerKonto.get(l.account.id)
          if (tidigareO !== undefined && tidigareO !== mk)
            return block(
              'ACCOUNT_MAPPING_AMBIGUOUS',
              `Konto ${l.account.number} har två olika målkonton i samma verifikat`,
            )
          mappningsrader.push({
            journalEntryLineId: l.id,
            roll: rk.roll,
            behandling: rk.behandling,
            kallkonto: l.account.number,
            malkonto: mk,
            mappningsradId: r.km?.mappningsradId ?? 'originalexport',
            ogonblick: r.km?.ogonblick ?? { namn: null, aktiv: null, momskod: null, ar: null },
          })
          if (tidigareO !== undefined) continue
          malPerKonto.set(l.account.id, mk)
          accounts.push({
            ...binding(
              `originalexport:${original.exportId}:${original.nyckel}:rev${original.revision}+GET /3/accounts/${mk}?financialyear=${fy.Id}`,
            ),
            localAccountId: l.account.id,
            localAccountNumber: l.account.number,
            externalAccountNumber: mk,
          })
          continue
        }
        // TESTKUND-041 (MJ-4 v2): momsjusteringens rader bokas på de FRYSTA målen i justeringsposten
        // (kostnad ur originalexporten, momsmål ur originalet eller infört en gång). Dagens mappning
        // används inte. Det frysta kontot måste finnas och vara aktivt i justeringens eget år.
        const fryst = klass.ok ? klass.frystaMal?.mal.get(l.id) : undefined
        if (klass.ok && klass.frystaMal) {
          if (fryst === undefined || !Number.isSafeInteger(fryst))
            return block(
              'ORIGINAL_MAPPING_UNKNOWN',
              'Momsjusteringens frysta mål saknas för en rad',
            )
          if (!iKontoklass(rk.roll as Roll, fryst))
            return block(
              'ACCOUNT_CLASS_MISMATCH',
              `Det frysta målet ${fryst} ligger utanför kontoklassen ${klassText(rk.roll as Roll)}`,
            )
          const nu = await lasKonto(fryst)
          if (!nu.exists || nu.active !== true)
            return block(
              'ACCOUNT_MAPPING_DRIFT',
              `Det frysta Fortnox-kontot ${fryst} finns inte eller är inaktivt i räkenskapsår ${fy.Id} — ` +
                'momsjusteringen kan inte bokas på originalets konto; stäm av manuellt i Fortnox',
            )
          const tk = teknik(rk.roll, rk.behandling, nu, fy.Id, fryst)
          if (tk.teknik !== 'FORENLIG')
            return block(
              tk.teknik === 'KONFLIKT' ? 'ACCOUNT_VAT_MISMATCH' : 'ACCOUNT_MAPPING_DRIFT',
              `Fortnox-konto ${fryst}: ${tk.skal}`,
            )
          const tidigareF = malPerKonto.get(l.account.id)
          if (tidigareF !== undefined && tidigareF !== fryst)
            return block(
              'ACCOUNT_MAPPING_AMBIGUOUS',
              `Konto ${l.account.number} har två olika målkonton i samma verifikat`,
            )
          mappningsrader.push({
            journalEntryLineId: l.id,
            roll: rk.roll,
            behandling: rk.behandling,
            kallkonto: l.account.number,
            malkonto: fryst,
            mappningsradId: 'fryst-momsjustering',
            ogonblick: {
              namn: nu.name ?? null,
              aktiv: nu.active ?? null,
              momskod: nu.vatCodePresent ? (nu.vatCode ?? null) : null,
              ar: fy.Id,
            },
          })
          if (tidigareF !== undefined) continue
          malPerKonto.set(l.account.id, fryst)
          accounts.push({
            ...binding(`${klass.frystaMal.kalla}+GET /3/accounts/${fryst}?financialyear=${fy.Id}`),
            localAccountId: l.account.id,
            localAccountNumber: l.account.number,
            externalAccountNumber: fryst,
          })
          continue
        }
        const rad = radFor(rk.roll, l.account.number, rk.behandling)
        if (!rad)
          return block(
            'ACCOUNT_MAPPING_MISSING',
            `Konto ${l.account.number} «${l.account.name}» som ${ROLL_TEXT[rk.roll]} ` +
              `(${BEHANDLING_TEXT[rk.behandling]}) saknar mappning i godkänd revision ${revision.revision}`,
          )
        // F-009-1: målets kontoklass prövas först och oberoende av revisionens sparade teknik.
        if (!iKontoklass(rad.role, rad.targetAccountNumber))
          return block(
            'ACCOUNT_CLASS_MISMATCH',
            `Konto ${l.account.number} som ${ROLL_TEXT[rk.roll]} mappas till Fortnox ` +
              `${rad.targetAccountNumber}, utanför kontoklassen ${klassText(rad.role)} — ` +
              'skapa och godkänn en ny revision',
          )
        const hinder = godkannandeHinder({
          role: rad.role,
          targetAccountNumber: rad.targetAccountNumber,
          technical: rad.technical,
          technicalReason: rad.technicalReason,
        })
        if (hinder)
          return block(
            'ACCOUNT_MAPPING_STALE',
            `Mappningen för konto ${l.account.number}: ${hinder}`,
          )
        const nu = await lasKonto(rad.targetAccountNumber)
        const d = drift(rad, nu)
        if (d)
          return block(
            'ACCOUNT_MAPPING_DRIFT',
            `Fortnox-konto ${rad.targetAccountNumber} har ändrats sedan revision ${revision.revision} ` +
              `godkändes (${d}) — skapa och godkänn en ny revision`,
          )
        const tk = teknik(rk.roll, rk.behandling, nu, fy.Id, rad.targetAccountNumber)
        if (tk.teknik !== 'FORENLIG')
          return block(
            tk.teknik === 'KONFLIKT' ? 'ACCOUNT_VAT_MISMATCH' : 'ACCOUNT_MAPPING_DRIFT',
            `Fortnox-konto ${rad.targetAccountNumber}: ${tk.skal}`,
          )
        const tidigare = malPerKonto.get(l.account.id)
        if (tidigare !== undefined && tidigare !== rad.targetAccountNumber)
          return block(
            'ACCOUNT_MAPPING_AMBIGUOUS',
            `Konto ${l.account.number} har två olika målkonton i samma verifikat`,
          )
        mappningsrader.push({
          journalEntryLineId: l.id,
          roll: rk.roll,
          behandling: rk.behandling,
          kallkonto: l.account.number,
          malkonto: rad.targetAccountNumber,
          mappningsradId: rad.id,
          ogonblick: {
            namn: rad.targetName,
            aktiv: rad.targetActive,
            momskod: rad.targetVatCode,
            ar: rad.targetYear,
          },
        })
        if (tidigare !== undefined) continue
        malPerKonto.set(l.account.id, rad.targetAccountNumber)
        accounts.push({
          ...binding(
            `kontomappning:rev${revision.revision}:${rad.id}+GET /3/accounts/${rad.targetAccountNumber}?financialyear=${fy.Id}`,
          ),
          localAccountId: l.account.id,
          localAccountNumber: l.account.number,
          externalAccountNumber: rad.targetAccountNumber,
        })
      }

      if (original && original.rader.some((r) => !r.anvand))
        return block(
          'REVERSAL_ROWS_MISMATCH',
          `Rättelsen återför inte hela originalexporten ${original.nyckel} — stäm av manuellt i Fortnox`,
        )
      const snapshot: LocalJournalEntrySnapshot = {
        inputOrigin: 'PERSISTED_JOURNAL_ENTRY',
        id: entry.id,
        organizationId: entry.organizationId,
        date: entry.date,
        eventDate: entry.eventDate,
        description: entry.description,
        reference: entry.reference,
        source: entry.source,
        sourceId: entry.sourceId,
        aiToolExecutionId: entry.aiToolExecutionId,
        fiscalYear: entry.fiscalYear,
        series: entry.series,
        verNumber: entry.verNumber,
        reversalOfEntryId: entry.reversalOfEntryId,
        lines: entry.lines.map((l) => ({
          id: l.id,
          journalEntryId: l.journalEntryId,
          accountId: l.accountId,
          debit: l.debit === null ? null : l.debit.toString(),
          credit: l.credit === null ? null : l.credit.toString(),
          description: l.description,
          account: l.account,
        })),
      }
      const config: FortnoxVoucherDraftConfig = {
        organizationId,
        externalCompany: {
          organizationNumber: orgNumber,
          databaseNumber: conn.fortnoxDatabaseNumber,
          evidenceRef: `GET /3/companyinformation@${at}`,
        },
        financialYear: {
          ...binding(`GET /3/financialyears@${date}`),
          localFiscalYear: entry.fiscalYear,
          id: fy.Id,
          voucherYear: fy.Id,
          fromDate: fy.FromDate,
          toDate: fy.ToDate,
        },
        voucherSeries: {
          ...binding(`GET /3/voucherseries/${conn.exportVoucherSeries}`),
          code: conn.exportVoucherSeries,
          financialYearId: fy.Id,
        },
        accounts,
        dimensions: {
          ...binding(
            `kundbeslut:utan-dimension:${conn.exportOmitDimensionsBy}@${conn.exportOmitDimensionsAt.toISOString()}`,
          ),
          mode: 'OMIT',
          reason: 'Evenos verifikatrader bär ingen dimension; ingen härleds.',
        },
      }
      const res = buildFortnoxVoucherDraft(snapshot, config)
      if (res.status !== 'READY_DRY_RUN') return block(res.reason.code, res.reason.message)
      const draft = {
        payload: res.payload,
        query: res.query,
        provenance: res.provenance,
        // K5.3: exportproveniens per rad (lokalt konto, roll/behandling, revision, mål, ögonblick).
        kontomappning: {
          revisionId: original ? original.revisionId : revision.id,
          revision: original ? original.revision : revision.revision,
          contentSha256: original ? original.contentSha256 : revision.contentSha256,
          handelse: klass.handelse,
          rader: mappningsrader,
          ...(klass.frystaMal
            ? { kalla: 'FRYSTA_MAL_MOMSJUSTERING', frystaMal: klass.frystaMal.kalla }
            : {}),
          // TESTKUND-027: en rättelse bär originalets exporterade mappning (inte dagens revision).
          ...(original
            ? {
                kalla: 'ORIGINALETS_EXPORT',
                originalExportId: original.exportId,
                originalJournalEntryId: klass.rattelseAv,
                originalFortnoxNyckel: original.nyckel,
              }
            : {}),
        },
        liveExportAllowed: false as const,
      }
      return {
        ok: true,
        draft,
        binding: {
          generation: conn.generation,
          databaseNumber: conn.fortnoxDatabaseNumber,
          accountingMethod: 'ACCRUAL',
        },
        // Stabil hash över INNEHÅLL och BINDNING — inte över evidensens tidsstämplar.
        // Samma verifikat, företag, anslutningsgeneration, år, serie och kundbeslut ger
        // samma hash; en förändring av något av dem ger ny hash (sändning kräver då ny
        // förhandskontroll).
        draftHash: createHash('sha256')
          .update(
            JSON.stringify({
              payload: res.payload,
              query: res.query,
              // TESTKUND-016 K1.6: textregeln och Eveno-råtexterna bakom exporttexten.
              text: {
                regelVersion: res.provenance.text.regelVersion,
                ra: [snapshot.description, ...snapshot.lines.map((l) => l.description)],
              },
              binding: {
                journalEntryId: entry.id,
                databaseNumber: conn.fortnoxDatabaseNumber,
                orgNumber,
                generation: conn.generation,
                financialYearId: fy.Id,
                series: conn.exportVoucherSeries,
                omitDimensionsAt: conn.exportOmitDimensionsAt.toISOString(),
                omitDimensionsBy: conn.exportOmitDimensionsBy,
                lines: res.provenance.lines.map((l) => [
                  l.journalEntryLineId,
                  l.localAccountNumber,
                  l.debit,
                  l.credit,
                ]),
                // K6.1: revision och, per rad, mål, roll och behandling.
                kontomappning: [
                  original ? `original:${original.exportId}:${original.revisionId}` : revision.id,
                  original ? original.contentSha256 : revision.contentSha256,
                  mappningsrader.map((r) => [
                    r.journalEntryLineId,
                    r.kallkonto,
                    r.malkonto,
                    r.roll,
                    r.behandling,
                  ]),
                ],
              },
            }),
          )
          .digest('hex'),
      }
    } catch (err) {
      if (err instanceof UnverifiedRef) return block(err.code, err.message)
      if (err instanceof FortnoxReadError) {
        if (err.kind === 'auth')
          await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED', reader.binding)
        return block(
          'FORTNOX_READ_FAILED',
          'Fortnox kunde inte läsas för förhandskontrollen; försök igen',
        )
      }
      throw err
    }
  }
}

/** En enskild referens (konto/serie) som Fortnox inte har (404/ogiltigt svar). */
class UnverifiedRef extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Detaljläsning där 'invalid' (t.ex. 404) betyder att referensen inte finns. */
async function getRef<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  code: string,
  message: string,
  query?: Record<string, string | number>,
): Promise<T> {
  try {
    return await reader.get<T>(token, path, query)
  } catch (err) {
    if (err instanceof FortnoxReadError && err.kind === 'invalid')
      throw new UnverifiedRef(code, message)
    throw err
  }
}

async function allPages<T>(
  reader: FortnoxLedgerReader,
  token: string,
  path: string,
  key: string,
): Promise<T[]> {
  // E4: strikt sidkontroll — giltiga heltal, TotalPages ≥ 1, oförändrade totaler på
  // varje sida, exakt antal och objektelement. Inkonsistens → ingen READY.
  const out: T[] = []
  let first: { tp: number; tr: number } | null = null
  const int = (x: unknown): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  for (let page = 1; ; page++) {
    const body = await reader.get<Record<string, unknown>>(token, path, { page, limit: 100 })
    if (isExactEmptyFirstPage(page, body, key)) return []
    const mi = (body?.MetaInformation ?? {}) as Record<string, unknown>
    const [cp, tp, tr] = [mi['@CurrentPage'], mi['@TotalPages'], mi['@TotalResources']]
    if (!int(cp) || !int(tp) || !int(tr) || tp < 1 || cp !== page)
      throw new FortnoxReadError('invalid')
    if (!first) first = { tp, tr }
    else if (first.tp !== tp || first.tr !== tr) throw new FortnoxReadError('invalid')
    const list = body?.[key]
    if (!Array.isArray(list)) throw new FortnoxReadError('invalid')
    if (list.some((x) => !x || typeof x !== 'object' || Array.isArray(x)))
      throw new FortnoxReadError('invalid')
    out.push(...(list as T[]))
    if (page >= first.tp) break
  }
  if (out.length !== first.tr) throw new FortnoxReadError('invalid')
  return out
}
