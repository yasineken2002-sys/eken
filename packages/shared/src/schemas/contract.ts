/**
 * KONTRAKTET MELLAN WEBB OCH API — kompileringstidens halva.
 *
 * ── PROBLEMET DEN LÖSER ─────────────────────────────────────────────────────
 *
 * Nyttolasten beskrivs i dag på TVÅ ställen: ett interface i webbens
 * `features/*​/api/*.ts` och en `class-validator`-klass i API:ts `dto/`. Ingen av
 * dem vet om den andra. Glider de isär märks det först som ett 400-svar i
 * produktion.
 *
 * Uppmätt (#795): modalen skickade inget `vatAmount` medan DTO:n krävde det.
 * Varje registrering hade svarat 400 — och **37 gröna prov** var fortsatt gröna,
 * eftersom samtliga anropade tjänsten direkt och gick förbi DTO:n.
 *
 * ── VARFÖR INTE createZodDto ────────────────────────────────────────────────
 *
 * `nestjs-zod` finns inte i repot, och att införa det hade bytt ut
 * valideringsmotorn för 90 DTO:er på en gång: felmeddelandena är svenska och
 * handskrivna, `@Transform` trimmar, och Swagger läser samma dekoratorer.
 * `class-validator` behålls därför som RUNTIME-validering — den är fortfarande
 * den som svarar 400 — och det här är enbart en KOMPILERINGSTIDS-koppling
 * ovanpå.
 *
 * ── HUR DEN ANVÄNDS ─────────────────────────────────────────────────────────
 *
 *   export class CreateXDto implements CreateXInput { … }
 *   const _kontrakt: SammaNycklar<CreateXDto, CreateXInput> = true
 *   void _kontrakt
 *
 * `implements` och nyckelpariteten fångar OLIKA saker, och båda behövs:
 *
 *   implements        fel TYP på ett fält som finns i båda
 *   SammaNycklar      ett fält som SAKNAS i den ena
 *
 * Uppmätt: en klass som utelämnar ett VALFRITT fält ur interfacet passerar
 * `implements` utan anmärkning — `{ a: string }` uppfyller `{ a: string; b?: … }`.
 * Bara pariteten fäller den, och det är just det fältet som blir ett 400 den dag
 * webben börjar skicka det.
 */

/**
 * `true` när A och B har EXAKT samma nyckelmängd; annars en objekttyp vars
 * fältnamn säger vilken sida som saknar vad.
 *
 * Felmeddelandet blir därför `Type 'boolean' is not assignable to type
 * '{ saknasIA: "vatAmount" }'` — alltså med det saknade fältets namn i klartext,
 * i stället för ett anonymt `never`.
 *
 * `[keyof A] extends [keyof B]` är tupelinpackat med flit: utan den blir det en
 * DISTRIBUTIV villkorstyp över unionen av nycklar, och då är svaret alltid sant
 * för varje enskild nyckel för sig.
 */
export type SammaNycklar<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : { saknasIA: Exclude<keyof B, keyof A> }
  : { saknasIB: Exclude<keyof A, keyof B> }
