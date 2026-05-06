// Validering av svenska organisationsnummer per företagsform.
//
// Skiljer mellan juridiska personer (AB/HB/KB/Förening/Stiftelse — 10
// siffror där prefixet talar om vilken form det är) och enskild firma
// (personnummer-format, 10 eller 12 siffror).
//
// Båda fallen Luhn-valideras enligt Skatteverkets modulus-10 (samma
// algoritm som personnummer — varje udda position dubblas räknat från
// vänster, summan modulo 10 ger kontrollsiffran).
//
// Vi exporterar dessa från shared så att frontend kan göra samma
// validering live i formuläret som backend gör vid POST /auth/register.

export type SwedishCompanyForm = 'AB' | 'ENSKILD_FIRMA' | 'HB' | 'KB' | 'FORENING' | 'STIFTELSE'

export interface OrgNumberValidationResult {
  valid: boolean
  // Sätts om validatorn kunde härleda formen utan att den angavs som
  // input. Används av registreringsformuläret för att auto-välja rätt
  // alternativ när användaren bara skrivit in numret.
  detectedForm?: SwedishCompanyForm
  // Normaliserad version (med bindestreck): "5560000000" → "556000-0000"
  // för juridisk person, "198512251234" → "19851225-1234" för EF.
  normalized?: string
  // Användarvänligt felmeddelande på svenska. Sätts bara när valid=false.
  error?: string
}

// Prefix per företagsform — de TVÅ FÖRSTA siffrorna i ett 10-siffrigt
// organisationsnummer talar om vilken form det är.
//
// OBS: 16, 91 och 92 förekommer både för AB och HB/KB. När användaren
// angivit form kontrollerar vi att prefixet matchar; när detection-only
// returnerar vi den vanligaste tolkningen (AB först).
const FORM_PREFIXES: Record<Exclude<SwedishCompanyForm, 'ENSKILD_FIRMA'>, string[]> = {
  AB: ['16', '55', '77', '91', '92'],
  HB: ['16', '91', '92'],
  KB: ['16', '91', '92'],
  FORENING: ['71', '78'],
  STIFTELSE: ['80'],
}

// Företagsformer i prioritetsordning vid auto-detektion. AB först eftersom
// det är överlägset vanligast, sedan ekonomisk förening/stiftelse innan
// HB/KB (som delar prefix-rymd med AB).
const DETECTION_ORDER: Array<Exclude<SwedishCompanyForm, 'ENSKILD_FIRMA'>> = [
  'AB',
  'FORENING',
  'STIFTELSE',
  'HB',
  'KB',
]

