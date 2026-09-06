import {
  CreateExpenseSchema,
  CreateJournalEntrySchema,
  CreateMeterSchema,
  CreatePropertySchema,
  UpdatePropertySchema,
  ApproveTerminationSchema,
  RejectTerminationSchema,
  UpdateTenantSchema,
  AnonymizeTenantSchema,
  CreateRentIncreaseSchema,
  CreateUnitSchema,
  UpdateUnitSchema,
  CreateEquipmentSchema,
  RegisterReplacementSchema,
  RejectRentIncreaseSchema,
  CreateReadingSchema,
  CreateSupplierInvoiceSchema,
  CreateTariffSchema,
  CreateCreditNoteSchema,
  RegisterPaymentSchema,
  CreateDepositSchema,
  RefundDepositSchema,
  BulkExportSchema,
  MarkSentSchema,
  PauseRemindersSchema,
  GenerateNoticesSchema,
  SendNoticesSchema,
  MarkNoticePaidSchema,
  CreateRentNoticeCreditSchema,
  ManualMatchSchema,
  ConfirmImportSchema,
  UpdateMeterSchema,
  CreateDelegationFromAssignmentSchema,
  RevokeDelegationSchema,
  CreateLeaseSchema,
  UpdateLeaseSchema,
  CreateLeaseWithTenantSchema,
  TransitionLeaseStatusSchema,
  TerminateLeaseSchema,
  RenewLeaseSchema,
  UpdateAppendixSchema,
  CreateSigningRequestSchema,
  InviteTenantsSchema,
  ResendInvitesSchema,
  CreateTicketSchema,
  SubmitTicketSchema,
  AddTicketCommentSchema,
  AddTenantCommentSchema,
} from '@eken/shared'
import { CreateJournalEntryDto } from '../../accounting/dto/create-journal-entry.dto'
import { CreateExpenseDto } from '../../accounting/dto/create-expense.dto'
import { CreateSupplierInvoiceDto } from '../../accounting/dto/supplier-invoice.dto'
import { CreatePropertyDto } from '../../properties/dto/create-property.dto'
import { UpdatePropertyDto } from '../../properties/dto/update-property.dto'
import { ApproveTerminationDto } from '../../terminations/dto/approve-termination.dto'
import { RejectTerminationDto } from '../../terminations/dto/reject-termination.dto'
import { UpdateTenantDto } from '../../tenants/dto/update-tenant.dto'
import { AnonymizeTenantDto } from '../../tenants/dto/anonymize-tenant.dto'
import { CreateRentIncreaseDto } from '../../rent-increases/dto/create-rent-increase.dto'
import { CreateUnitDto } from '../../units/dto/create-unit.dto'
import { UpdateUnitDto } from '../../units/dto/update-unit.dto'
import { CreateEquipmentDto } from '../../equipment/dto/create-equipment.dto'
import { RegisterReplacementDto } from '../../equipment/dto/register-replacement.dto'
import { RejectRentIncreaseDto } from '../../rent-increases/dto/reject-rent-increase.dto'
import { CreateMeterDto } from '../../consumption/dto/create-meter.dto'
import { UpdateMeterDto } from '../../consumption/dto/update-meter.dto'
import { RecordReadingDto } from '../../consumption/dto/record-reading.dto'
import { CreateTariffDto } from '../../consumption/dto/create-tariff.dto'
import { CreateCreditNoteDto } from '../../invoices/dto/create-credit-note.dto'
import { RegisterPaymentDto } from '../../invoices/dto/register-payment.dto'
import { CreateDepositDto } from '../../deposits/dto/create-deposit.dto'
import { RefundDepositDto } from '../../deposits/dto/refund-deposit.dto'
import { CreateLeaseDto } from '../../leases/dto/create-lease.dto'
import { UpdateLeaseDto } from '../../leases/dto/update-lease.dto'
import { CreateLeaseWithTenantDto } from '../../leases/dto/create-lease-with-tenant.dto'
import { TransitionLeaseStatusDto } from '../../leases/dto/transition-status.dto'
import { TerminateLeaseDto } from '../../leases/dto/terminate-lease.dto'
import { RenewLeaseDto } from '../../leases/dto/renew-lease.dto'
import { UpdateAppendixDto } from '../../contracts/dto/update-appendix.dto'
import { CreateSigningRequestDto } from '../../signing/dto/create-signing-request.dto'
import { InviteTenantsDto, ResendInvitesDto } from '../../tenant-portal/dto/invite-tenants.dto'
import {
  AddTenantCommentDto,
  SubmitMaintenanceDto,
} from '../../tenant-portal/dto/submit-maintenance.dto'
import { CreateMaintenanceTicketDto } from '../../maintenance/dto/create-maintenance-ticket.dto'
import { AddTicketCommentDto } from '../../maintenance/dto/add-ticket-comment.dto'
import {
  BulkExportDto,
  MarkSentDto,
  PauseRemindersDto,
} from '../../collections/dto/collections.dto'
import { GenerateNoticesDto } from '../../avisering/dto/generate-notices.dto'
import { SendNoticesDto } from '../../avisering/dto/send-notices.dto'
import { MarkPaidDto } from '../../avisering/dto/mark-paid.dto'
import { CreateRentNoticeCreditDto } from '../../avisering/dto/create-rent-notice-credit.dto'
import { ManualMatchDto } from '../../reconciliation/dto/manual-match.dto'
import { ConfirmImportDto } from '../../reconciliation/dto/confirm-import.dto'
import { RevokeDelegationDto } from '../../ai/delegation/dto/revoke-delegation.dto'
import { CreateFromAssignmentDto } from '../../ai/delegation/dto/create-from-assignment.dto'

