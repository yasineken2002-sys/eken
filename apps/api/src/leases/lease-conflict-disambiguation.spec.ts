/**
 * DE TVÅ UNIKA VILLKOREN PÅ `Lease` DELAR KOLUMNEN `unitId`.
 *
 * ── VARFÖR DET HÄR ÄR ETT EGET PROV ─────────────────────────────────────────
 *
 * `lease_unit_active_unique` (partiellt, ACTIVE) och
 * `Lease_unitId_tenantId_startDate_key` betyder helt olika saker: "lägenheten
 * har redan ett aktivt kontrakt" respektive "avtalet är redan registrerat".
 *
 * Igenkänningen matchade tidigare på `target.includes('unitId')`. Den formen
 * var entydig så länge `unitId` bara fanns i ETT unikt villkor — och slutade
 * vara det i samma stund som det andra tillkom. En dubblettkonflikt hade då
 * svarat "Lägenheten har redan ett aktivt kontrakt" om ett avtal som inte ens
 * är aktivt: en felaktig men trovärdig text, som skickar operatören att leta på
 * fel ställe.
 *
 * db-provet (`lease-unit-tenant-start-unique.db.spec.ts`) kan inte fånga det.
 * Det går genom `create()`, som bara har den ena grenen. Kapningen sitter i
 * `createWithTenant`, där båda grenarna finns i samma `catch`. Predikaten
 * prövas därför direkt — det är på den nivån kontraktet lever.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att grenarna anropas i rätt ORDNING i catch:en. Predikaten är ömsesidigt
 * uteslutande enligt proven nedan, så ordningen är ofarlig — men det är en
 * egenskap hos predikaten, inte en mätning av catch:en.
 */
// De riktiga klasserna drar in ESM-beroenden jest inte kan läsa (S3-klienten).
// Attrapperna ersätter bara konstruktorerna — predikaten som prövas är rena
// funktioner utan beroenden.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Prisma } from '@prisma/client'

import { isActiveUnitConflict, ärDubblettavtalskonflikt } from './leases.service'

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target },
  })

describe('Lease — de två unika villkoren skiljs åt', () => {
  it('AKTIVT-KONTRAKT-konflikten känns igen, och bara den', () => {
    const err = p2002(['unitId'])
    expect(isActiveUnitConflict(err)).toBe(true)
    expect(ärDubblettavtalskonflikt(err)).toBe(false)
  })

  it('DUBBLETTAVTAL-konflikten känns igen, och tas INTE för ett aktivt-kontrakt-race', () => {
    // Provet som den lösa `includes('unitId')`-formen hade fallit på.
    const err = p2002(['unitId', 'tenantId', 'startDate'])
    expect(ärDubblettavtalskonflikt(err)).toBe(true)
    expect(isActiveUnitConflict(err)).toBe(false)
  })

  it('namnformen för det partiella indexet känns fortfarande igen', () => {
    // Reserv: Prisma ger kolumnarrayen i dag (uppmätt), men formen har bytt förr.
    const err = p2002('lease_unit_active_unique')
    expect(isActiveUnitConflict(err)).toBe(true)
    expect(ärDubblettavtalskonflikt(err)).toBe(false)
  })

  it('MOTPROV: ett P2002 på något ANNAT är ingendera', () => {
    const err = p2002(['organizationId', 'contractNumber'])
    expect(isActiveUnitConflict(err)).toBe(false)
    expect(ärDubblettavtalskonflikt(err)).toBe(false)
  })

  it('MOTPROV: ett fel som inte är P2002 är ingendera', () => {
    const err = new Error('något annat')
    expect(isActiveUnitConflict(err)).toBe(false)
    expect(ärDubblettavtalskonflikt(err)).toBe(false)
  })
})
