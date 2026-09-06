import { PaymentMethodSchema, type PaymentMethodInput } from '@eken/shared'

/**
 * DE FEM ALTERNATIVEN, OCH VAD DE BETYDER I HUVUDBOKEN.
 *
 * Gränssnittet är finare än enumen: bankgiro, plusgiro och autogiro bokförs alla
 * mot 1930 och är därför samma `PaymentMethod`. Skillnaden kastades tidigare i en
 * textmappning på servern (`toPaymentMethod`), och det valda ordet fanns sedan
 * ingenstans — varken i en kolumn eller i händelseloggen.
 *
 * Nu skickas BÅDA: enumen som bokförs och etiketten som bevaras
 * (`paymentMethodRaw`). Listan är alltså en ÖVERSÄTTNING, inte en andra sanning
 * om vilka betalsätt som finns — `metod` är typad mot `PaymentMethodSchema`, så
 * ett värde utanför enumen är ett kompileringsfel.
 *
 * Ligger i en egen fil och inte i sidan därför att webbens vitest kör
 * `environment: 'node'` och inte renderar något; en tabell inne i en `.tsx` går
 * inte att pröva.
 */
export const BETALSATT: ReadonlyArray<{ etikett: string; metod: PaymentMethodInput }> = [
  { etikett: 'Bankgiro', metod: 'BANK' },
  { etikett: 'Plusgiro', metod: 'BANK' },
  { etikett: 'Swish', metod: 'SWISH' },
  { etikett: 'Kontant', metod: 'CASH' },
  { etikett: 'Autogiro', metod: 'BANK' },
]

/**
 * Etikett → enum. Okänd etikett ger `MANUAL` OCH behåller etiketten i
 * `paymentMethodRaw`, så spåret finns kvar — till skillnad från den gamla
 * serverside-mappningen, där ordet försvann.
 */
export function metodForEtikett(etikett: string): PaymentMethodInput {
  return BETALSATT.find((b) => b.etikett === etikett)?.metod ?? 'MANUAL'
}

/** Varje etikett i listan är unik — annars kan dropdownen visa två likadana. */
export const ETIKETTER = BETALSATT.map((b) => b.etikett)

/** Alla enumvärden, för prov som ska täcka hela mängden. */
export const ALLA_METODER = PaymentMethodSchema.options
