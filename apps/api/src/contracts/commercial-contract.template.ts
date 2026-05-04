// Lokalhyreskontrakt enligt 12 kap. Jordabalken med särskilt avseende på
// 12 kap. 56–60 §§ (indirekt besittningsskydd för lokal).
//
// Skillnader mot bostadsmallen:
//   – Användningsändamål är OBLIGATORISKT — utan det riskerar lokalen att
//     tappa indirekt besittningsskydd (12:57 §).
//   – Hyrestid: minst 3 år rekommenderas för indirekt besittningsskydd.
//   – Uppsägning: 9 månader standard (12 kap. 4 § andra stycket JB).
//   – Egen paragraf om indirekt besittningsskydd (12:57 §).
//   – Ingen bostads-husdjursparagraf; istället branschvillkor.
//   – Tvister hänskjuts till allmän domstol (Hyresnämnden prövar inte
//     lokalfrågor utöver 12:58 § medling).
//   – Försäkringsplikten är obligatorisk (verksamhets/ansvarsförsäkring).

import {
  type ContractTemplateInput,
  buildHtmlShell,
  buildIncludesList,
  formatDateSv,
  formatMoney,
  partiesSection,
  objectSection,
  depositSection,
  fireSafetySection,
  accessSection,
  insuranceSection,
  commonAreasSection,
  gdprSection,
  noticesSection,
  moveOutSection,
  forfeitureSection,
  signatureBlock,
  footer,
  RENT_DUE_TEXT,
  escape,
} from './contract-template.shared'

