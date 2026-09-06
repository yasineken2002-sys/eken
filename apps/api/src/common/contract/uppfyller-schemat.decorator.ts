import { registerDecorator } from 'class-validator'
import type { ValidationArguments, ValidationOptions } from 'class-validator'
import type { z } from 'zod'

/**
 * KORSFÄLTSREGLERNA KOMMER FRÅN SCHEMAT — inte från en andra uppräkning.
 *
 * ── PROBLEMET ───────────────────────────────────────────────────────────────
 *
 * `class-validator` validerar ETT FÄLT I TAGET. Regler som handlar om två fälts
 * FÖRHÅLLANDE — "ett indexfält kräver en indexklausul", "ange antingen en
 * befintlig hyresgäst eller en ny" — går inte att uttrycka i en fältdekorator.
 * De bodde därför bara i det delade schemats `superRefine`, och DTO:n släppte
 * igenom kroppar som schemat kallade ogiltiga.
 *
 * Uppmätt av paritetsprovet, som kräver att BÅDA halvorna avvisar samma kropp:
 *
 *   PATCH /leases/:id   { indexBaseYear: 2026 }   zod: avvisar · dto: SLÄPPTE IGENOM
 *   POST  /leases/with-tenant  (ingen motpart)    zod: avvisar · dto: SLÄPPTE IGENOM
 *
 * Den första var en verklig lucka: `leases.service.ts:149` skriver
 * `indexBaseYear` så snart det är satt, oavsett klausul, så ett basår som
 * beskriver en klausul som inte finns blev sparat. Den andra fångades längre in
 * (`leases.service.ts:1091`) — men av tjänsten, inte av kontraktet.
 *
 * ── LÖSNINGEN ───────────────────────────────────────────────────────────────
 *
 * Dekoratorn kör SCHEMATS egna refinements på hela kroppen. Reglerna skrivs
 * alltså en gång, i `@eken/shared`, och gäller i båda halvorna. Att i stället
 * skriva om dem som fältdekoratorer hade gett två uppräkningar som ska vara
 * lika — vilket inte är en uppräkning.
 *
 * Bara `custom`-utfall (de som kommer ur `superRefine`) fäller här. Fältnivåns
 * fel — fel typ, fel format, utanför intervallet — ägs av dekoratorerna, och
 * att låta båda rapportera dem hade gett dubbla felmeddelanden om samma sak.
 */
export function UppfyllerSchemat(
  schema: z.ZodTypeAny,
  valideringsOptioner?: ValidationOptions,
): ClassDecorator {
  return (target): void => {
    registerDecorator({
      name: 'uppfyllerSchemat',
      target: target as unknown as new (...args: never[]) => object,
      // Syntetiskt fältnamn: dekoratorn läser HELA kroppen ur `args.object`,
      // inte ett fältvärde. Namnet får inte kollidera med ett verkligt fält.
      //
      // KLASSUNIKT, och det är inte kosmetik. `PartialType(CreateLeaseDto)`
      // kopierar förälderns valideringsmetadata och lägger `@IsOptional()` på
      // VARJE fält — inklusive det syntetiska. Eftersom värdet alltid är
      // `undefined` hoppades kontrollen då över, och `UpdateLeaseDto` släppte
      // igenom exakt den kropp `CreateLeaseDto` avvisade. Uppmätt: paritets-
      // provet för PATCH /leases/:id förblev rött medan POST /leases blev grönt.
      propertyName: `__kontraktsvillkor_${(target as { name?: string }).name ?? 'anonym'}`,
      ...(valideringsOptioner ? { options: valideringsOptioner } : {}),
      validator: {
        validate(_varde: unknown, args?: ValidationArguments): boolean {
          const utfall = schema.safeParse(args?.object ?? {})
          if (utfall.success) return true
          return !utfall.error.issues.some((i) => i.code === 'custom')
        },
        defaultMessage(args?: ValidationArguments): string {
          const utfall = schema.safeParse(args?.object ?? {})
          if (utfall.success) return 'Kroppen bryter mot avtalets villkor'
          const custom = utfall.error.issues.filter((i) => i.code === 'custom')
          return custom.map((i) => i.message).join('; ')
        },
      },
    })
  }
}
