/**
 * INGEN JURIDISK DEFAULT I SCHEMAT.
 *
 * ── REGELN ──────────────────────────────────────────────────────────────────
 *
 * Ett `.default()` i det delade schemat är ett PÅSTÅENDE OM AVTALET. Skickar
 * klienten inte `sublettingAllowed`, och schemat fyller i `false`, har systemet
 * skrivit in ett andrahandsförbud som ingen part valde — och gjort det på en
 * plats där varken hyresvärden eller hyresgästen ser det.
 *
 * En uppsägningstid, en depositionsnivå eller en indexklausul som klienten inte
 * valt ska vara UTELÄMNAD. Servern avgör då per enhetstyp och hyresregim genom
 * `leases.compliance.ts`, eller avvisar kroppen. Det är skillnaden mellan att
 * systemet vet vad avtalet säger och att systemet gissar.
 *
 * ── VARFÖR ÄVEN DE "OFARLIGA" ───────────────────────────────────────────────
 *
 * `leaseType`, `tenancyRegime` och `depositAmount` har alla ett självklart
 * standardvärde i tjänsten (`'INDEFINITE'`, `resolveTenancyRegime(...)`, `0`).
 * De får ändå inte ha en default HÄR: en duplicerad default är en ANDRA
 * sanningskälla som kan glida från `leases.compliance.ts` utan att något blir
 * rött. Servern är den enda som får bestämma, för den är den enda som känner
 * enheten.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att TJÄNSTEN sätter rätt värde när fältet utelämnas — det ägs av
 * `leases.service.ts` egna prov. Här mäts bara att schemat inte tar beslutet.
 */
import {
  CreateLeaseSchema,
  CreateLeaseWithTenantSchema,
  UpdateLeaseSchema,
  LEASE_CONTRACT_TERMS,
  LEASE_CORE_FIELDS,
} from '@eken/shared'
import { z } from 'zod'

/**
 * Fälten juristens genomgång pekade ut som AVTALSBÄRANDE — var och en är ett
 * villkor en part kan åberopa. Listan är skriven ut med FLIT i stället för
 * härledd: den är juristens svar, och ska ändras bara av en ny genomgång.
 */
const AVTALSBARANDE_FALT = [
  // Formen och tiden
  'leaseType',
  'tenancyRegime',
  'startDate',
  'endDate',
  'renewalPeriodMonths',
  'noticePeriodMonths',
  // Pengarna
  'monthlyRent',
  'depositAmount',
  'parkingFee',
  'storageFee',
  'garageFee',
  // Vad som ingår i hyran
  'includesHeating',
  'includesWater',
  'includesHotWater',
  'includesElectricity',
  'includesInternet',
  'includesCleaning',
  'includesParking',
  'includesStorage',
  'includesLaundry',
  // Nyttjandet
  'usagePurpose',
  'petsAllowed',
  'petsApprovalNotes',
  'sublettingAllowed',
  'requiresHomeInsurance',
  // Indexklausulen
  'indexClauseType',
  'indexBaseYear',
  'indexAdjustmentDate',
  'indexMaxIncrease',
  'indexMinIncrease',
  'indexNotes',
  // Det fria
  'specialTerms',
] as const

/** Har fältet ett `.default()` någonstans i sin kedja av omslag? */
const harDefault = (falt: z.ZodTypeAny): boolean => {
  let nod: z.ZodTypeAny = falt
  // Zod nästar omslag: .optional().default(x) ger ZodDefault(ZodOptional(...)).
  // En kontroll som bara tittar på det YTTERSTA lagret missar därför en default
  // som ligger under ett optional-omslag.
  for (let i = 0; i < 10; i += 1) {
    if (nod instanceof z.ZodDefault) return true
    const inre = (nod as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType
    if (!inre) return false
    nod = inre
  }
  return false
}

const formOf = (s: z.ZodTypeAny): Record<string, z.ZodTypeAny> => {
  // superRefine ger en ZodEffects — objektet ligger under .innerType().
  const inre = s instanceof z.ZodEffects ? s.innerType() : s
  return (inre as unknown as z.ZodObject<z.ZodRawShape>).shape
}

describe('inget avtalsbärande fält har en default i schemat', () => {
  const scheman: Array<[string, z.ZodTypeAny]> = [
    ['CreateLeaseSchema', CreateLeaseSchema],
    ['UpdateLeaseSchema', UpdateLeaseSchema],
    ['CreateLeaseWithTenantSchema', CreateLeaseWithTenantSchema],
  ]

  it.each(scheman)('%s sätter inget avtalsvillkor åt parterna', (_namn, schema) => {
    const form = formOf(schema)
    const med = AVTALSBARANDE_FALT.filter((f) => form[f] && harDefault(form[f] as z.ZodTypeAny))
    expect(med).toEqual([])
  })

  /**
   * KANARIEFÅGEL — utan den kan provet ovan vara grönt av att `harDefault`
   * slutat känna igen en default, eller av att `formOf` gett en tom form.
   * Båda felen ser ut precis som framgång.
   */
  it('KANARIEFÅGEL: mekaniken KAN fälla — en injicerad default upptäcks', () => {
    const smittat = z.object({
      ...LEASE_CORE_FIELDS,
      ...LEASE_CONTRACT_TERMS,
      sublettingAllowed: z.boolean().optional().default(false),
    })
    const form = formOf(smittat)
    const med = AVTALSBARANDE_FALT.filter((f) => form[f] && harDefault(form[f] as z.ZodTypeAny))
    expect(med).toEqual(['sublettingAllowed'])
  })

  /**
   * ANDRA KANARIEFÅGELN: att listan faktiskt TRÄFFAR schemat. Står ett fältnamn
   * fel — en stavning, ett namnbyte — filtreras det bort av `form[f] &&` och
   * provet blir grönt om ett fält det aldrig tittade på.
   */
  it('KANARIEFÅGEL: varje namn i listan finns i CreateLeaseSchema', () => {
    const form = formOf(CreateLeaseSchema)
    const saknas = AVTALSBARANDE_FALT.filter((f) => !form[f])
    expect(saknas).toEqual([])
    expect(AVTALSBARANDE_FALT.length).toBe(32)
  })
})