// Skatteverkets modulus-10 — varannan siffra dubblas med start från
// vänster (positioner 0,2,4,6,8). Identisk med personnummer-checksum.
function luhnMod10FromLeft(nineDigits: string): number {
  let sum = 0
  for (let i = 0; i < nineDigits.length; i++) {
    let n = parseInt(nineDigits.charAt(i), 10)
    if (i % 2 === 0) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return (10 - (sum % 10)) % 10
}

function stripFormatting(raw: string): string {
  return raw.replace(/[\s+-]/g, '')
}

function isValidLuhn(tenDigits: string): boolean {
  if (!/^\d{10}$/.test(tenDigits)) return false
  const check = parseInt(tenDigits.slice(9, 10), 10)
  return luhnMod10FromLeft(tenDigits.slice(0, 9)) === check
}

// Returnerar fullt 4-siffrigt år givet personnummer-input. Personnummer
// utan sekel: tolkas som 19xx eller 20xx beroende på om det är i framtid.
// Personnummer med +-tecken indikerar att personen är äldre än 100 år —
// vi stödjer det av historiskt rättviseskäl, men det är ovanligt.
function inferYear(raw: string, body: string, hasPlus: boolean): number {
  if (raw.length === 12 || (raw.length === 13 && raw.includes('-'))) {
    // Format YYYYMMDD-XXXX: yearFull finns explicit i de första 4 siffrorna.
    const cleaned = stripFormatting(raw)
    return parseInt(cleaned.slice(0, 4), 10)
  }
  const yy = parseInt(body.slice(0, 2), 10)
  const currentYY = new Date().getFullYear() % 100
  const baseCentury = yy <= currentYY ? 2000 : 1900
  return hasPlus ? baseCentury - 100 : baseCentury + yy
}

// Verifiera att datumet i personnumret är giltigt och att personen är
// minst 18 år. Stödjer både samordningsnummer (dag + 60) och vanliga
// personnummer.
function validatePersonalNumberDate(
  body: string,
  yearFull: number,
  minAgeYears: number,
): { valid: boolean; error?: string; age?: number } {
  const month = parseInt(body.slice(2, 4), 10)
  const dayRaw = parseInt(body.slice(4, 6), 10)
  const isCoordination = dayRaw > 60 && dayRaw <= 91
  const day = isCoordination ? dayRaw - 60 : dayRaw

  if (month < 1 || month > 12) {
    return { valid: false, error: 'Personnummer: månaden är ogiltig (måste vara 01–12)' }
  }
  if (day < 1 || day > 31) {
    return { valid: false, error: 'Personnummer: dagen är ogiltig (måste vara 01–31)' }
  }

  const date = new Date(yearFull, month - 1, day)
  if (date.getFullYear() !== yearFull || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { valid: false, error: 'Personnummer: datum existerar inte i kalendern' }
  }

  const today = new Date()
  if (date > today) {
    return { valid: false, error: 'Personnummer: födelsedatum kan inte ligga i framtiden' }
  }

  let age = today.getFullYear() - yearFull
  const beforeBirthday =
    today.getMonth() < month - 1 || (today.getMonth() === month - 1 && today.getDate() < day)
  if (beforeBirthday) age -= 1

  if (age < minAgeYears) {
    return {
      valid: false,
      error: `Enskild firma kräver att näringsidkaren är minst ${minAgeYears} år gammal`,
      age,
    }
  }

  return { valid: true, age }
}

function normalizeOrgNumber(tenDigits: string): string {
  return `${tenDigits.slice(0, 6)}-${tenDigits.slice(6)}`
}

function normalizePersonalNumber(twelveDigits: string): string {
  return `${twelveDigits.slice(0, 8)}-${twelveDigits.slice(8)}`
}

/**
 * Validera ett svenskt organisationsnummer mot en given (eller
 * auto-detekterad) företagsform.
 *
 * @param raw Användarens inmatade nummer i valfritt format med eller
 *   utan bindestreck/mellanslag.
 * @param companyForm Förväntad företagsform. Om utelämnad försöker
 *   validatorn detektera formen utifrån prefix.
 */
export function validateSwedishOrgNumber(
  raw: string | null | undefined,
  companyForm?: SwedishCompanyForm,
): OrgNumberValidationResult {
  if (!raw || !raw.trim()) {
    return { valid: false, error: 'Organisationsnummer krävs' }
  }

  const cleaned = stripFormatting(raw)

  // ── Enskild firma: personnummer-format ─────────────────────────────────
  if (companyForm === 'ENSKILD_FIRMA') {
    if (!/^(\d{10}|\d{12})$/.test(cleaned)) {
      return {
        valid: false,
        error:
          'Enskild firma: personnummer måste vara 10 eller 12 siffror (ÅÅMMDD-XXXX eller ÅÅÅÅMMDD-XXXX)',
      }
    }

    const body = cleaned.length === 12 ? cleaned.slice(2) : cleaned
    const yearFull = inferYear(raw, body, raw.includes('+'))

    const dateCheck = validatePersonalNumberDate(body, yearFull, 18)
    if (!dateCheck.valid) {
      return { valid: false, error: dateCheck.error ?? 'Ogiltigt personnummer' }
    }

    if (luhnMod10FromLeft(body.slice(0, 9)) !== parseInt(body.slice(9, 10), 10)) {
      return {
        valid: false,
        error: 'Personnummer: kontrollsiffran stämmer inte (kontrollera de fyra sista siffrorna)',
      }
    }

    // body är 10 siffror (YYMMDDNNNK). Vi bygger 12-siffrigt med fullt
    // år genom att ersätta de två första (YY) med yearFull (YYYY).
    const yearStr = String(yearFull).padStart(4, '0')
    const twelveDigits = `${yearStr}${body.slice(2)}`
    const normalized = normalizePersonalNumber(twelveDigits)
    return { valid: true, detectedForm: 'ENSKILD_FIRMA', normalized }
  }

  // ── Juridisk person: 10 siffror, prefix per företagsform ───────────────
  if (!/^\d{10}$/.test(cleaned)) {
    return {
      valid: false,
      error: 'Organisationsnummer måste vara 10 siffror (XXXXXX-XXXX)',
    }
  }
  if (!isValidLuhn(cleaned)) {
    return {
      valid: false,
      error: 'Organisationsnummer: kontrollsiffran stämmer inte (Luhn-modulus 10)',
    }
  }

  const prefix = cleaned.slice(0, 2)

  // Användaren angav form — kontrollera att prefixet matchar. Vid det här
  // laget vet TS att companyForm inte är ENSKILD_FIRMA (den grenen
  // returnerade ovan), så indexering i FORM_PREFIXES är typsäker.
  if (companyForm) {
    const allowed = FORM_PREFIXES[companyForm]
    if (!allowed.includes(prefix)) {
      const formName = formDisplayName(companyForm)
      return {
        valid: false,
        error: `${formName} har normalt prefix ${allowed.join('/')} — du angav ${prefix}xxxx-xxxx. Kontrollera företagsformen.`,
      }
    }
    return {
      valid: true,
      detectedForm: companyForm,
      normalized: normalizeOrgNumber(cleaned),
    }
  }

  // Auto-detektion: leta efter första matchande form i prioritetsordning.
  const detected = DETECTION_ORDER.find((form) => FORM_PREFIXES[form].includes(prefix))
  if (!detected) {
    return {
      valid: false,
      error: `Prefix ${prefix} matchar ingen känd svensk företagsform`,
    }
  }
  return {
    valid: true,
    detectedForm: detected,
    normalized: normalizeOrgNumber(cleaned),
  }
}

export function formDisplayName(form: SwedishCompanyForm): string {
  switch (form) {
    case 'AB':
      return 'Aktiebolag (AB)'
    case 'ENSKILD_FIRMA':
      return 'Enskild firma'
    case 'HB':
      return 'Handelsbolag (HB)'
    case 'KB':
      return 'Kommanditbolag (KB)'
    case 'FORENING':
      return 'Ideell förening'
    case 'STIFTELSE':
      return 'Stiftelse'
  }
}

export const COMPANY_FORM_OPTIONS: ReadonlyArray<{
  value: SwedishCompanyForm
  label: string
  description: string
}> = [
  {
    value: 'AB',
    label: 'Aktiebolag (AB)',
    description: 'Eget kapital 2080-serien · juridisk person',
  },
  {
    value: 'ENSKILD_FIRMA',
    label: 'Enskild firma',
    description: 'Personnummer som org-nr · eget kapital 2010-serien',
  },
  {
    value: 'HB',
    label: 'Handelsbolag (HB)',
    description: 'Två eller flera bolagsmän · obegränsat ansvar',
  },
  {
    value: 'KB',
    label: 'Kommanditbolag (KB)',
    description: 'Komplementär + kommanditdelägare',
  },
  {
    value: 'FORENING',
    label: 'Ideell förening',
    description: 'Organisationsnummer prefix 71/78',
  },
  {
    value: 'STIFTELSE',
    label: 'Stiftelse',
    description: 'Förmögenhet förvaltad enligt urkund',
  },
]
