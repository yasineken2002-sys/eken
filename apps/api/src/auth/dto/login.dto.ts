import { IsEmail, IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

import type { LoginInput, SammaNycklar } from '@eken/shared'

/**
 * INLOGGNING VALIDERAR INTE LÖSENORDSSTYRKA — AVSIKTLIG BETEENDEÄNDRING.
 *
 * Fältet bar `@MinLength(8)` fram till 2026-09-07. Det togs bort, och det är
 * inte en kontraktsstädning utan en ändring av vad autentiseringen GÖR:
 *
 *   före   ett 7 tecken långt lösenord gav 400 med "password must be longer
 *          than or equal to 8 characters"
 *   efter  samma lösenord ger 401, samma svar som varje annat felaktigt försök
 *
 * Tre skäl, och de pekar åt samma håll:
 *
 *   ORAKEL      svaret skilde sig beroende på indata, för en OINLOGGAD anropare.
 *               Att gränsen är åtta går att läsa ur felmeddelandet, alltså
 *               läckte endpointen lösenordspolicyn till den som frågade.
 *   UTESTÄNGNING en användare vars lösenord sattes före dagens krav — eller av
 *               en administratör — kunde inte logga in alls. Hen fick ett
 *               valideringsfel om formen på sitt eget korrekta lösenord.
 *   FEL PLATS   styrkekravet hör till REGISTRERING och BYTE, där det redan är
 *               EN källa: `@IsStrongPassword()` och `StrongPasswordSchema`
 *               härleds båda ur `PASSWORD_MIN_LENGTH` och
 *               `PASSWORD_SPECIAL_CHAR_REGEX`. Inloggningen ska bara avgöra om
 *               det som skickades stämmer, inte om det hade dugt som nytt.
 *
 * Kravet som står kvar är att fältet inte är TOMT — samma som `LoginSchema`.
 * Utan det blir en tom sträng ett bcrypt-anrop utan mening.
 *
 * SÄKERHETSRIKTNINGEN: ändringen gör inte något svagare. Ett kort lösenord
 * kunde aldrig logga in — det fanns inget konto med ett sådant hash. Det som
 * ändras är VILKET NEJ som ges.
 *
 * ── VAD DEN HÄR ÄNDRINGEN INTE LÖSER ────────────────────────────────────────
 *
 * Status och svarskropp är nu identiska för "fel lösenord", "kontot finns inte"
 * och "för kort lösenord". TIDEN är det inte: `AuthService.login` returnerar
 * utan att köra `bcrypt.compare` när användaren saknas, men betalar en
 * jämförelse när kontot finns. Skillnaden är en timing-baserad uppräkning av
 * e-postadresser, och den är ORÖRD av den här ändringen — den fanns före och
 * finns kvar.
 *
 * Raden ovan sa först att "alla nej nu ser likadana ut". Det var sant om det
 * orakel ändringen faktiskt stänger — lösenordspolicyn som lästes ur ett 400 —
 * och osant som allmänt påstående. Funnet av security-auditor.
 *
 * Åtgärden vore en dummy-jämförelse mot en fast hash i den tidiga grenen, så
 * kostnaden blir konstant. Den ändrar autentiseringens beteende igen och hör
 * till ett eget beslut, inte till en kontrakts-PR.
 */
export class LoginDto implements LoginInput {
  @ApiProperty({ example: 'anna@foretag.se' })
  @IsEmail()
  email!: string

  @ApiProperty({ description: 'Prövas som det är — ingen styrkevalidering, se docblocket.' })
  @IsString()
  @MinLength(1)
  password!: string
}

const _kontraktLogin: SammaNycklar<LoginDto, LoginInput> = true
void _kontraktLogin
