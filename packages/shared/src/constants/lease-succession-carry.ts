// ── Succession-carry: vilka villkor en förnyelse bär vidare (T1.3) ──────────
// Kanonisk källa för VILKA Lease-fält som kopieras rakt av från det gamla
// avtalet till det nya vid succession (renew/autoRenew). Före T1.3 kopierade
// förnyelsen bara ~10 handplockade fält — resten föll tyst tillbaka till
// schema-defaults ("villkorsförlust"), inklusive 🔴 `monthlyRentExcludingVat`:
// en momspliktig lokal (frivillig skattskyldighet, ML 1994:200) vars förnyelse
// tappade fältet slutade TYST ta ut utgående moms (2611) på gap-avin och varje
// efterföljande avi = Skatteverket-avvikelse. Carry-listan + DMMF-testet är
// skyddet mot att det händer igen.
//
// Härledning (låst plan 2026-07-08): LEASE_ACTIVE_LOCKED_FIELDS (T1.1a)
//   MINUS { monthlyRent, startDate }   — hyran får omförhandlas via dto,
//                                        startDate omräknas till oldEnd+1
//   MINUS { unitId, tenantId }         — identitet sätts explicit av callern
//                                        (samma enhet/hyresgäst per definition)
//   PLUS  { monthlyRentExcludingVat,   — 🔴 CRITICAL moms (se ovan)
//           consumptionBillingMode,    — IMD-debiteringsläge (avtalat)
//           tenancyRegime,             — regelverket följer med (#69): en
//                                        förnyad privatuthyrning förblir
//                                        privatuthyrning, annars tappar
//                                        hyresgästen sin 1-månadersrätt
//           indexClause,               — legacy-spegel av indexClauseType;
//                                        fixar inkonsekvensen där bara boolen
//                                        kopierades men inte typen
//           petsApprovalNotes,         — annotationer hör till villkoren
//           indexNotes }
//
// SYNK-KONTRAKT (fail-closed): ett DMMF-test i apps/api
// (leases-succession-t13.spec.ts) asserterar att VARJE skalärt Lease-fält finns
// i EXAKT EN av listorna nedan. En ny kolumn i schema.prisma utan uttryckligt
// beslut (carry eller exclude) bryter CI — samma mönster som edit-låset.

export const LEASE_SUCCESSION_CARRY_FIELDS = [
  // Avgifter (del av total hyra, JB 12:19)
  'parkingFee',
  'storageFee',
  'garageFee',
  // Deposition — AVTALAT belopp (Deposit-ENTITETEN re-pekas separat i T1.3)
  'depositAmount',
  // Avtalsform + tider
  'leaseType',
  'noticePeriodMonths',
  'renewalPeriodMonths',
  // Regelverk (#69)
  'tenancyRegime',
  // 🔴 Moms-flaggan: hyran är avtalad exkl. moms → utgående moms (2611) ska
  // fortsätta tas ut på det förnyade avtalet (ML 1994:200)
  'monthlyRentExcludingVat',
  // Vad ingår i hyran
  'includesHeating',
  'includesWater',
  'includesHotWater',
  'includesElectricity',
  'includesInternet',
  'includesCleaning',
  'includesParking',
  'includesStorage',
  'includesLaundry',
  // Användning / husdjur / andrahand / försäkring
  'usagePurpose',
  'petsAllowed',
  'petsApprovalNotes',
  'sublettingAllowed',
  'requiresHomeInsurance',
  // Indexklausul (typ + legacy-bool + parametrar)
  'indexClause',
  'indexClauseType',
  'indexBaseYear',
  'indexAdjustmentDate',
  'indexMaxIncrease',
  'indexMinIncrease',
  'indexNotes',
  // Särskilda bestämmelser (operativ avtalstext)
  'specialTerms',
  // IMD-debiteringsläge (null = ärv fastighetens inställning — null bärs som null)
  'consumptionBillingMode',
] as const

export type LeaseSuccessionCarryField = (typeof LEASE_SUCCESSION_CARRY_FIELDS)[number]

// Fält som MEDVETET inte kopieras — varje post är ett uttryckligt beslut.
// Ordningen speglar schema.prisma. Läggs ett nytt Lease-fält till måste det
// placeras i carry-listan ELLER här, annars failar DMMF-testet (fail-closed).
export const LEASE_SUCCESSION_EXCLUDED_FIELDS = [
  'id', // ny rad = nytt id
  'organizationId', // sätts explicit av callern (samma org)
  'unitId', // identitet — sätts explicit (samma enhet)
  'tenantId', // identitet — sätts explicit (samma hyresgäst)
  'status', // nytt avtal skapas direkt ACTIVE
  'startDate', // omräknas: gamla endDate + 1 dag
  'endDate', // omräknas: dto.newEndDate eller renewalPeriodMonths
  'monthlyRent', // får omförhandlas: dto.monthlyRent ?? gamla hyran
  'activatedAt', // ny aktiveringstidpunkt (now)
  'terminatedAt', // nytt avtal är inte uppsagt
  'terminationReason', // —"—
  'contractNumber', // ny allokering ur ContractNumberSequence
  'createdAt', // Prisma-default
  'updatedAt', // Prisma-default
] as const

export type LeaseSuccessionExcludedField = (typeof LEASE_SUCCESSION_EXCLUDED_FIELDS)[number]
