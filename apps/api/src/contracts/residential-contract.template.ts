// Bostadshyreskontrakt enligt 12 kap. Jordabalken (Hyreslagen).
//
// Mallens 19 paragrafer följer branschpraxis för enterprise-grade
// bostadsavtal och är synkad med tvingande regler i 12 kap. JB. Varje
// paragraf anger relevant laghänvisning så att en jurist kan revidera
// mallen utan att behöva gräva i koden.
//
// Skillnader mot lokalmallen:
//   – tvingande hyresgästskydd (besittningsskydd 46 §, bytesrätt 65 §)
//   – husdjur som egen paragraf
//   – skriftligt godkännande för andrahandsuthyrning (12:39 §)
//   – tvister till Hyresnämnden (12:69 §)

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
  petPolicyText,
  RENT_DUE_TEXT,
  escape,
} from './contract-template.shared'

export function buildResidentialContractHtml(input: ContractTemplateInput): string {
  const { lease, organization: org } = input

  const primaryColor = org.invoiceColor ?? '#1a6b3c'
  const contractNumber = lease.id.slice(0, 8).toUpperCase()
  const today = new Date().toLocaleDateString('sv-SE')

  const noticePeriod =
    lease.noticePeriodMonths > 0 ? `${lease.noticePeriodMonths} månader` : '3 månader'

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

  ${objectSection(input, { useLabel: 'Användning', purposeLine: 'Bostad' })}

  <h2>§ 3 — Hyrestid och uppsägning <span class="lawref">(12 kap. 4–8 §§ JB)</span></h2>
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
      ? `<div class="field-row"><span class="field-label">Förlängning</span><span class="field-value">Avtalet förlängs automatiskt med ${lease.renewalPeriodMonths} månader om uppsägning inte sker enligt nedan.</span></div>`
      : ''
  }
  <div class="clause">
    Uppsägning ska ske skriftligen enligt 12 kap. 8 § Jordabalken.
    För hyresgästen gäller 3 månaders uppsägningstid till månadsskifte
    om inte annan kortare tid avtalats. Hyresgästen har besittningsskydd
    enligt 12 kap. 46 § JB.
  </div>

  <h2>§ 4 — Hyra, betalning och vad som ingår <span class="lawref">(12 kap. 19–20 §§ JB)</span></h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="label">Månadshyra</div>
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
  <div class="clause">
    <span class="clause-number">4.1</span> ${RENT_DUE_TEXT}
  </div>
  ${
    includes.included.length
      ? `
  <div class="clause">
    <span class="clause-number">4.2</span>
    Följande ingår i hyran utan tillkommande avgift:
    <ul class="clause-list">
      ${includes.included.map((i) => `<li>${escape(i)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }
  ${
    includes.excluded.length
      ? `
  <div class="clause">
    <span class="clause-number">4.3</span>
    Följande ingår <strong>inte</strong> i hyran och bekostas av hyresgästen:
    <ul class="clause-list">
      ${includes.excluded.map((i) => `<li>${escape(i)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }
  ${
    supplementsRows.length
      ? `
  <div class="clause">
    <span class="clause-number">4.4</span>
    Tilläggshyror utöver grundhyran:
    <ul class="clause-list">
      ${supplementsRows.map((r) => `<li>${escape(r)}</li>`).join('')}
    </ul>
  </div>`
      : ''
  }

  ${renderIndexClause(input)}

  ${depositSection(input, lease.depositAmount && Number(lease.depositAmount) > 0 ? 6 : 6)}

  <h2>§ 7 — Skick och underhåll <span class="lawref">(12 kap. 9, 15, 24 §§ JB)</span></h2>
  <div class="clause">
    <span class="clause-number">7.1</span>
    Hyresgästen övertar lägenheten i det skick som framgår av tillträdes-
    besiktningen, vilken bifogas detta avtal eller upprättas i samband med
    inflyttning.
  </div>
  <div class="clause">
    <span class="clause-number">7.2</span>
    Hyresgästens ansvar omfattar löpande renhållning, normal omvårdnad av
    ytskikt samt reparation av skador som uppkommit genom hyresgästens
    eller dennes hushålls/gästers vårdslöshet.
  </div>
  <div class="clause">
    <span class="clause-number">7.3</span>
    Hyresvärdens ansvar omfattar fastighetens stomme och installationer
    samt det löpande underhållet enligt 12 kap. 15 § JB. Vitvaror som
    levereras med lägenheten underhålls och ersätts av hyresvärden.
  </div>
  <div class="clause">
    <span class="clause-number">7.4</span>
    Förändringar i lägenheten — exempelvis ommålning utöver normal kulör,
    nedtagning av väggar, byte av kök eller badrum — kräver hyresvärdens
    skriftliga samtycke i enlighet med 12 kap. 24 § JB.
  </div>

  <h2>§ 8 — Andrahandsuthyrning <span class="lawref">(12 kap. 39–41 §§ JB)</span></h2>
  <div class="clause">
    ${
      lease.sublettingAllowed
        ? 'Andrahandsuthyrning är tillåten med hyresvärdens skriftliga godkännande för varje enskilt fall.'
        : 'Andrahandsuthyrning är inte tillåten utan hyresvärdens skriftliga godkännande.'
    }
    Vid avslag har hyresgästen rätt att hänskjuta frågan till Hyresnämnden
    enligt 12 kap. 40 § JB. Tillstånd ges normalt för högst två år åt gången
    och förutsätter beaktansvärda skäl.
  </div>

  <h2>§ 9 — Husdjur</h2>
  <div class="clause">${escape(petPolicyText(lease.petsAllowed))}</div>
  ${lease.petsApprovalNotes ? `<div class="clause">${escape(lease.petsApprovalNotes)}</div>` : ''}

  ${fireSafetySection(input, 10)}

  ${accessSection(11)}

  ${insuranceSection(input, 12, 'residential')}

  ${commonAreasSection(input, 13)}

  ${noticesSection(14)}

  ${moveOutSection(15)}

  ${forfeitureSection(16)}

  ${gdprSection(input, 17)}

  <h2>§ 18 — Tvistlösning <span class="lawref">(12 kap. 69 § JB)</span></h2>
  <div class="clause">
    Tvister i anledning av detta avtal ska i första hand hänskjutas till
    Hyresnämnden i berört län. Frågor om förverkande och avhysning prövas
    av tingsrätt.
  </div>

  <h2>§ 19 — Underskrifter</h2>
  ${signatureBlock(input)}

  ${footer(input)}
  `

  return buildHtmlShell({
    primaryColor,
    title: 'HYRESKONTRAKT — BOSTAD',
    subtitle: `Bostadslägenhet · ${org.name}`,
    contractNumber,
    generatedDate: today,
    organizationName: org.name,
    logoDataUrl: org.logoDataUrl,
    body,
  })
}

// ─── § 5 indexklausul (visas BARA om typ !== NONE) ───────────────────────

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

  let body = ''
  if (lease.indexClauseType === 'KPI') {
    body = `
    <div class="clause">
      <span class="clause-number">5.1</span>
      Hyran är knuten till Statistiska centralbyråns konsumentprisindex (KPI).
      Basår är <strong>${baseYear}</strong>.
    </div>
    <div class="clause">
      <span class="clause-number">5.2</span>
      Hyran justeras ${adjustmentLine} med förändringen i KPI sedan basåret${limits.length ? `, dock ${limits.join(' och ')}` : ''}.
      Justering meddelas hyresgästen skriftligen senast tre månader före
      ändringens ikraftträdande.
    </div>
    <div class="clause">
      <span class="clause-number">5.3</span>
      För bostadshyresavtal gäller utöver detta villkor 12 kap. 19 och 54 §§
      Jordabalken. Tvist om hyrans skälighet kan prövas av Hyresnämnden.
    </div>`
  } else if (lease.indexClauseType === 'NEGOTIATED') {
    body = `
    <div class="clause">
      <span class="clause-number">5.1</span>
      Hyran är förhandlad enligt hyresförhandlingslagen (1978:304) och
      omfattas av kollektiv förhandlingsordning. Hyresjustering följer
      den vid var tid gällande förhandlingsöverenskommelsen mellan
      hyresvärden och berörd hyresgästorganisation.
    </div>
    <div class="clause">
      <span class="clause-number">5.2</span>
      Vid utebliven överenskommelse prövas hyran enligt 12 kap. 19 och
      55 §§ Jordabalken (bruksvärdesprincipen).
    </div>`
  } else {
    body = `
    <div class="clause">
      Hyran är fast under avtalsperioden${
        lease.indexNotes ? '' : '. Vid förlängning kan parterna avtala om ny hyra.'
      }
    </div>`
  }

  if (lease.indexNotes) {
    body += `<div class="info-box"><strong>Anteckning om indexklausulen:</strong><br>${escape(lease.indexNotes)}</div>`
  }

  return `
  <h2>§ 5 — Hyresjustering / indexklausul <span class="lawref">(12 kap. 19, 54–55 §§ JB)</span></h2>
  ${body}`
}
