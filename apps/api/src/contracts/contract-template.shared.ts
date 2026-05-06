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

import type { PetPolicy, IndexClauseType, CompanyForm } from '@prisma/client'

// ─── Input ────────────────────────────────────────────────────────────────

export interface ContractTemplateInput {
  lease: {
    id: string
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

// ─── CSS-shell — delad mellan bostad och lokal ───────────────────────────

export function buildHtmlShell(opts: {
  primaryColor: string
  title: string
  subtitle: string
  contractNumber: string
  generatedDate: string
  organizationName: string
  logoDataUrl: string | null
  body: string
}): string {
  const {
    primaryColor,
    title,
    subtitle,
    contractNumber,
    generatedDate,
    organizationName,
    logoDataUrl,
    body,
  } = opts

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <title>${escape(title)} — ${escape(organizationName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
      font-size: 10.5px;
      line-height: 1.55;
      color: #1f2937;
      padding: 36px 40px;
    }
    .header {
      border-bottom: 3px solid ${primaryColor};
      padding-bottom: 18px;
      margin-bottom: 22px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
    }
    .header-left { min-width: 0; }
    .header-title {
      font-size: 22px;
      font-weight: 700;
      color: ${primaryColor};
      margin-top: 8px;
      letter-spacing: -0.01em;
    }
    .header-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .header-meta { font-size: 10px; color: #6b7280; text-align: right; white-space: nowrap; }
    .header-meta strong { color: #111827; font-weight: 600; }

    h2 {
      font-size: 12.5px;
      font-weight: 700;
      color: ${primaryColor};
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 5px;
      margin: 18px 0 9px 0;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    h2 .lawref {
      font-size: 9.5px;
      font-weight: 500;
      color: #9ca3af;
      letter-spacing: 0;
      text-transform: none;
      margin-left: 8px;
    }

    p { margin-bottom: 6px; }
    p + p { margin-top: 4px; }

    .party-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 8px;
    }
    .party-box {
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 12px 14px;
      background: #fafafa;
    }
    .party-label {
      font-size: 9px;
      font-weight: 700;
      color: ${primaryColor};
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 6px;
    }
    .field-row {
      display: flex;
      margin-bottom: 3px;
      align-items: baseline;
    }
    .field-label { font-size: 9.5px; color: #6b7280; width: 110px; flex-shrink: 0; }
    .field-value { font-size: 10.5px; font-weight: 500; color: #1f2937; word-break: break-word; }

    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 14px;
      background: #f8fafc;
      border-radius: 6px;
      padding: 12px 14px;
      margin: 8px 0;
    }
    .info-item .label {
      font-size: 9px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .info-item .value {
      font-size: 12px;
      font-weight: 600;
      color: #111827;
      margin-top: 1px;
    }

    .clause {
      margin-bottom: 7px;
      padding-left: 14px;
      border-left: 2px solid #e5e7eb;
    }
    .clause-number { font-weight: 700; color: ${primaryColor}; }

    ul.clause-list {
      list-style: disc;
      margin-left: 20px;
      margin-top: 4px;
    }
    ul.clause-list li { margin-bottom: 2px; }

    .highlight-box {
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-left: 3px solid #d97706;
      border-radius: 4px;
      padding: 9px 12px;
      margin: 9px 0;
      font-size: 10px;
      color: #78350f;
    }
    .info-box {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-left: 3px solid #2563eb;
      border-radius: 4px;
      padding: 9px 12px;
      margin: 9px 0;
      font-size: 10px;
      color: #1e3a8a;
    }

    .signature-section {
      margin-top: 36px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 36px;
      page-break-inside: avoid;
    }
    .sig-box { border-top: 2px solid ${primaryColor}; padding-top: 8px; }
    .sig-box strong { font-size: 11px; color: ${primaryColor}; }
    .sig-line {
      border-top: 1px solid #9ca3af;
      margin-top: 32px;
      padding-top: 5px;
      font-size: 9.5px;
      color: #6b7280;
    }
    .digital-sig {
      margin-top: 14px;
      padding: 9px 11px;
      background: #ecfdf5;
      border: 1px solid #6ee7b7;
      border-radius: 4px;
      font-size: 9.5px;
      color: #065f46;
    }
    .digital-sig strong { display: block; color: #064e3b; margin-bottom: 2px; }
    .digital-sig code {
      font-family: 'JetBrains Mono', Menlo, monospace;
      font-size: 8.5px;
      color: #047857;
      word-break: break-all;
    }

    .footer {
      margin-top: 30px;
      padding-top: 10px;
      border-top: 1px solid #e5e7eb;
      font-size: 8.5px;
      color: #9ca3af;
      text-align: center;
    }

    @page { margin: 18mm; }
    .page-break { page-break-before: always; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${
        logoDataUrl
          ? `<img src="${logoDataUrl}" style="height:42px;max-width:180px;object-fit:contain;" alt="${escape(organizationName)}">`
          : `<div style="font-size:18px;font-weight:700;color:${primaryColor}">${escape(organizationName)}</div>`
      }
      <div class="header-title">${escape(title)}</div>
      <div class="header-sub">${escape(subtitle)}</div>
    </div>
    <div class="header-meta">
      Kontrakt nr <strong>${escape(contractNumber)}</strong><br>
      Upprättat <strong>${escape(generatedDate)}</strong>
    </div>
  </div>

  ${body}
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
    Depositionen återbetalas inom 30 dagar efter avflyttning, mot kvitterad
    återlämning av samtliga nycklar samt godkänd avflyttningsbesiktning.
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
    Hyresvärden får besiktiga hyresobjektet efter skriftligt varsel om minst
    24 timmar. Vid akut fara — exempelvis vattenläcka, brand eller risk
    för skada på fastigheten — får tillträde ske utan föregående varsel.
    Hyresvärden får också vid skälig tid visa lägenheten för intresserade
    spekulanter inför nästa hyresförhållande.
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
    &nbsp;·&nbsp; Kontrakt nr ${escape(input.lease.id.slice(0, 8).toUpperCase())}
  </div>`
}
