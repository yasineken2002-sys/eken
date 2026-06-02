// Delad bas för bostads- och lokalkontraktsmallarna. Innehåller typer,
// CSS-shell, gemensamma helpers och paragrafer som ser likadant ut oavsett
// kontraktstyp (parter, hyresobjekt, deposition, försäkring, brandskydd,
// gemensamma utrymmen, GDPR, signaturblock).
//
// Båda mallarna importerar dessa byggblock och plockar ihop dem i rätt
// ordning + lägger till sina egna typ-specifika paragrafer (indexklausul,
// husdjur, andrahand vs användningsändamål, indirekt besittningsskydd,
// branschvillkor osv.).
//
// Laghänvisningar är aktivt korrekta — varje § i mallen anger vilken
// paragraf i 12 kap. JB den vilar på, så att en jurist kan revidera
// mallen utan att behöva gå tillbaka till källkoden.
//
// Kontraktsmall 2.0 (2026-05-08):
//   – konsekvent typografi mot fakturamallen (system-ui, 11px body, 26px H1)
//   – tre template-varianter: classic / modern / minimal (delas med faktura)
//   – DRAFT-vattenmärke "EJ SIGNERAT" tills kontraktet aktiveras
//   – egen § "Övriga villkor" om lease.specialTerms är ifyllt
//   – BILAGOR-sektion på sista sidan + bilageförteckning
//   – kontraktsnummer i format KONT-{år}-{löpnr} (fortlöpande per org)

import type { PetPolicy, IndexClauseType, CompanyForm } from '@prisma/client'

// ─── Template-variants (delas med fakturan via Organization.invoiceTemplate) ─

export type ContractTemplateVariant = 'classic' | 'modern' | 'minimal'

// ─── Input ────────────────────────────────────────────────────────────────

export interface ContractTemplateAppendix {
  id: string
  title: string
  category: 'ENERGY_DECLARATION' | 'HOUSE_RULES' | 'INSPECTION_PROTOCOL' | 'OTHER'
  fileSize?: number
}