import type { ZodType } from 'zod'

/**
 * VARJE DELAT SCHEMA SOM HAR EN DTO — uppräkningen, på ett ställe.
 *
 * ── VARFÖR EN REGISTRERING OCH INTE ETT PROV PER ENDPOINT ───────────────────
 *
 * Ett prov per endpoint täcker de endpoints någon kom ihåg att skriva ett prov
 * för. Den sjätte kopplingen glider då isär tyst, vilket är exakt formen på det
 * fel hela kontraktsarbetet finns för att hindra.
 *
 * Listan här är därför ENDA uppräkningen, och `check-request-contract.mjs`
 * kräver att den är FULLSTÄNDIG: varje nyttolasttyp webben skickar ur
 * @eken/shared måste stå här. Ett tillägg som glöms bort blir rött i CI, inte
 * tyst.
 *
 * ── VAD VARJE POST BÄR ──────────────────────────────────────────────────────
 *
 * `giltig` och `ogiltig` är inte pynt: paritetsprovet kör dem genom BÅDA
 * beskrivningarna (Zod-schemat och DTO:n via riktig ValidationPipe) och kräver
 * samma svar. Utan ett `ogiltig`-fall kunde en DTO som godtar allt vara grön.
 *
 * `ogiltigVarfor` säger vad fallet BRYTER mot — annars går det inte att se om
 * provet mäter regeln man tror.
 */
export interface KontraktsPost {
  /** Endpointen som tar emot kroppen. Står i felmeddelanden. */
  endpoint: string
  /** Namnet på `z.infer`-typen, som vakten matchar mot webbens importer. */
  inputTyp: string
  schema: ZodType<unknown>
  dto: unknown
  giltig: Record<string, unknown>
  ogiltig: Record<string, unknown>
  ogiltigVarfor: string
}

const adress = { street: 'Storgatan 1', city: 'Stockholm', postalCode: '11122', country: 'SE' }

