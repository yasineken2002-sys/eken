import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  ENV_EXAMPLE_VALUES,
  PLACEHOLDER_CHECKED_VARS,
  PLACEHOLDER_WORD_THRESHOLD,
  SECRET_FORM_VARS,
  placeholderRejection,
  placeholderWordHits,
} from './env-placeholders'

/**
 * Håller `ENV_EXAMPLE_VALUES` i takt med `apps/api/.env.example`.
 *
 * Konstanten kan inte läsas vid runtime — exempelfilen kopieras inte in i
 * runner-imagen (Dockerfile:87-95), så en boot-läsning hade varit blind i
 * produktion. Den är därför speglad, och den här filen är det som gör spegeln
 * bindande: driftar exempelfilen blir testet rött.
 *
 * Samma form som repots övriga speglingar: parsern har ett GOLV (slutar den
 * hitta något ska den falla, inte tiga) och en KANARIEFÅGEL (mata in något som
 * MÅSTE ge utslag och kräv att det gör det). Utan kanariefågeln skulle en parser
 * som returnerar tom mängd göra varje likhetskontroll nedan trivialt grön.
 */

const EXAMPLE_PATH = path.join(__dirname, '..', '..', '.env.example')

/** Plockar `NAMN=värde` ur .env-innehåll. Hoppar kommentarer och tomma värden. */
function parseEnvExample(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq)
    if (!/^[A-Z0-9_]+$/.test(name)) continue
    const value = trimmed.slice(eq + 1).replace(/^"(.*)"$/, '$1')
    if (value) out[name] = value
  }
  return out
}

describe('env-placeholders — spegling av .env.example', () => {
  const content = fs.readFileSync(EXAMPLE_PATH, 'utf8')
  const parsed = parseEnvExample(content)

  it('parsern hittar rimligt många variabler (golv — en tyst parser ska falla)', () => {
    expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(30)
  })

  it('KANARIEFÅGEL: en injicerad platshållarrad MÅSTE plockas upp av parsern', () => {
    // Sondnamnet får inte redan finnas — annars går min injektion inte att
    // skilja från något befintligt (samma läxa som `totpSecret`-misstaget).
    const sond = 'ZZ_KANARIE_PLACEHOLDER_SOND'
    expect(content).not.toContain(sond)
    expect(parsed[sond]).toBeUndefined()

    const injicerad = parseEnvExample(`${content}\n${sond}=change-me-random-string\n`)
    expect(injicerad[sond]).toBe('change-me-random-string')
    // …och den ska dessutom fällas av formregeln, annars mäter kanariefågeln
    // bara parsern och inte kedjan.
    expect(placeholderWordHits('change-me-random-string').length).toBeGreaterThanOrEqual(
      PLACEHOLDER_WORD_THRESHOLD,
    )
  })

  it('varje speglat värde är identiskt med .env.example', () => {
    for (const [name, value] of Object.entries(ENV_EXAMPLE_VALUES)) {
      expect(parsed[name]).toBe(value)
    }
  })

  it('ingen kontrollerad variabel med värde i .env.example saknas i speglingen', () => {
    const saknade = PLACEHOLDER_CHECKED_VARS.filter(
      (name) => parsed[name] !== undefined && ENV_EXAMPLE_VALUES[name] === undefined,
    )
    expect(saknade).toEqual([])
  })

  it('speglingen innehåller inga variabler som inte kontrolleras', () => {
    const okontrollerade = Object.keys(ENV_EXAMPLE_VALUES).filter(
      (name) => !PLACEHOLDER_CHECKED_VARS.includes(name),
    )
    expect(okontrollerade).toEqual([])
  })
})

describe('placeholderRejection — regel A (exakt) och B (form)', () => {
  it('avvisar ett oförändrat .env.example-värde', () => {
    expect(placeholderRejection('R2_ACCESS_KEY_ID', 'your-r2-access-key-id')).toMatch(
      /platshållarvärde/,
    )
  })

  it('avvisar platshållarformen även när värdet INTE står i .env.example', () => {
    // Den formen — inte de här exakta strängarna — låg i prod till 2026-08-15.
    // Regel A hade släppt igenom samtliga; det är hela skälet till att regel B
    // finns. Värdena här är konstruerade, inte de historiska.
    for (const v of [
      'projekt-super-secret-jwt-key-2024-change-this',
      'platform-secret-jwt-nyckel-demo',
      'insecure-default-password-1234',
    ]) {
      expect(placeholderRejection('JWT_SECRET', v)).toMatch(/platshållare/)
    }
  })

  it('ett ensamt ord räcker INTE (tröskeln är två)', () => {
    expect(placeholderWordHits('kR9-secret-vQ2mZ7pLxT4nB8')).toEqual(['secret'])
    expect(placeholderRejection('JWT_SECRET', 'kR9-secret-vQ2mZ7pLxT4nB8')).toBeNull()
  })

  it('släpper igenom riktiga hemligheter — inga falsklarm', () => {
    for (let i = 0; i < 200; i++) {
      expect(
        placeholderRejection('JWT_SECRET', crypto.randomBytes(48).toString('base64')),
      ).toBeNull()
      expect(
        placeholderRejection('SIGNING_PII_KEY', crypto.randomBytes(32).toString('hex')),
      ).toBeNull()
      expect(
        placeholderRejection(
          'ANTHROPIC_API_KEY',
          `sk-ant-api03-${crypto.randomBytes(64).toString('base64url')}`,
        ),
      ).toBeNull()
    }
  })

  it('formregeln rör INTE variabler utanför SECRET_FORM_VARS', () => {
    // En förbindelsesträng får legitimt bära ord som "default" eller "test".
    expect(SECRET_FORM_VARS).not.toContain('DATABASE_URL')
    expect(
      placeholderRejection('DATABASE_URL', 'postgresql://u:p@db.internal:5432/test_default'),
    ).toBeNull()
  })

  it('rör inte variabler som legitimt är lika exempelfilen', () => {
    // R2_BUCKET_NAME=eken-documents är identiskt i .env.example och prod. Hade
    // regel A gällt en platt mängd i stället för per variabel hade den blockerat
    // boot på ett korrekt värde.
    expect(PLACEHOLDER_CHECKED_VARS).not.toContain('R2_BUCKET_NAME')
    expect(placeholderRejection('R2_BUCKET_NAME', 'eken-documents')).toBeNull()
  })
})
