/**
 * AKTÖRSSTÄMPLINGEN — kolumnen sätts av MEKANIKEN, inte av anropsstället.
 *
 * Systerextension till `aiEffectExtension`. Se `common/actor/actor.context.ts`
 * för varför det är en kontext och inte ett argument, och för priset.
 *
 * ── MODELLMÄNGDEN HÄRLEDS UR SCHEMAT ────────────────────────────────────────
 *
 * Ur Prismas DMMF: varje modell som HAR fältet `actorKind` stämplas. Ingen
 * lista i den här filen, och därför inget som kan glida isär från schemat — en
 * modell som får kolumnen i morgon stämplas utan att någon rör extensionen, och
 * en som förlorar den slutar stämplas utan ett kast. (En uppräkning krymper
 * tyst; en härledning gör det inte.)
 *
 * ── BARA VID SKAPANDE, OCH DET ÄR ETT BESLUT ────────────────────────────────
 *
 * Kolumnen betyder VEM SOM SKAPADE RADEN. Den skrivs därför bara av `create`,
 * `createMany`, `createManyAndReturn` och `upsert`:s create-gren.
 *
 * Alternativet — att stämpla vid varje `update` — hade gjort kolumnen till "vem
 * skrev senast", och då raderar en cron som rör en rad den människa som skapade
 * den. Det är AKTIVT sämre än att inte veta: ett fält som byter betydelse med
 * tiden svarar fel på den fråga någon ställer om ett år. Vem som ÄNDRADE en rad
 * hör hemma i händelseloggarna, som redan bär `actorType` per händelse.
 *
 * ── UTANFÖR DE TRE GRÄNSERNA SÄTTS INGENTING ────────────────────────────────
 *
 * Inget default, inget HUMAN. Fältet utelämnas helt (inte `undefined` —
 * `exactOptionalPropertyTypes` och Prismas `UncheckedCreateInput` skiljer på
 * saknat och undefined), och kolumnen blir NULL = okänt.
 *
 * Att det inte blir ett tyst normaltillstånd ägs av `ActorNullSweepService`,
 * som mäter NULL efter brytpunkten. Se kontextfilen.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att gränserna faktiskt är satta. Extensionen stämplar vad kontexten säger; är
 * ingen gräns påkopplad stämplar den ingenting och är ändå "korrekt". Den
 * påkopplingen ägs av `check-actor-stamping.mjs` (källtext) och av
 * `actor-stamp.db.spec.ts` (kör de tre vägarna mot riktig Postgres).
 *
 * ── ORDNINGEN MOT aiEffectExtension: MÄTT, SPELAR INGEN ROLL ────────────────
 *
 * Uppmätt: `$extends(A).$extends(B)` ger `A:före B:före B:efter A:efter` — den
 * FÖRST tillämpade är ytterst. `aiEffectExtension` tillämpas först, så den här
 * ligger innanför.
 *
 * Det spelar ingen roll, och skälet är mätt och inte antaget: effektextensionen
 * rör aldrig `args`. Alla dess förekomster av `args` är parameterdeklarationen
 * och genomsläppet `await query(args)`; den läser `model`, `operation` och
 * `resultat`. Den här skriver bara `args.data`. Två mekanismer på samma krok som
 * inte delar yta — men ordningen står här, så nästa person slipper härleda om.
 */
import { Prisma } from '@prisma/client'

import { currentActor } from '../actor/actor.context'

/** Modeller som BÄR kolumnen — härlett ur schemat, aldrig listat. */
export const STÄMPLADE_MODELLER: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'actorKind'))
    .map((m) => m.name),
)

/** Skapande operationer. `update`/`updateMany`/`delete*` står med flit utanför. */
const SKAPANDE = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert'])

function stämpla(data: unknown, kind: string): unknown {
  if (Array.isArray(data)) return data.map((d) => stämpla(d, kind))
  if (!data || typeof data !== 'object') return data
  // Skriv aldrig över ett värde anroparen satt. Att det INTE ska finnas några
  // sådana anropare är en egen regel i vakten — här är det bara ofarligt.
  if ('actorKind' in (data as Record<string, unknown>)) return data
  return { ...(data as Record<string, unknown>), actorKind: kind }
}

export const actorStampExtension = {
  name: 'actor-stamping',
  query: {
    $allModels: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string
        operation: string
        args: unknown
        query: (args: unknown) => Promise<unknown>
      }) {
        const kind = currentActor()
        if (!kind || !model || !SKAPANDE.has(operation) || !STÄMPLADE_MODELLER.has(model)) {
          return query(args)
        }

        const a = args as Record<string, unknown>
        if (operation === 'upsert') {
          // Bara create-grenen. `update` bär vem som skapade raden, inte vem
          // som rörde den senast — se docblocket.
          return query({ ...a, create: stämpla(a['create'], kind) })
        }
        return query({ ...a, data: stämpla(a['data'], kind) })
      },
    },
  },
}