export const KONTRAKTSREGISTER: readonly KontraktsPost[] = [
  {
    endpoint: 'POST /accounting/journal-entries',
    inputTyp: 'CreateJournalEntryInput',
    schema: CreateJournalEntrySchema,
    dto: CreateJournalEntryDto,
    giltig: {
      date: '2026-09-01',
      description: 'Omföring mellan konton',
      lines: [
        { accountNumber: 1930, debit: 100 },
        { accountNumber: 1510, credit: 100 },
      ],
    },
    ogiltig: {
      date: '2026-09-01',
      description: 'Enbent verifikat',
      lines: [{ accountNumber: 1930, debit: 100 }],
    },
    ogiltigVarfor: 'ett verifikat behöver minst två rader',
  },
  {
    endpoint: 'POST /accounting/expenses',
    inputTyp: 'CreateExpenseInput',
    schema: CreateExpenseSchema,
    dto: CreateExpenseDto,
    giltig: {
      date: '2026-09-01',
      description: 'Reparation trapphus',
      amount: 1250,
      accountNumber: 5070,
    },
    ogiltig: {
      date: '2026-09-01',
      description: 'Reparation trapphus',
      amount: 0,
      accountNumber: 5070,
    },
    ogiltigVarfor: 'beloppet måste vara större än noll',
  },
  {
    endpoint: 'POST /accounting/supplier-invoices',
    inputTyp: 'CreateSupplierInvoiceInput',
    schema: CreateSupplierInvoiceSchema,
    dto: CreateSupplierInvoiceDto,
    giltig: {
      supplierName: 'Rörjouren AB',
      description: 'Stambyte trapphus B',
      invoiceDate: '2026-09-01',
      dueDate: '2026-10-01',
      expenseAccount: 5070,
      amount: 1250,
      vatRate: 25,
    },
    ogiltig: {
      description: 'Stambyte trapphus B',
      invoiceDate: '2026-09-01',
      dueDate: '2026-10-01',
      expenseAccount: 5070,
      amount: 1250,
      vatRate: 25,
    },
    ogiltigVarfor: 'supplierName saknas — exakt formen som gav 400 i #795',
  },
  {
    endpoint: 'POST /properties',
    inputTyp: 'CreatePropertyInput',
    schema: CreatePropertySchema,
    dto: CreatePropertyDto,
    giltig: {
      name: 'Kvarteret Eken 1',
      propertyDesignation: 'EKEN 1:1',
      type: 'RESIDENTIAL',
      address: adress,
      totalArea: 850,
    },
    ogiltig: {
      name: 'Kvarteret Eken 1',
      propertyDesignation: 'EKEN 1:1',
      type: 'HYRESHUS',
      address: adress,
      totalArea: 850,
    },
    ogiltigVarfor: 'HYRESHUS är ingen giltig fastighetstyp',
  },
  {
    endpoint: 'PATCH /properties/:id',
    inputTyp: 'UpdatePropertyInput',
    schema: UpdatePropertySchema,
    dto: UpdatePropertyDto,
    // PARTIELL MED FLIT: en redigering skickar bara de fält som ändrats, och
    // BÅDA vägarna ska acceptera det. Ett prov med alla fält satta hade inte
    // prövat partialiteten — den är hela skillnaden mot POST.
    giltig: { name: 'Kvarteret Eken 2' },
    ogiltig: { type: 'HYRESHUS' },
    ogiltigVarfor: 'HYRESHUS är ingen giltig fastighetstyp — även i en partiell uppdatering',
  },
  {
    endpoint: 'PATCH /terminations/:id/approve',
    inputTyp: 'ApproveTerminationInput',
    schema: ApproveTerminationSchema,
    dto: ApproveTerminationDto,
    // TOM KROPP ÄR GILTIG och det är hela poängen: utelämnat `effectiveDate`
    // betyder att servern beräknar slutdatumet ur uppsägningstiden. Ett prov
    // som krävde fältet hade cementerat motsatsen.
    giltig: { effectiveDate: '2026-12-31' },
    ogiltig: { effectiveDate: 'sista december' },
    ogiltigVarfor: 'effectiveDate måste vara ett ISO-datum, inte fritext',
  },
  {
    endpoint: 'PATCH /terminations/:id/reject',
    inputTyp: 'RejectTerminationInput',
    schema: RejectTerminationSchema,
    dto: RejectTerminationDto,
    giltig: { reason: 'Uppsägningen saknar underskrift' },
    ogiltig: { reason: 'x'.repeat(501) },
    ogiltigVarfor: 'motiveringen får vara högst 500 tecken',
  },
  {
    endpoint: 'PATCH /tenants/:id',
    inputTyp: 'UpdateTenantInput',
    schema: UpdateTenantSchema,
    dto: UpdateTenantDto,
    // FLAT adress. Den nästlade formen fanns bara i webbens egen typ och i det
    // gamla schemat — DTO:n har alltid tagit street/city/postalCode.
    giltig: { email: 'ny@example.se', street: 'Ekgatan 1', city: 'Lund' },
    ogiltig: { email: 'inte-en-adress' },
    ogiltigVarfor: 'e-postadressen valideras av båda vägarna',
  },
  {
    endpoint: 'POST /tenants/:id/anonymize',
    inputTyp: 'AnonymizeTenantInput',
    schema: AnonymizeTenantSchema,
    dto: AnonymizeTenantDto,
    giltig: { reason: 'Begäran om radering, ärende 2026-114' },
    ogiltig: { reason: 'x'.repeat(501) },
    ogiltigVarfor: 'skälet får vara högst 500 tecken',
  },
  {
    endpoint: 'POST /rent-increases',
    inputTyp: 'CreateRentIncreaseInput',
    schema: CreateRentIncreaseSchema,
    dto: CreateRentIncreaseDto,
    giltig: {
      leaseId: '11111111-2222-4333-8444-555555555555',
      newRent: 9500,
      reason: 'Indexuppräkning enligt avtal',
      effectiveDate: '2027-01-01',
    },
    ogiltig: {
      leaseId: '11111111-2222-4333-8444-555555555555',
      newRent: 9500,
      reason: 'ok',
      effectiveDate: '2027-01-01',
    },
    ogiltigVarfor: 'motiveringen måste vara minst 3 tecken — hyresgästen ska kunna förstå den',
  },
  {
    endpoint: 'PATCH /rent-increases/:id/reject',
    inputTyp: 'RejectRentIncreaseInput',
    schema: RejectRentIncreaseSchema,
    dto: RejectRentIncreaseDto,
    giltig: { rejectionReason: 'Höjningen överstiger jämförbara lägenheter' },
    // OBLIGATORISKT, till skillnad från uppsägningens `reason`. Ett avslag utan
    // skäl är inte spårbart, och båda vägarna kräver det.
    ogiltig: {},
    ogiltigVarfor: 'rejectionReason är obligatorisk',
  },
  {
    endpoint: 'POST /units',
    inputTyp: 'CreateUnitInput',
    schema: CreateUnitSchema,
    dto: CreateUnitDto,
    // `propertyId` MED: schemat saknade det, och utan fastigheten kan ingen
    // lägenhet skapas. Ett prov utan fältet hade inte visat att det nu finns.
    giltig: {
      propertyId: '11111111-2222-4333-8444-555555555555',
      name: 'Lgh 1201',
      unitNumber: '1201',
      type: 'APARTMENT',
      area: 62,
      monthlyRent: 9500,
    },
    ogiltig: {
      propertyId: 'inte-ett-uuid',
      name: 'Lgh 1201',
      unitNumber: '1201',
      type: 'APARTMENT',
      area: 62,
      monthlyRent: 9500,
    },
    ogiltigVarfor: 'propertyId måste vara ett UUID — båda vägarna kräver det',
  },
  {
    endpoint: 'PATCH /units/:id',
    inputTyp: 'UpdateUnitInput',
    schema: UpdateUnitSchema,
    dto: UpdateUnitDto,
    // PARTIELL: ett fält räcker, vilket är hela skillnaden mot POST.
    giltig: { monthlyRent: 10200 },
    ogiltig: { type: 'RADHUS' },
    ogiltigVarfor: 'RADHUS är ingen giltig lägenhetstyp — även i en partiell uppdatering',
  },
  {
    endpoint: 'POST /equipment',
    inputTyp: 'CreateEquipmentInput',
    schema: CreateEquipmentSchema,
    dto: CreateEquipmentDto,
    giltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      kind: 'REFRIGERATOR',
      installedAt: '2026-01-15',
    },
    ogiltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      kind: 'KYLSKÅP',
      installedAt: '2026-01-15',
    },
    ogiltigVarfor: 'KYLSKÅP är inget värde i EQUIPMENT_KINDS — listan bor nu på ETT ställe',
  },
  {
    endpoint: 'POST /equipment/:id/replacement',
    inputTyp: 'RegisterReplacementInput',
    schema: RegisterReplacementSchema,
    dto: RegisterReplacementDto,
    // `maintenanceTicketId` MED: fältet saknades i webbens egen typ, så
    // kopplingen till felanmälan gick inte att sätta från gränssnittet.
    giltig: {
      occurredAt: '2026-09-01',
      maintenanceTicketId: '11111111-2222-4333-8444-555555555555',
      cost: 4500,
    },
    ogiltig: { occurredAt: '2026-09-01', cost: -1 },
    ogiltigVarfor: 'kostnaden kan inte vara negativ',
  },
  {
    endpoint: 'POST /consumption/meters',
    inputTyp: 'CreateMeterInput',
    schema: CreateMeterSchema,
    dto: CreateMeterDto,
    giltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    },
    ogiltig: { unitId: 'inte-ett-uuid', type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
    ogiltigVarfor: 'unitId måste vara ett UUID',
  },
  {
    endpoint: 'PATCH /consumption/meters/:id',
    inputTyp: 'UpdateMeterInput',
    schema: UpdateMeterSchema,
    dto: UpdateMeterDto,
    giltig: { status: 'ACTIVE', serialNumber: 'ABC-1' },
    ogiltig: { status: 'TRASIG' },
    ogiltigVarfor: 'TRASIG är ingen giltig mätarstatus',
  },
  {
    endpoint: 'POST /consumption/readings',
    inputTyp: 'CreateReadingInput',
    schema: CreateReadingSchema,
    dto: RecordReadingDto,
    giltig: {
      meterId: '11111111-2222-4333-8444-555555555555',
      value: 1234.5,
      source: 'MANUAL',
      readingDate: '2026-09-01',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    },
    ogiltig: {
      meterId: '11111111-2222-4333-8444-555555555555',
      value: 1234.5,
      source: 'HANDPÅLÄGGNING',
      readingDate: '2026-09-01',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    },
    ogiltigVarfor: 'okänd avläsningskälla',
  },
  {
    endpoint: 'POST /consumption/tariffs',
    inputTyp: 'CreateTariffInput',
    schema: CreateTariffSchema,
    dto: CreateTariffDto,
    giltig: {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: 2.5,
      validFrom: '2026-01-01',
    },
    ogiltig: {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: -1,
      validFrom: '2026-01-01',
    },
    ogiltigVarfor: 'priset kan inte vara negativt',
  },
  {
    endpoint: 'POST /invoices/:id/pay',
    inputTyp: 'RegisterPaymentInput',
    schema: RegisterPaymentSchema,
    dto: RegisterPaymentDto,
    giltig: { amount: 1250, paymentMethod: 'BANK', reference: '1234567' },
    ogiltig: { amount: 0, paymentMethod: 'BANK' },
    ogiltigVarfor: 'ett inbetalt belopp kan inte vara noll',
  },
  {
    endpoint: 'POST /invoices/:id/credit-note',
    inputTyp: 'CreateCreditNoteInput',
    schema: CreateCreditNoteSchema,
    dto: CreateCreditNoteDto,
    giltig: {
      lines: [
        {
          invoiceLineId: '11111111-2222-4333-8444-555555555555',
          quantity: 1,
          unitPrice: 500,
        },
      ],
      reason: 'Felaktigt debiterad avgift',
    },
    ogiltig: {
      lines: [
        {
          invoiceLineId: '11111111-2222-4333-8444-555555555555',
          quantity: 1,
          unitPrice: 500,
        },
      ],
      reason: 'fel',
    },
    ogiltigVarfor:
      'skälet är kortare än fem tecken — en kreditering utan skäl går inte att granska',
  },
  // ─── Hyresavtalet: tio poster, åtta med kropp ──────────────────────────────
  //
  // De två återstående (`POST /leases/:id/initial-notices` och
  // `POST /contracts/generate/:leaseId`) tar INGEN kropp — de skickade tidigare
  // `{}`, vilket såg ut som ett kontrakt utan att vara ett. Nyttolasten är
  // borttagen i webben i stället för beskriven här.
  {
    endpoint: 'POST /leases',
    inputTyp: 'CreateLeaseInput',
    schema: CreateLeaseSchema,
    dto: CreateLeaseDto,
    giltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      tenantId: '22222222-3333-4444-8555-666666666666',
      startDate: '2026-01-01',
      monthlyRent: 12000,
    },
    // MINIMUM per enhetstyp (3 mån bostad, 9 mån lokal) ägs av servern, som
    // läser unit.type. Schemat kan bara säga att noll inte är en uppsägningstid.
    ogiltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      tenantId: '22222222-3333-4444-8555-666666666666',
      startDate: '2026-01-01',
      monthlyRent: 12000,
      noticePeriodMonths: 0,
    },
    ogiltigVarfor: 'noll månaders uppsägningstid är ingen uppsägningstid (JB 12 kap 4 §)',
  },
  {
    endpoint: 'PATCH /leases/:id',
    inputTyp: 'UpdateLeaseInput',
    schema: UpdateLeaseSchema,
    dto: UpdateLeaseDto,
    giltig: { monthlyRent: 13000 },
    ogiltig: { indexBaseYear: 2026 },
    ogiltigVarfor:
      'ett indexfält utan indexklausul är en motsägelse — basåret beskriver en klausul som inte finns',
  },
  {
    endpoint: 'POST /leases/with-tenant',
    inputTyp: 'CreateLeaseWithTenantInput',
    schema: CreateLeaseWithTenantSchema,
    dto: CreateLeaseWithTenantDto,
    giltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      existingTenantId: '22222222-3333-4444-8555-666666666666',
      startDate: '2026-01-01',
      monthlyRent: 12000,
    },
    ogiltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      startDate: '2026-01-01',
      monthlyRent: 12000,
    },
    ogiltigVarfor:
      'varken befintlig hyresgäst eller uppgifter för en ny — avtalet skulle sakna motpart',
  },
  {
    endpoint: 'PATCH /leases/:id/status',
    inputTyp: 'TransitionLeaseStatusInput',
    schema: TransitionLeaseStatusSchema,
    dto: TransitionLeaseStatusDto,
    giltig: { status: 'ACTIVE' },
    ogiltig: { status: 'AKTIV' },
    ogiltigVarfor: 'AKTIV är inte ett av avtalets fyra tillstånd',
  },
  {
    endpoint: 'PATCH /leases/:id/terminate',
    inputTyp: 'TerminateLeaseInput',
    schema: TerminateLeaseSchema,
    dto: TerminateLeaseDto,
    giltig: { terminationReason: 'Hyresgästen flyttar', effectiveDate: '2026-06-30' },
    ogiltig: { effectiveDate: '30 juni 2026' },
    ogiltigVarfor: 'ett uppsägningsdatum måste vara ett ISO-datum, inte fritext',
  },
  {
    endpoint: 'PATCH /leases/:id/renew',
    inputTyp: 'RenewLeaseInput',
    schema: RenewLeaseSchema,
    dto: RenewLeaseDto,
    giltig: { newEndDate: '2027-12-31', monthlyRent: 13000 },
    ogiltig: { monthlyRent: -1 },
    ogiltigVarfor: 'en negativ hyra är ingen hyra',
  },
  {
    endpoint: 'PATCH /contracts/:leaseId/appendices/:documentId',
    inputTyp: 'UpdateAppendixInput',
    schema: UpdateAppendixSchema,
    dto: UpdateAppendixDto,
    giltig: { attachedToLeaseAsAppendix: true, category: 'ENERGY_DECLARATION', appendixOrder: 1 },
    ogiltig: { appendixOrder: -1 },
    ogiltigVarfor: 'bilagans ordning är ett index, inte ett negativt tal',
  },
  {
    endpoint: 'POST /signing/requests',
    inputTyp: 'CreateSigningRequestInput',
    schema: CreateSigningRequestSchema,
    dto: CreateSigningRequestDto,
    giltig: { documentId: '33333333-4444-4555-8666-777777777777' },
    ogiltig: { documentId: 'inte-ett-uuid' },
    ogiltigVarfor: 'documentId måste vara ett UUID',
  },
  // ─── Hyresgästportalens inbjudningar ──────────────────────────────────────
  {
    endpoint: 'POST /tenant-portal/admin/invitations',
    inputTyp: 'InviteTenantsInput',
    schema: InviteTenantsSchema,
    dto: InviteTenantsDto,
    giltig: { all: true },
    ogiltig: {},
    ogiltigVarfor:
      'varken alla eller ett urval — ett massutskick utan mottagare svarade 201 med noll inbjudna',
  },
  {
    endpoint: 'POST /tenant-portal/admin/invitations/resend',
    inputTyp: 'ResendInvitesInput',
    schema: ResendInvitesSchema,
    dto: ResendInvitesDto,
    giltig: { onlyNotActivated: true },
    ogiltig: {},
    ogiltigVarfor: 'varken urval eller "bara ej aktiverade" — omsändningen saknar mottagare',
  },
  // ─── Felanmälan: EN BAS, TVÅ DELMÄNGDER ───────────────────────────────────
  {
    endpoint: 'POST /maintenance',
    inputTyp: 'CreateTicketInput',
    schema: CreateTicketSchema,
    dto: CreateMaintenanceTicketDto,
    giltig: {
      title: 'Läckande kran',
      description: 'Kranen i köket droppar dygnet runt sedan i måndags.',
      propertyId: '11111111-2222-4333-8444-555555555555',
    },
    ogiltig: {
      title: 'Kran',
      description: 'Droppar',
      propertyId: '11111111-2222-4333-8444-555555555555',
    },
    ogiltigVarfor:
      'en beskrivning på sju tecken är ingen felanmälan — och utan tak blir kostnaden per ärende obunden uppåt',
  },
  {
    endpoint: 'POST /portal/maintenance',
    inputTyp: 'SubmitTicketInput',
    schema: SubmitTicketSchema,
    dto: SubmitMaintenanceDto,
    giltig: {
      title: 'Läckande kran',
      description: 'Kranen i köket droppar dygnet runt sedan i måndags.',
    },
    // Hyresgästen får INTE peka ut en fastighet — den härleds ur avtalet.
    ogiltig: {
      title: 'Läckande kran',
      description: 'Kranen i köket droppar dygnet runt sedan i måndags.',
      propertyId: '11111111-2222-4333-8444-555555555555',
    },
    ogiltigVarfor:
      'propertyId är ägarens fält — en hyresgäst som får sätta det kan anmäla fel på någon annans fastighet',
  },
  {
    endpoint: 'POST /maintenance/:id/comments',
    inputTyp: 'AddTicketCommentInput',
    schema: AddTicketCommentSchema,
    dto: AddTicketCommentDto,
    giltig: { content: 'Rörmokare bokad till torsdag.', isInternal: true },
    ogiltig: { content: '' },
    ogiltigVarfor: 'en tom kommentar är ingen kommentar',
  },
  {
    endpoint: 'POST /portal/maintenance/:id/comment',
    inputTyp: 'AddTenantCommentInput',
    schema: AddTenantCommentSchema,
    dto: AddTenantCommentDto,
    giltig: { content: 'Det droppar fortfarande.' },
    // `isInternal` är hyresvärdens anteckning om ärendet — inte något den som
    // anmäler kan skriva om sig själv.
    ogiltig: { content: 'Det droppar fortfarande.', isInternal: true },
    ogiltigVarfor: 'en hyresgäst kan inte skriva en INTERN kommentar',
  },
  {
    endpoint: 'POST /deposits',
    inputTyp: 'CreateDepositInput',
    schema: CreateDepositSchema,
    dto: CreateDepositDto,
    giltig: { leaseId: '11111111-2222-4333-8444-555555555555', amount: 12000 },
    ogiltig: { leaseId: 'inte-ett-uuid', amount: 12000 },
    ogiltigVarfor: 'leaseId måste vara ett UUID',
  },
  {
    endpoint: 'PATCH /deposits/:id/refund',
    inputTyp: 'RefundDepositInput',
    schema: RefundDepositSchema,
    dto: RefundDepositDto,
    giltig: {
      refundAmount: 9000,
      deductions: [{ reason: 'Skadad diskmaskin', amount: 3000 }],
    },
    ogiltig: { refundAmount: -1 },
    ogiltigVarfor: 'ett återbetalningsbelopp kan inte vara negativt',
  },
  {
    endpoint: 'POST /collections/bulk-export',
    inputTyp: 'BulkExportInput',
    schema: BulkExportSchema,
    dto: BulkExportDto,
    giltig: { invoiceIds: ['11111111-2222-4333-8444-555555555555'] },
    ogiltig: { invoiceIds: ['inte-ett-uuid'] },
    ogiltigVarfor: 'varje faktura-id måste vara ett UUID',
  },
  {
    endpoint: 'POST /collections/mark-sent/:invoiceId',
    inputTyp: 'MarkSentInput',
    schema: MarkSentSchema,
    dto: MarkSentDto,
    giltig: { note: 'Skickad till Intrum 2026-09-01' },
    ogiltig: { note: '' },
    ogiltigVarfor: 'en tom anteckning är inte samma sak som ingen anteckning',
  },
  {
    endpoint: 'PATCH /collections/reminders/:invoiceId/pause',
    inputTyp: 'PauseRemindersInput',
    schema: PauseRemindersSchema,
    dto: PauseRemindersDto,
    giltig: { reason: 'Avbetalningsplan överenskommen' },
    ogiltig: { reason: 42 },
    ogiltigVarfor: 'skälet måste vara text',
  },
  {
    endpoint: 'POST /avisering/generate',
    inputTyp: 'GenerateNoticesInput',
    schema: GenerateNoticesSchema,
    dto: GenerateNoticesDto,
    giltig: { month: 9, year: 2026 },
    ogiltig: { month: 13, year: 2026 },
    ogiltigVarfor: 'månad 13 finns inte',
  },
  {
    endpoint: 'POST /avisering/send',
    inputTyp: 'SendNoticesInput',
    schema: SendNoticesSchema,
    dto: SendNoticesDto,
    giltig: { noticeIds: ['11111111-2222-4333-8444-555555555555'] },
    ogiltig: { noticeIds: ['inte-ett-uuid'] },
    ogiltigVarfor: 'varje avi-id måste vara ett UUID',
  },
  {
    endpoint: 'PATCH /avisering/:id/paid',
    inputTyp: 'MarkNoticePaidInput',
    schema: MarkNoticePaidSchema,
    dto: MarkPaidDto,
    giltig: { paidAmount: 12000, paymentMethod: 'BANK' },
    ogiltig: { paidAmount: 12000, paymentMethod: 'Bankgiro' },
    ogiltigVarfor: 'Bankgiro är en ETIKETT, inte ett enumvärde — se betalsättsprovet nedan',
  },
  {
    endpoint: 'POST /avisering/:id/credit',
    inputTyp: 'CreateRentNoticeCreditInput',
    schema: CreateRentNoticeCreditSchema,
    dto: CreateRentNoticeCreditDto,
    giltig: { lines: [{ amount: 500 }], reason: 'Felaktig hyresdebitering' },
    ogiltig: { lines: [], reason: 'Felaktig hyresdebitering' },
    ogiltigVarfor: 'en kreditering utan poster krediterar ingenting',
  },
  {
    endpoint: 'PATCH /reconciliation/transactions/:id/match',
    inputTyp: 'ManualMatchInput',
    schema: ManualMatchSchema,
    dto: ManualMatchDto,
    giltig: { invoiceId: '11111111-2222-4333-8444-555555555555' },
    ogiltig: { invoiceId: 'inte-ett-uuid' },
    ogiltigVarfor: 'invoiceId måste vara ett UUID',
  },
  {
    endpoint: 'POST /reconciliation/imports/:id/confirm',
    inputTyp: 'ConfirmImportInput',
    schema: ConfirmImportSchema,
    dto: ConfirmImportDto,
    giltig: {
      transactions: [
        { date: '2026-09-01', description: 'Hyra sep', ocr: '1234567', amount: 12000 },
      ],
    },
    ogiltig: {
      transactions: [{ date: '2026-09-01', description: 'Hyra sep', amount: 'tolvtusen' }],
    },
    ogiltigVarfor: 'beloppet måste vara ett tal',
  },
  {
    // Etapp 7 (G2). "Gör alltid så här" — delegationen som föds ur ett godkänt
    // förslag. Villkoret är ett OTYPAT objekt med flit (fältnamnen härleds ur
    // SKUGGFALT[0]), så pariteten prövar frekvensvillkorets gränser i stället:
    // de är de enda tal i nyttolasten som kan glida isär.
    endpoint: 'POST /agent/delegations/from-assignment/:assignmentId',
    inputTyp: 'CreateDelegationFromAssignmentInput',
    schema: CreateDelegationFromAssignmentSchema,
    dto: CreateFromAssignmentDto,
    giltig: { frekvensvillkor: { maxAntal: 3, periodDagar: 7 } },
    ogiltig: { frekvensvillkor: { maxAntal: 0, periodDagar: 7 } },
    ogiltigVarfor: 'ett tak på noll är inte ett tak — det är en avstängning i förklädnad',
  },
  {
    // Etapp 7 PR 3. Återkallandet. Enda fältet är ett frivilligt skäl, så
    // pariteten prövar TAKET — det enda i nyttolasten som kan glida isär, och
    // det som avgör om en inklistrad e-posttråd kan göra en historikrad oläsbar.
    endpoint: 'POST /agent/delegations/:id/revoke',
    inputTyp: 'RevokeDelegationInput',
    schema: RevokeDelegationSchema,
    dto: RevokeDelegationDto,
    giltig: { skäl: 'Vi sköter det manuellt igen.' },
    ogiltig: { skäl: 'x'.repeat(501) },
    ogiltigVarfor: 'ett skäl över 500 tecken gör historikraden oläsbar för allt annat',
  },
]