export function buildCommercialContractHtml(input: ContractTemplateInput): string {
  const { lease, organization: org } = input

  const primaryColor = org.invoiceColor ?? '#1a6b3c'
  const contractNumber = lease.id.slice(0, 8).toUpperCase()
  const today = new Date().toLocaleDateString('sv-SE')

  const noticePeriod =
    lease.noticePeriodMonths > 0 ? `${lease.noticePeriodMonths} månader` : '9 månader'

  const purpose = lease.usagePurpose?.trim() || '—  EJ ANGIVET  —'
  const purposeMissing = !lease.usagePurpose?.trim()

  const includes = buildIncludesList(lease)
  const supplementsRows: string[] = []
  if (lease.parkingFee != null && Number(lease.parkingFee) > 0) {
    supplementsRows.push(`Parkering: ${formatMoney(Number(lease.parkingFee))}/mån`)
  }
  if (lease.storageFee != null && Number(lease.storageFee) > 0) {
    supplementsRows.push(`Förråd: ${formatMoney(Number(lease.storageFee))}/mån`)
  }
  if (lease.garageFee != null && Number(lease.garageFee) > 0) {
    supplementsRows.push(`Garage: ${formatMoney(Number(lease.garageFee))}/mån`)
  }

  const body = `
  ${partiesSection(input)}

  ${objectSection(input, { useLabel: 'Användningsändamål', purposeLine: purpose })}

  ${
    purposeMissing
      ? `<div class="highlight-box">⚠️ Användningsändamål saknas. För att indirekt besittningsskydd enligt 12 kap. 57 § JB ska gälla måste lokalens användning anges uttryckligen i avtalet.</div>`
      : ''
  }

  <h2>§ 3 — Hyrestid och uppsägning <span class="lawref">(12 kap. 4 § andra st., 8 § JB)</span></h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="label">Tillträdesdatum</div>
      <div class="value">${formatDateSv(lease.startDate)}</div>
    </div>
    <div class="info-item">
      <div class="label">Kontraktsform</div>
      <div class="value">${lease.endDate ? 'Tidsbestämt' : 'Tillsvidare'}</div>
    </div>
    <div class="info-item">
      <div class="label">Uppsägningstid</div>
      <div class="value">${escape(noticePeriod)}</div>
    </div>
  </div>
  ${
    lease.endDate
      ? `<div class="field-row"><span class="field-label">Slutdatum</span><span class="field-value">${formatDateSv(lease.endDate)}</span></div>`
      : ''
  }
  ${
    lease.leaseType === 'FIXED_TERM' && lease.renewalPeriodMonths
      ? `<div class="field-row"><span class="field-label">Förlängning</span><span class="field-value">Avtalet förlängs automatiskt med ${lease.renewalPeriodMonths} månader om uppsägning inte sker.</span></div>`
      : ''
  }
  <div class="clause">
    Uppsägning ska ske skriftligen enligt 12 kap. 8 § Jordabalken.
    Vid uppsägning för villkorsändring ska uppsägningen innehålla de
    villkor som krävs för förlängning, jämte underrättelse till
    Hyresnämnden enligt 12 kap. 58 § JB.
  </div>
  <div class="info-box">
    Tidsbestämda lokalavtal med en hyrestid över nio månader omfattas
    av indirekt besittningsskydd enligt 12 kap. 56 § JB om inte parterna
    skriftligen avstått från detta enligt 12 kap. 56 § fjärde stycket.
  </div>

  <h2>§ 4 — Hyra, betalning och vad som ingår <span class="lawref">(12 kap. 19–20 §§ JB · ML 9 kap.)</span></h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="label">Månadshyra (exkl. moms)</div>
      <div class="value">${formatMoney(Number(lease.monthlyRent))}</div>
    </div>
    <div class="info-item">
      <div class="label">Betalas till</div>
      <div class="value">${org.bankgiro ? `Bankgiro ${escape(org.bankgiro)}` : 'Enligt avi'}</div>
    </div>
    <div class="info-item">
      <div class="label">Förfallodag</div>
      <div class="value">Sista vardagen i föregående månad</div>
    </div>
  </div>
  <div class="clause"><span class="clause-number">4.1</span> ${RENT_DUE_TEXT}</div>
  <div class="clause">
    <span class="clause-number">4.2</span>
    Om hyresvärden är frivilligt skattskyldig till mervärdesskatt enligt
    9 kap. mervärdesskattelagen (2023:200) tillkommer mervärdesskatt på
    hyran. Hyresgästen ska bedriva momspliktig verksamhet i lokalen och
    inkomma med skriftligt intyg om så krävs av hyresvärden.
  </div>
  <div class="clause">
    <span class="clause-number">4.3</span>
    Tillkommer även eventuellt fastighetsskattetillägg om fastighetsskatten
    förändras under avtalstiden, baserat på lokalens andel av fastighetens
    totalarea.
  </div>
  ${
    includes.included.length
      ? `<div class="clause">
    <span class="clause-number">4.4</span>
    Följande ingår i hyran utan tillkommande avgift:
    <ul class="clause-list">
      ${includes.included.map((i) => `<li>${escape(i)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }
  ${
    includes.excluded.length
      ? `<div class="clause">
    <span class="clause-number">4.5</span>
    Följande ingår <strong>inte</strong> i hyran och bekostas av hyresgästen:
    <ul class="clause-list">
      ${includes.excluded.map((i) => `<li>${escape(i)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }
  ${
    supplementsRows.length
      ? `<div class="clause">
    <span class="clause-number">4.6</span>
    Tilläggshyror utöver grundhyran:
    <ul class="clause-list">
      ${supplementsRows.map((r) => `<li>${escape(r)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }

  <h2>§ 5 — Användningsändamål <span class="lawref">(12 kap. 23, 57 §§ JB)</span></h2>
  <div class="clause">
    Lokalen får endast användas för: <strong>${escape(purpose)}</strong>.
    Ändring av användningsändamål kräver hyresvärdens skriftliga samtycke.
    Olovlig ändring kan utgöra grund för förverkande enligt 12 kap. 42 § JB
    och leda till att hyresgästen förlorar sitt indirekta besittningsskydd.
  </div>

  ${renderIndexClause(input)}

  <h2>§ 7 — Indirekt besittningsskydd <span class="lawref">(12 kap. 56–60 §§ JB)</span></h2>
  <div class="clause">
    Hyresgästen har indirekt besittningsskydd enligt 12 kap. 56 § JB om
    avtalets hyrestid överstiger nio månader och parterna inte uttryckligen
    avtalat bort skyddet.
  </div>
  <div class="clause">
    Vid uppsägning från hyresvärdens sida för avflyttning eller villkors-
    ändring kan hyresgästen ha rätt till ersättning enligt 12 kap. 58 b §
    JB om hyresvärden inte har befogad anledning till uppsägningen.
    Ersättningen utgör som lägst en årshyra.
  </div>
  <div class="clause">
    Hyresgästen ska inom två månader från uppsägning hänskjuta tvisten
    till Hyresnämnden för medling om hyresgästen vill behålla sin rätt
    till ersättning enligt 12 kap. 58 a § JB.
  </div>

  ${depositSection(input, 8)}

  <h2>§ 9 — Skick, underhåll och förändringar <span class="lawref">(12 kap. 9, 15, 24 §§ JB)</span></h2>
  <div class="clause">
    <span class="clause-number">9.1</span>
    Hyresgästen övertar lokalen i det skick som framgår av tillträdes-
    besiktningen.
  </div>
  <div class="clause">
    <span class="clause-number">9.2</span>
    Hyresvärden ansvarar för stomme, fasad, tak, fönster utvändigt samt
    centrala installationer för värme, vatten och avlopp.
  </div>
  <div class="clause">
    <span class="clause-number">9.3</span>
    Hyresgästen ansvarar för invändigt underhåll inkluderande ytskikt
    (golv, väggar, tak), fasta installationer för verksamheten samt
    utrustning som tillhör verksamheten.
  </div>
  <div class="clause">
    <span class="clause-number">9.4</span>
    Förändringar av lokalens utformning eller installationer kräver
    hyresvärdens skriftliga samtycke (12 kap. 24 § JB). Vid avflyttning
    ska lokalen återställas i det skick den var vid tillträdet om inte
    annat skriftligen överenskommits.
  </div>

  <h2>§ 10 — Andrahandsuthyrning och överlåtelse <span class="lawref">(12 kap. 32, 39 §§ JB)</span></h2>
  <div class="clause">
    ${
      lease.sublettingAllowed
        ? 'Andrahandsuthyrning är tillåten med hyresvärdens skriftliga godkännande för varje enskilt fall.'
        : 'Andrahandsuthyrning är inte tillåten utan hyresvärdens skriftliga godkännande.'
    }
    Överlåtelse av lokalen vid överlåtelse av rörelsen prövas enligt
    12 kap. 36 § JB. Hyresvärden får motsätta sig överlåtelse om hyresvärden
    har befogad anledning, exempelvis bristande skötsamhet eller betalnings-
    förmåga hos den nya hyresgästen.
  </div>

  ${fireSafetySection(input, 11)}

  ${accessSection(12)}

  ${insuranceSection(input, 13, 'commercial')}

  ${commonAreasSection(input, 14)}

  ${noticesSection(15)}

  ${moveOutSection(16)}

  ${forfeitureSection(17)}

  ${gdprSection(input, 18)}

  <h2>§ 19 — Tvistlösning</h2>
  <div class="clause">
    Tvister angående detta avtal — utöver vad som omfattas av Hyresnämndens
    medling enligt 12 kap. 58 § JB — prövas av tingsrätt på den ort där
    lokalen är belägen. Förlikningsförhandling enligt 12 kap. 58 a § JB
    ska föregås av medling i Hyresnämnden.
  </div>

  <h2>§ 20 — Underskrifter</h2>
  ${signatureBlock(input)}

  ${footer(input)}
  `

  return buildHtmlShell({
    primaryColor,
    title: 'HYRESKONTRAKT — LOKAL',
    subtitle: `Lokalhyresavtal · ${org.name}`,
    contractNumber,
    generatedDate: today,
    organizationName: org.name,
    logoDataUrl: org.logoDataUrl,
    body,
  })
}

// ─── § 6 indexklausul (lokalvariant — KPI eller MARKET_RENT) ─────────────

function renderIndexClause(input: ContractTemplateInput): string {
  const { lease } = input
  if (lease.indexClauseType === 'NONE') return ''

  const limits: string[] = []
  if (lease.indexMaxIncrease != null && Number(lease.indexMaxIncrease) > 0) {
    limits.push(`maximalt ${Number(lease.indexMaxIncrease)} % per år`)
  }
  if (lease.indexMinIncrease != null && Number(lease.indexMinIncrease) > 0) {
    limits.push(`minst ${Number(lease.indexMinIncrease)} % per år`)
  }

  const adjustmentLine = (() => {
    if (!lease.indexAdjustmentDate) return 'en gång per år'
    if (lease.indexAdjustmentDate === 'anniversary') return 'på avtalets årsdag varje år'
    return `den ${escape(lease.indexAdjustmentDate)} varje år`
  })()

  const baseYear = lease.indexBaseYear ?? new Date(lease.startDate).getFullYear()

  let body: string
  if (lease.indexClauseType === 'KPI') {
    body = `
    <div class="clause">
      <span class="clause-number">6.1</span>
      Hyran är knuten till Statistiska centralbyråns konsumentprisindex (KPI)
      med basår <strong>${baseYear}</strong>. Hyran justeras ${adjustmentLine}
      med förändringen i KPI sedan basåret${limits.length ? `, dock ${limits.join(' och ')}` : ''}.
    </div>
    <div class="clause">
      <span class="clause-number">6.2</span>
      Justeringen meddelas hyresgästen skriftligen senast tre månader före
      ändringens ikraftträdande.
    </div>`
  } else if (lease.indexClauseType === 'MARKET_RENT') {
    body = `
    <div class="clause">
      <span class="clause-number">6.1</span>
      Vid förlängning av avtalet ska hyran justeras till då gällande
      marknadshyra för jämförbara lokaler i området, i enlighet med
      12 kap. 57 a § JB.
    </div>
    <div class="clause">
      <span class="clause-number">6.2</span>
      Vid oenighet om marknadshyrans nivå hänskjuts frågan till
      Hyresnämnden för medling enligt 12 kap. 58 § JB.
    </div>
    ${
      limits.length
        ? `<div class="clause"><span class="clause-number">6.3</span> Mellan justeringstillfällen får hyran ändras ${limits.join(' och ')}.</div>`
        : ''
    }`
  } else {
    body = `
    <div class="clause">
      Hyresgästen och hyresvärden har förhandlat fram en fast hyra för
      avtalsperioden. Vid förlängning kan parterna avtala om ny hyra.
    </div>`
  }

  if (lease.indexNotes) {
    body += `<div class="info-box"><strong>Anteckning om indexklausulen:</strong><br>${escape(lease.indexNotes)}</div>`
  }

  return `
  <h2>§ 6 — Hyresjustering / indexklausul <span class="lawref">(12 kap. 19, 57 a §§ JB)</span></h2>
  ${body}`
}