export interface ContractTemplateInput {
  lease: {
    id: string
    contractNumber: string | null
    status: 'DRAFT' | 'ACTIVE' | 'TERMINATED' | 'EXPIRED'
    startDate: Date
    endDate: Date | null
    monthlyRent: number
    depositAmount: number
    leaseType: 'FIXED_TERM' | 'INDEFINITE'
    renewalPeriodMonths: number | null
    noticePeriodMonths: number
    signedAt: Date | null

    includesHeating: boolean
    includesWater: boolean
    includesHotWater: boolean
    includesElectricity: boolean
    includesInternet: boolean
    includesCleaning: boolean
    includesParking: boolean
    includesStorage: boolean
    includesLaundry: boolean

    parkingFee: number | null
    storageFee: number | null
    garageFee: number | null

    usagePurpose: string | null
    petsAllowed: PetPolicy
    petsApprovalNotes: string | null
    sublettingAllowed: boolean
    requiresHomeInsurance: boolean

    indexClauseType: IndexClauseType
    indexBaseYear: number | null
    indexAdjustmentDate: string | null
    indexMaxIncrease: number | null
    indexMinIncrease: number | null
    indexNotes: string | null

    // Övriga villkor / särskilda bestämmelser (Kontraktsmall 2.0)
    specialTerms: string | null
  }
  organization: {
    name: string
    orgNumber: string | null
    vatNumber: string | null
    email: string
    phone: string | null
    street: string
    postalCode: string
    city: string
    bankgiro: string | null
    invoiceColor: string | null
    invoiceTemplate: ContractTemplateVariant
    logoDataUrl: string | null
    // Företagsform — styr vilken signatärsroll som anges i § 1 och i
    // signaturblocket (firmatecknare/ägare/bolagsman/behörig firmatecknare).
    companyForm: CompanyForm
    // F-skatt: visas i § 1 så hyresgästen ser att hyresvärden är
    // godkänd för F-skatt (hyresvärden ansvarar då för egna skatter).
    hasFSkatt: boolean
  }
  tenant: {
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName: string | null
    lastName: string | null
    companyName: string | null
    contactPerson: string | null
    personalNumber: string | null
    orgNumber: string | null
    email: string
    phone: string | null
    street: string | null
    postalCode: string | null
    city: string | null
  }
  unit: {
    name: string
    unitNumber: string
    type: 'APARTMENT' | 'OFFICE' | 'RETAIL' | 'STORAGE' | 'PARKING' | 'OTHER'
    area: number
    floor: number | null
    rooms: number | null
    hasBalcony: boolean
    hasStorage: boolean
    storageNumber: string | null
    parkingSpaceNumber: string | null
  }
  property: {
    name: string
    propertyDesignation: string
    street: string
    postalCode: string
    city: string
    fireSafetyNotes: string | null
    commonAreasNotes: string | null
    garbageDisposalRules: string | null
  }
  // Bilagor som ska listas i kontraktets bilageförteckning på sista sidan.
  // Pre-sorterade efter appendixOrder + kategori.
  appendices: ContractTemplateAppendix[]
  // Signaturmetadata visas på hyresgästsidan om kontraktet är digitalt
  // signerat. Sätts av ContractTemplateService efter att tenant-aktiveringen
  // skrivit lock-data till Document-raden.
  signature?: {
    signedAt: Date
    signedByName: string
    signedFromIp: string | null
    contentHash: string | null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function tenantDisplayName(t: ContractTemplateInput['tenant']): string {
  if (t.type === 'INDIVIDUAL') {
    return `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim() || t.email
  }
  return t.companyName ?? t.email
}

export function tenantAddressLine(t: ContractTemplateInput['tenant']): string | null {
  if (!t.street && !t.postalCode && !t.city) return null
  return [t.street, [t.postalCode, t.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
}

export function formatDateSv(date: Date | string): string {
  return new Date(date).toLocaleDateString('sv-SE')
}

export function formatMoney(value: number): string {
  return `${Number(value).toLocaleString('sv-SE')} kr`
}

const PET_POLICY_LABEL: Record<PetPolicy, string> = {
  ALLOWED: 'Husdjur är tillåtna i lägenheten utan särskilt godkännande.',
  REQUIRES_APPROVAL:
    'Innehav av husdjur kräver hyresvärdens skriftliga godkännande. Beslut meddelas inom skälig tid efter ansökan.',
  NOT_ALLOWED: 'Husdjur är inte tillåtna i lägenheten.',
}

export function petPolicyText(policy: PetPolicy): string {
  return PET_POLICY_LABEL[policy]
}

export function escape(s: string | null | undefined): string {
  if (s == null) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Visningsnummer för kontraktet. Använd lease.contractNumber när det finns
// (KONT-2026-00042), annars en lease-id-fallback (gamla DRAFT-rader). Den
// här hjälpfunktionen används både i headern, i footern och som filnamn.
export function contractNumberLabel(input: ContractTemplateInput): string {
  return input.lease.contractNumber ?? input.lease.id.slice(0, 8).toUpperCase()
}

// Vem som lagligen tecknar avtalet för hyresvärden — beror på företagsform.
// Visas som rad i § 1 Parter och som etikett i signaturblocket.
//   AB              → firmatecknare (ABL 8 kap. 35–37 §§)
//   Enskild firma   → ägaren (ensamt ansvar, BFL 1 §)
//   HB / KB         → bolagsman (HBL 2 kap. 17 §)
//   Förening        → behörig firmatecknare (stadgarna)
//   Stiftelse       → behörig firmatecknare (stiftelseförordnandet)
export function signatoryRoleLabel(form: CompanyForm): string {
  switch (form) {
    case 'AB':
      return 'firmatecknare'
    case 'ENSKILD_FIRMA':
      return 'ägaren'
    case 'HB':
    case 'KB':
      return 'bolagsman'
    case 'FORENING':
    case 'STIFTELSE':
      return 'behörig firmatecknare'
  }
}

// ─── Beskrivning av vad som ingår i hyran ────────────────────────────────
// Vid tvist är detta den vanligaste frågan ("ingår uppvärmning eller inte?").
// Vi listar alltid både inkluderat och uttryckligen exkluderat så att inget
// blir öppet för tolkning.

export function buildIncludesList(lease: ContractTemplateInput['lease']): {
  included: string[]
  excluded: string[]
} {
  const items: Array<[boolean, string]> = [
    [lease.includesHeating, 'Uppvärmning'],
    [lease.includesWater, 'Kallvatten'],
    [lease.includesHotWater, 'Varmvatten'],
    [lease.includesElectricity, 'Hushållsel'],
    [lease.includesInternet, 'Internet/bredband'],
    [lease.includesCleaning, 'Städning av gemensamma utrymmen'],
    [lease.includesParking, 'Parkeringsplats'],
    [lease.includesStorage, 'Förråd'],
    [lease.includesLaundry, 'Tillgång till tvättstuga'],
  ]
  return {
    included: items.filter(([v]) => v).map(([, label]) => label),
    excluded: items.filter(([v]) => !v).map(([, label]) => label),
  }
}

// ─── Förfallodag enligt 12 kap. 20 § JB ──────────────────────────────────
// Hyran ska betalas i förskott senast sista vardagen i månaden FÖRE den
// månad hyran avser. Vi skriver det rakt ut i kontraktet så att avi-modulen
// (som följer rentDueDateForMonth) och kontraktet alltid är synkade.

export const RENT_DUE_TEXT =
  'Hyran ska betalas i förskott senast sista vardagen i månaden före den månad' +
  ' hyran avser, i enlighet med 12 kap. 20 § Jordabalken. Vid försenad' +
  ' betalning utgår dröjsmålsränta enligt räntelagen (1975:635) samt påminnelse-' +
  ' och inkassoavgifter enligt lagen (1981:739) om ersättning för inkassokostnader.'

// ─── Variant-tokens ──────────────────────────────────────────────────────
// Tre stilar: classic (formell, traditionell — som dagens), modern (rundade
// hörn, färgad header-bar, mer luft), minimal (svartvit, minimal pynt).
// Tokens delar struktur så mallarna inte vet vilken variant de renderas i.

interface VariantTokens {
  bodyBg: string
  surfaceBg: string
  partyBoxBg: string
  partyBoxBorder: string
  infoGridBg: string
  infoGridRadius: string
  cardRadius: string
  borderColor: string
  hAccent: string // h2 färg
  hAccentMuted: string // dimmad lawref
  textPrimary: string
  textSecondary: string
  textTertiary: string
  headerBorderBottom: string // accent under header
  headerBg: string // bg på själva header-blocket
  headerTitleColor: string
  headerSubColor: string
  headerMetaColor: string
  clauseBorder: string
  clauseNumberColor: string
  highlightBg: string
  highlightBorder: string
  highlightText: string
  infoBoxBg: string
  infoBoxBorder: string
  infoBoxText: string
  sigTopBorder: string
  sigStrongColor: string
  digitalSigBg: string
  digitalSigBorder: string
  digitalSigText: string
  digitalSigStrong: string
  appendixCardBg: string
  appendixCardBorder: string
}

function tokensForVariant(variant: ContractTemplateVariant, primary: string): VariantTokens {
  if (variant === 'modern') {
    return {
      bodyBg: '#ffffff',
      surfaceBg: '#ffffff',
      partyBoxBg: '#f8fafc',
      partyBoxBorder: '#e5e7eb',
      infoGridBg: '#f8fafc',
      infoGridRadius: '12px',
      cardRadius: '12px',
      borderColor: '#e5e7eb',
      hAccent: primary,
      hAccentMuted: '#9ca3af',
      textPrimary: '#0f172a',
      textSecondary: '#64748b',
      textTertiary: '#94a3b8',
      headerBorderBottom: '0',
      headerBg: primary,
      headerTitleColor: '#ffffff',
      headerSubColor: 'rgba(255,255,255,0.85)',
      headerMetaColor: 'rgba(255,255,255,0.85)',
      clauseBorder: '#e2e8f0',
      clauseNumberColor: primary,
      highlightBg: '#fef3c7',
      highlightBorder: '#f59e0b',
      highlightText: '#78350f',
      infoBoxBg: '#eff6ff',
      infoBoxBorder: '#3b82f6',
      infoBoxText: '#1e40af',
      sigTopBorder: primary,
      sigStrongColor: primary,
      digitalSigBg: '#ecfdf5',
      digitalSigBorder: '#6ee7b7',
      digitalSigText: '#065f46',
      digitalSigStrong: '#064e3b',
      appendixCardBg: '#f8fafc',
      appendixCardBorder: '#e2e8f0',
    }
  }
  if (variant === 'minimal') {
    return {
      bodyBg: '#ffffff',
      surfaceBg: '#ffffff',
      partyBoxBg: '#ffffff',
      partyBoxBorder: '#d1d5db',
      infoGridBg: '#ffffff',
      infoGridRadius: '0',
      cardRadius: '0',
      borderColor: '#d1d5db',
      hAccent: '#111827',
      hAccentMuted: '#6b7280',
      textPrimary: '#111827',
      textSecondary: '#374151',
      textTertiary: '#6b7280',
      headerBorderBottom: '1px solid #111827',
      headerBg: 'transparent',
      headerTitleColor: '#111827',
      headerSubColor: '#6b7280',
      headerMetaColor: '#6b7280',
      clauseBorder: '#d1d5db',
      clauseNumberColor: '#111827',
      highlightBg: '#ffffff',
      highlightBorder: '#111827',
      highlightText: '#111827',
      infoBoxBg: '#ffffff',
      infoBoxBorder: '#111827',
      infoBoxText: '#111827',
      sigTopBorder: '#111827',
      sigStrongColor: '#111827',
      digitalSigBg: '#ffffff',
      digitalSigBorder: '#111827',
      digitalSigText: '#111827',
      digitalSigStrong: '#111827',
      appendixCardBg: '#ffffff',
      appendixCardBorder: '#d1d5db',
    }
  }
  // classic (default)
  return {
    bodyBg: '#ffffff',
    surfaceBg: '#ffffff',
    partyBoxBg: '#fafafa',
    partyBoxBorder: '#e5e7eb',
    infoGridBg: '#f8fafc',
    infoGridRadius: '6px',
    cardRadius: '6px',
    borderColor: '#e5e7eb',
    hAccent: primary,
    hAccentMuted: '#9ca3af',
    textPrimary: '#1f2937',
    textSecondary: '#6b7280',
    textTertiary: '#9ca3af',
    headerBorderBottom: `3px solid ${primary}`,
    headerBg: 'transparent',
    headerTitleColor: primary,
    headerSubColor: '#6b7280',
    headerMetaColor: '#6b7280',
    clauseBorder: '#e5e7eb',
    clauseNumberColor: primary,
    highlightBg: '#fffbeb',
    highlightBorder: '#d97706',
    highlightText: '#78350f',
    infoBoxBg: '#eff6ff',
    infoBoxBorder: '#2563eb',
    infoBoxText: '#1e3a8a',
    sigTopBorder: primary,
    sigStrongColor: primary,
    digitalSigBg: '#ecfdf5',
    digitalSigBorder: '#6ee7b7',
    digitalSigText: '#065f46',
    digitalSigStrong: '#064e3b',
    appendixCardBg: '#fafafa',
    appendixCardBorder: '#e5e7eb',
  }
}

// ─── CSS-shell — delad mellan bostad och lokal ───────────────────────────

export function buildHtmlShell(opts: {
  primaryColor: string
  variant: ContractTemplateVariant
  title: string
  subtitle: string
  contractNumber: string
  generatedDate: string
  organizationName: string
  logoDataUrl: string | null
  body: string
  showDraftWatermark: boolean
}): string {
  const {
    primaryColor,
    variant,
    title,
    subtitle,
    contractNumber,
    generatedDate,
    organizationName,
    logoDataUrl,
    body,
    showDraftWatermark,
  } = opts

  const t = tokensForVariant(variant, primaryColor)

  // Header rendering varies per variant. For "modern" we reverse-out the
  // contents on a primary-colored bar; för classic/minimal har vi den
  // klassiska borderless/border-bottom-headern.
  const isModern = variant === 'modern'
  const logoBlock = logoDataUrl
    ? `<img src="${logoDataUrl}" style="height:48px;max-width:200px;object-fit:contain;" alt="${escape(organizationName)}">`
    : `<div style="font-size:20px;font-weight:700;color:${
        isModern ? '#ffffff' : t.headerTitleColor
      };">${escape(organizationName)}</div>`

  return `<!DOCTYPE html>
<html lang="sv" data-contract-no="${escape(contractNumber)}" data-org="${escape(organizationName)}">
<head>
  <meta charset="UTF-8">
  <title>${escape(title)} — ${escape(organizationName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif;
      font-size: 11px;
      line-height: 1.55;
      color: ${t.textPrimary};
      background: ${t.bodyBg};
    }

    /* Watermark — visas bara för DRAFT-status. Pseudo-fixed på varje sida
       via Puppeteers print-flow: vi använder absolut + transform och
       repeterar via header-kanal. För säkerhets skull lägger vi också en
       full-höjds bakgrundscell som täcker första sidans innehåll. */
    .draft-watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      font-size: 120px;
      font-weight: 800;
      color: rgba(15, 23, 42, 0.08);
      letter-spacing: 8px;
      pointer-events: none;
      z-index: 0;
      white-space: nowrap;
    }

    .header {
      ${
        isModern
          ? `background: ${t.headerBg};
            color: ${t.headerTitleColor};
            padding: 26px 32px 22px 32px;
            border-radius: 12px;
            margin-bottom: 22px;`
          : `border-bottom: ${t.headerBorderBottom};
            padding-bottom: 20px;
            margin-bottom: 24px;`
      }
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
    }
    .header-left { min-width: 0; }
    .header-title {
      font-size: 26px;
      font-weight: 700;
      color: ${t.headerTitleColor};
      margin-top: 10px;
      letter-spacing: -0.5px;
    }
    .header-sub { font-size: 12px; color: ${t.headerSubColor}; margin-top: 4px; }
    .header-meta {
      font-size: 11px;
      color: ${t.headerMetaColor};
      text-align: right;
      white-space: nowrap;
      ${isModern ? 'background: rgba(255,255,255,0.12); padding: 8px 12px; border-radius: 8px;' : ''}
    }
    .header-meta strong { color: ${isModern ? '#ffffff' : t.textPrimary}; font-weight: 600; }

    h2 {
      font-size: 13px;
      font-weight: 700;
      color: ${t.hAccent};
      ${variant === 'minimal' ? '' : `border-bottom: 1px solid ${t.borderColor};`}
      padding-bottom: 5px;
      margin: 20px 0 10px 0;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    h2 .lawref {
      font-size: 10px;
      font-weight: 500;
      color: ${t.hAccentMuted};
      letter-spacing: 0;
      text-transform: none;
      margin-left: 8px;
    }

    p { margin-bottom: 7px; }
    p + p { margin-top: 5px; }

    .party-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 8px;
    }
    .party-box {
      border: 1px solid ${t.partyBoxBorder};
      border-radius: ${t.cardRadius};
      padding: 14px 16px;
      background: ${t.partyBoxBg};
    }
    .party-label {
      font-size: 9.5px;
      font-weight: 700;
      color: ${t.hAccent};
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 8px;
    }
    .field-row {
      display: flex;
      margin-bottom: 4px;
      align-items: baseline;
    }
    .field-label { font-size: 10px; color: ${t.textSecondary}; width: 115px; flex-shrink: 0; }
    .field-value { font-size: 11px; font-weight: 500; color: ${t.textPrimary}; word-break: break-word; }

    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 14px;
      background: ${t.infoGridBg};
      border-radius: ${t.infoGridRadius};
      padding: 13px 16px;
      margin: 9px 0;
      ${variant === 'minimal' ? `border: 1px solid ${t.borderColor};` : ''}
    }
    .info-item .label {
      font-size: 9.5px;
      color: ${t.textSecondary};
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .info-item .value {
      font-size: 13px;
      font-weight: 600;
      color: ${t.textPrimary};
      margin-top: 2px;
    }

    .clause {
      margin-bottom: 8px;
      padding-left: 14px;
      border-left: 2px solid ${t.clauseBorder};
    }
    .clause-number { font-weight: 700; color: ${t.clauseNumberColor}; }

    ul.clause-list {
      list-style: disc;
      margin-left: 22px;
      margin-top: 4px;
    }
    ul.clause-list li { margin-bottom: 3px; }

    .highlight-box {
      background: ${t.highlightBg};
      border: 1px solid ${t.highlightBorder};
      border-left: 3px solid ${t.highlightBorder};
      border-radius: 4px;
      padding: 10px 13px;
      margin: 10px 0;
      font-size: 10.5px;
      color: ${t.highlightText};
    }
    .info-box {
      background: ${t.infoBoxBg};
      border: 1px solid ${t.infoBoxBorder};
      border-left: 3px solid ${t.infoBoxBorder};
      border-radius: 4px;
      padding: 10px 13px;
      margin: 10px 0;
      font-size: 10.5px;
      color: ${t.infoBoxText};
    }

    /* Övriga villkor / särskilda bestämmelser — vi vill ha en mer markant
       presentation än en vanlig clause så att hyresgästen och hyresvärden
       båda lägger märke till de individuella villkoren. */
    .special-terms {
      white-space: pre-wrap;
      padding: 12px 14px;
      border-left: 3px solid ${t.clauseNumberColor};
      background: ${t.infoGridBg};
      border-radius: ${t.cardRadius};
      font-size: 11px;
      color: ${t.textPrimary};
    }

    .signature-section {
      margin-top: 36px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 36px;
      page-break-inside: avoid;
    }
    .sig-box { border-top: 2px solid ${t.sigTopBorder}; padding-top: 8px; }
    .sig-box strong { font-size: 11.5px; color: ${t.sigStrongColor}; }
    .sig-line {
      border-top: 1px solid #9ca3af;
      margin-top: 32px;
      padding-top: 5px;
      font-size: 10px;
      color: ${t.textSecondary};
    }
    .digital-sig {
      margin-top: 14px;
      padding: 10px 12px;
      background: ${t.digitalSigBg};
      border: 1px solid ${t.digitalSigBorder};
      border-radius: 4px;
      font-size: 10px;
      color: ${t.digitalSigText};
    }
    .digital-sig strong { display: block; color: ${t.digitalSigStrong}; margin-bottom: 2px; }
    .digital-sig code {
      font-family: 'JetBrains Mono', Menlo, monospace;
      font-size: 9px;
      color: ${t.digitalSigText};
      word-break: break-all;
    }

    /* BILAGOR — listas på sista sidan, alltid på en egen sida för läsbarhet. */
    .appendices {
      page-break-before: always;
    }
    .appendices-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      margin-top: 12px;
    }
    .appendix-card {
      border: 1px solid ${t.appendixCardBorder};
      border-radius: ${t.cardRadius};
      padding: 14px 16px;
      background: ${t.appendixCardBg};
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .appendix-num {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: ${t.hAccent};
      color: ${variant === 'minimal' ? '#ffffff' : '#ffffff'};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .appendix-info { flex: 1; min-width: 0; }
    .appendix-title { font-size: 12px; font-weight: 600; color: ${t.textPrimary}; }
    .appendix-meta { font-size: 10px; color: ${t.textSecondary}; margin-top: 2px; }

    .footer {
      margin-top: 30px;
      padding-top: 10px;
      border-top: 1px solid ${t.borderColor};
      font-size: 9px;
      color: ${t.textTertiary};
      text-align: center;
    }

    /* Puppeteers headerTemplate/footerTemplate krockar med default-margin —
       vi sätter @page till 25/22 mm så det finns plats. */
    @page { margin: 25mm 18mm 22mm 18mm; }
    .page-break { page-break-before: always; }
    .body-content { position: relative; z-index: 1; }
  </style>
</head>
<body>
  ${showDraftWatermark ? `<div class="draft-watermark">EJ SIGNERAT</div>` : ''}
  <div class="body-content">
    <div class="header">
      <div class="header-left">
        ${logoBlock}
        <div class="header-title">${escape(title)}</div>
        <div class="header-sub">${escape(subtitle)}</div>
      </div>
      <div class="header-meta">
        Kontrakt nr <strong>${escape(contractNumber)}</strong><br>
        Upprättat <strong>${escape(generatedDate)}</strong>
      </div>
    </div>

    ${body}
  </div>
</body>
</html>`
}

// ─── Gemensamma paragrafer (samma text för bostad och lokal) ─────────────

export function partiesSection(input: ContractTemplateInput): string {
  const { organization: org, tenant } = input
  const tenantName = tenantDisplayName(tenant)
  const tenantAddr = tenantAddressLine(tenant)
  return `
  <h2>§ 1 — Parter</h2>
  <div class="party-grid">
    <div class="party-box">
      <div class="party-label">Hyresvärd</div>
      <div class="field-row"><span class="field-label">Namn</span><span class="field-value">${escape(org.name)}</span></div>
      ${
        org.orgNumber
          ? `<div class="field-row"><span class="field-label">Org.nr</span><span class="field-value">${escape(org.orgNumber)}</span></div>`
          : ''
      }
      ${
        org.vatNumber
          ? `<div class="field-row"><span class="field-label">VAT-nr</span><span class="field-value">${escape(org.vatNumber)}</span></div>`
          : ''
      }
      <div class="field-row"><span class="field-label">Adress</span><span class="field-value">${escape(org.street)}, ${escape(org.postalCode)} ${escape(org.city)}</span></div>
      <div class="field-row"><span class="field-label">E-post</span><span class="field-value">${escape(org.email)}</span></div>
      ${
        org.phone
          ? `<div class="field-row"><span class="field-label">Telefon</span><span class="field-value">${escape(org.phone)}</span></div>`
          : ''
      }
      ${
        org.bankgiro
          ? `<div class="field-row"><span class="field-label">Bankgiro</span><span class="field-value">${escape(org.bankgiro)}</span></div>`
          : ''
      }
      <div class="field-row"><span class="field-label">Tecknas av</span><span class="field-value">${escape(signatoryRoleLabel(org.companyForm))}</span></div>
      ${
        org.hasFSkatt
          ? `<div class="field-row"><span class="field-label">Skattestatus</span><span class="field-value">Godkänd för F-skatt</span></div>`
          : ''
      }
    </div>
    <div class="party-box">
      <div class="party-label">Hyresgäst</div>
      <div class="field-row"><span class="field-label">${tenant.type === 'COMPANY' ? 'Företag' : 'Namn'}</span><span class="field-value">${escape(tenantName)}</span></div>
      ${
        tenant.type === 'INDIVIDUAL' && tenant.personalNumber
          ? `<div class="field-row"><span class="field-label">Personnummer</span><span class="field-value">${escape(tenant.personalNumber)}</span></div>`
          : ''
      }
      ${
        tenant.type === 'COMPANY' && tenant.orgNumber
          ? `<div class="field-row"><span class="field-label">Org.nr</span><span class="field-value">${escape(tenant.orgNumber)}</span></div>`
          : ''
      }
      ${
        tenant.type === 'COMPANY' && tenant.contactPerson
          ? `<div class="field-row"><span class="field-label">Kontaktperson</span><span class="field-value">${escape(tenant.contactPerson)}</span></div>`
          : ''
      }
      ${
        tenantAddr
          ? `<div class="field-row"><span class="field-label">Adress</span><span class="field-value">${escape(tenantAddr)}</span></div>`
          : ''
      }
      <div class="field-row"><span class="field-label">E-post</span><span class="field-value">${escape(tenant.email)}</span></div>
      ${
        tenant.phone
          ? `<div class="field-row"><span class="field-label">Telefon</span><span class="field-value">${escape(tenant.phone)}</span></div>`
          : ''
      }
    </div>
  </div>`
}

// ─── Hyresobjekt ─────────────────────────────────────────────────────────

export function objectSection(
  input: ContractTemplateInput,
  opts: { useLabel: string; purposeLine: string },
): string {
  const { unit, property } = input
  const facts: Array<[string, string]> = [
    ['Fastighet', `${property.name} (${property.propertyDesignation})`],
    ['Adress', `${property.street}, ${property.postalCode} ${property.city}`],
    ['Lägenhet/Enhet', `${unit.name} (nr ${unit.unitNumber})`],
    ['Yta', `${unit.area} m²`],
  ]
  if (unit.floor != null) facts.push(['Våning', String(unit.floor)])
  if (unit.rooms != null) facts.push(['Antal rum', `${unit.rooms} rum`])
  if (unit.hasBalcony) facts.push(['Balkong', 'Ja'])
  if (unit.hasStorage)
    facts.push(['Förråd', unit.storageNumber ? `Ja (nr ${unit.storageNumber})` : 'Ja'])
  if (unit.parkingSpaceNumber) facts.push(['Parkeringsplats', `Nr ${unit.parkingSpaceNumber}`])
  facts.push([opts.useLabel, opts.purposeLine])

  return `
  <h2>§ 2 — Hyresobjekt</h2>
  ${facts
    .map(
      ([label, value]) => `
  <div class="field-row"><span class="field-label">${escape(label)}</span><span class="field-value">${escape(value)}</span></div>`,
    )
    .join('')}`
}

// ─── Deposition ──────────────────────────────────────────────────────────

export function depositSection(input: ContractTemplateInput, paragraphNo: number): string {
  const { lease } = input
  const amount = Number(lease.depositAmount)
  if (amount <= 0) {
    return `
  <h2>§ ${paragraphNo} — Deposition</h2>
  <div class="clause">Ingen deposition krävs enligt detta avtal.</div>`
  }
  return `
  <h2>§ ${paragraphNo} — Deposition</h2>
  <div class="clause">
    <span class="clause-number">${paragraphNo}.1</span>
    Hyresgästen ska före tillträdesdagen erlägga deposition om
    <strong>${formatMoney(amount)}</strong> till hyresvärden.
  </div>
  <div class="clause">
    <span class="clause-number">${paragraphNo}.2</span>
    Depositionen återbetalas inom skälig tid, normalt 30 dagar, efter
    avflyttning, mot kvitterad återlämning av samtliga nycklar samt godkänd
    avflyttningsbesiktning.
  </div>
  <div class="clause">
    <span class="clause-number">${paragraphNo}.3</span>
    Hyresvärden får göra avdrag för obetald hyra, dröjsmålsränta samt skador
    utöver normalt slitage. Avdrag specificeras skriftligt.
  </div>`
}

// ─── Brandskydd ──────────────────────────────────────────────────────────

export function fireSafetySection(input: ContractTemplateInput, paragraphNo: number): string {
  const extra = input.property.fireSafetyNotes
  return `
  <h2>§ ${paragraphNo} — Brandskydd och säkerhet <span class="lawref">(MSB:s allmänna råd 2007:1)</span></h2>
  <ul class="clause-list">
    <li>Brandvarnare ska finnas och funktionsprovas regelbundet av hyresgästen.</li>
    <li>Utrymningsvägar och trapphus ska hållas fria från privat egendom — barnvagnar, cyklar, mattor och brännbart material får inte förvaras där.</li>
    <li>Levande ljus ska aldrig lämnas obevakade.</li>
    <li>Grill på balkong får endast användas med el eller gasol och endast om det inte strider mot fastighetens ordningsregler.</li>
    <li>Vid brand- eller utrymningssituation följ instruktioner i trapphus och från räddningstjänst.</li>
  </ul>
  ${
    extra
      ? `<div class="info-box"><strong>Fastighetsspecifika brandregler:</strong><br>${escape(extra)}</div>`
      : ''
  }`
}

// ─── Tillträde och besiktning ────────────────────────────────────────────

export function accessSection(paragraphNo: number): string {
  return `
  <h2>§ ${paragraphNo} — Tillträde för hyresvärden <span class="lawref">(12 kap. 26 § JB)</span></h2>
  <div class="clause">
    Hyresvärden har rätt till tillträde till hyresobjektet för nödvändig
    tillsyn och skötsel i enlighet med 12 kap. 26 § Jordabalken. Hyresvärden
    underrättar hyresgästen i god tid i förväg — som internt riktvärde minst
    24 timmar — vilket inte inskränker den rätt till tillträde som lagen ger.
    Vid akut fara — exempelvis vattenläcka, brand eller risk för skada på
    fastigheten — får tillträde ske utan föregående varsel. Hyresvärden får
    också vid skälig tid visa lägenheten för intresserade spekulanter inför
    nästa hyresförhållande.
  </div>`
}

// ─── Försäkring ──────────────────────────────────────────────────────────

export function insuranceSection(
  input: ContractTemplateInput,
  paragraphNo: number,
  variant: 'residential' | 'commercial',
): string {
  const { lease } = input
  if (variant === 'residential') {
    if (!lease.requiresHomeInsurance) {
      return `
  <h2>§ ${paragraphNo} — Försäkring</h2>
  <div class="clause">Hyresgästen rekommenderas att teckna hemförsäkring men är inte avtalsenligt skyldig att göra det.</div>`
    }
    return `
  <h2>§ ${paragraphNo} — Försäkring</h2>
  <div class="clause">
    Hyresgästen är skyldig att teckna och under hela hyrestiden vidmakthålla
    hemförsäkring som täcker både lösöre och ansvar gentemot tredje man.
    Kopia av försäkringsbrev ska på begäran kunna uppvisas för hyresvärden.
  </div>`
  }
  return `
  <h2>§ ${paragraphNo} — Försäkring</h2>
  <div class="clause">
    Hyresgästen ska teckna och under hela hyrestiden vidmakthålla
    företagsförsäkring som omfattar verksamheten i lokalen, inkluderande
    ansvarsförsäkring med betryggande försäkringsbelopp för verksamhetens
    art. Kopia av försäkringsbrev ska tillställas hyresvärden vid tillträdet
    och vid hyresvärdens begäran därefter.
  </div>`
}

// ─── Gemensamma utrymmen ─────────────────────────────────────────────────

export function commonAreasSection(input: ContractTemplateInput, paragraphNo: number): string {
  const { property } = input
  return `
  <h2>§ ${paragraphNo} — Gemensamma utrymmen och ordning</h2>
  <ul class="clause-list">
    <li>Tvättstuga, cykel- och barnvagnsförråd, källare och vind nyttjas enligt fastighetens ordningsregler.</li>
    <li>Hyresgästen ansvarar för att gemensamma utrymmen lämnas städade efter användning.</li>
    <li>Störande verksamhet — högt ljud, fester, byggarbeten — är inte tillåtna mellan kl. 22.00 och 07.00 om inte annat avtalats.</li>
    <li>Rökning är inte tillåten i fastighetens gemensamma utrymmen.</li>
  </ul>
  ${
    property.commonAreasNotes
      ? `<div class="info-box"><strong>Specifika regler för fastighetens gemensamma utrymmen:</strong><br>${escape(property.commonAreasNotes)}</div>`
      : ''
  }
  ${
    property.garbageDisposalRules
      ? `<div class="info-box"><strong>Avfallshantering:</strong><br>${escape(property.garbageDisposalRules)}</div>`
      : ''
  }`
}

// ─── GDPR ────────────────────────────────────────────────────────────────

export function gdprSection(input: ContractTemplateInput, paragraphNo: number): string {
  return `
  <h2>§ ${paragraphNo} — Personuppgifter <span class="lawref">(GDPR / EU 2016/679)</span></h2>
  <div class="clause">
    ${escape(input.organization.name)} behandlar hyresgästens personuppgifter
    i syfte att fullgöra detta hyresavtal (rättslig grund: avtalsuppfyllelse,
    GDPR art. 6.1.b) samt för att uppfylla bokföringslagen (rättslig grund:
    rättslig förpliktelse, art. 6.1.c). Uppgifterna lagras under hyres-
    förhållandets bestånd och därefter i sju år enligt 7 kap. 2 § bokförings-
    lagen (1999:1078). Hyresgästen har rätt att begära registerutdrag,
    rättelse, radering och dataportabilitet i enlighet med GDPR art. 15–22.
  </div>
  <div class="clause">
    Frågor om behandlingen av personuppgifter samt begäran enligt ovan ställs
    till hyresvärden på ${escape(input.organization.email)}.
  </div>`
}

// ─── Förändringar och anmälningsplikt ────────────────────────────────────

export function noticesSection(paragraphNo: number): string {
  return `
  <h2>§ ${paragraphNo} — Anmälningsplikt</h2>
  <ul class="clause-list">
    <li>Adressändring eller ändrade kontaktuppgifter ska anmälas till hyresvärden utan dröjsmål.</li>
    <li>Skador på lägenheten/lokalen, fastigheten eller dess installationer ska anmälas omedelbart.</li>
    <li>Vattenläckor och driftstörningar som riskerar att skada fastigheten ska rapporteras direkt — vid behov dygnet runt.</li>
  </ul>`
}

// ─── Avflyttning ─────────────────────────────────────────────────────────

export function moveOutSection(paragraphNo: number): string {
  return `
  <h2>§ ${paragraphNo} — Avflyttning</h2>
  <ul class="clause-list">
    <li>Skriftlig uppsägning enligt § 3 är en förutsättning för avflyttning.</li>
    <li>Avflyttningsbesiktning ska bokas i god tid före avflyttningsdagen.</li>
    <li>Samtliga nycklar och eventuella nyckelbrickor återlämnas senast på avflyttningsdagen.</li>
    <li>Lägenheten/lokalen ska lämnas väl städad och i samma skick som vid tillträdet, med beaktande av normalt slitage.</li>
  </ul>`
}

// ─── Förverkande (12 kap. 42 § JB) ───────────────────────────────────────

export function forfeitureSection(paragraphNo: number): string {
  return `
  <h2>§ ${paragraphNo} — Förverkande <span class="lawref">(12 kap. 42 § JB)</span></h2>
  <div class="clause">
    Hyresrätten är förverkad och hyresvärden får säga upp avtalet i förtid
    om hyresgästen
  </div>
  <ul class="clause-list">
    <li>dröjer med betalning av hyran mer än en vecka efter förfallodagen,</li>
    <li>utan tillstånd hyr ut eller upplåter lägenheten/lokalen i andra hand,</li>
    <li>vanvårdar lägenheten/lokalen eller orsakar väsentliga störningar för grannar,</li>
    <li>använder lägenheten/lokalen för annat ändamål än det avtalade,</li>
    <li>åsidosätter en skyldighet enligt detta avtal som är av synnerlig vikt för hyresvärden.</li>
  </ul>
  <div class="clause">
    Hyresgästen får möjlighet till rättelse i de fall lagen föreskriver det
    (12 kap. 43–44 §§ JB).
  </div>`
}

// ─── Övriga villkor / särskilda bestämmelser (Kontraktsmall 2.0) ─────────
// Renderas BARA om lease.specialTerms har innehåll. Behåll fritext-
// formattering (radbrytningar) via white-space: pre-wrap.

export function specialTermsSection(input: ContractTemplateInput, paragraphNo: number): string {
  const text = input.lease.specialTerms?.trim()
  if (!text) return ''
  return `
  <h2>§ ${paragraphNo} — Övriga villkor &amp; särskilda bestämmelser</h2>
  <div class="clause">
    Utöver vad som följer av föregående paragrafer har parterna avtalat om
    följande särskilda villkor som utgör en integrerad del av detta avtal:
  </div>
  <div class="special-terms">${escape(text)}</div>`
}

// ─── Bilageförteckning (Kontraktsmall 2.0) ───────────────────────────────
// Listas på en egen sida (page-break-before) för läsbarhet. Visar typ +
// titel + storlek. Bilagornas faktiska PDF:er bifogas separat — denna
// sida är en innehållsförteckning, inte själva bilage-PDF:en.

const APPENDIX_LABEL: Record<ContractTemplateAppendix['category'], string> = {
  ENERGY_DECLARATION: 'Energideklaration',
  HOUSE_RULES: 'Ordningsregler',
  INSPECTION_PROTOCOL: 'Tillträdes- och avflyttningsbesiktning',
  OTHER: 'Övrig bilaga',
}

export function appendicesSection(input: ContractTemplateInput): string {
  if (input.appendices.length === 0) return ''
  return `
  <div class="appendices">
    <h2>Bilageförteckning</h2>
    <div class="clause">
      Följande bilagor utgör en integrerad del av detta hyresavtal och har
      överlämnats till hyresgästen vid avtalets undertecknande.
    </div>
    <div class="appendices-grid">
      ${input.appendices
        .map(
          (a, i) => `
        <div class="appendix-card">
          <div class="appendix-num">${i + 1}</div>
          <div class="appendix-info">
            <div class="appendix-title">Bilaga ${i + 1}: ${escape(a.title)}</div>
            <div class="appendix-meta">${APPENDIX_LABEL[a.category]}${
              a.fileSize ? ` · ${formatFileSize(a.fileSize)}` : ''
            }</div>
          </div>
        </div>`,
        )
        .join('')}
    </div>
  </div>`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Signaturblock ───────────────────────────────────────────────────────

export function signatureBlock(input: ContractTemplateInput): string {
  const tenantName = tenantDisplayName(input.tenant)
  const sig = input.signature

  const signatoryRole = signatoryRoleLabel(input.organization.companyForm)
  return `
  <div class="signature-section">
    <div>
      <div class="sig-box">
        <strong>HYRESVÄRD — ${escape(input.organization.name)}</strong>
        <div class="sig-line">Ort och datum</div>
        <div class="sig-line">Underskrift (${escape(signatoryRole)})</div>
        <div class="sig-line">Namnförtydligande</div>
      </div>
    </div>
    <div>
      <div class="sig-box">
        <strong>HYRESGÄST — ${escape(tenantName)}</strong>
        ${
          sig
            ? `
        <div class="digital-sig">
          <strong>✓ Signerat digitalt</strong>
          ${escape(sig.signedByName)} · ${formatDateSv(sig.signedAt)} kl. ${new Date(sig.signedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}
          ${sig.signedFromIp ? `<br>IP-adress: ${escape(sig.signedFromIp)}` : ''}
          ${sig.contentHash ? `<br>Innehållshash (SHA-256):<br><code>${escape(sig.contentHash)}</code>` : ''}
        </div>`
            : `
        <div class="sig-line">Ort och datum</div>
        <div class="sig-line">Underskrift</div>
        <div class="sig-line">Namnförtydligande: ${escape(tenantName)}</div>`
        }
      </div>
    </div>
  </div>`
}

// ─── Footer ──────────────────────────────────────────────────────────────

export function footer(input: ContractTemplateInput): string {
  return `
  <div class="footer">
    Detta kontrakt är upprättat i två likalydande exemplar, ett till vardera parten.
    &nbsp;·&nbsp; Genererat av Eveno Fastighetsförvaltning ${formatDateSv(new Date())}
    &nbsp;·&nbsp; Kontrakt nr ${escape(contractNumberLabel(input))}
  </div>`
}
