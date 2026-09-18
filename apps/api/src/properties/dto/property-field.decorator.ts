import { registerDecorator } from 'class-validator'
import type { z } from 'zod'

/** Fältregler från fastighetskontraktet, även genom PartialType på PATCH.
 * DTO/dekoratorer äger fortsatt whitelist, metadata och frånvaro; detta
 * återanvänder sakreglerna utan att byta API:ts globala valideringsmotor.
 */
export function PropertyField(schema: z.ZodTypeAny): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'propertyField',
      target: target.constructor,
      propertyName: String(propertyKey),
      validator: {
        validate: (value: unknown) => schema.safeParse(value).success,
        defaultMessage: (args) => {
          const result = schema.safeParse(args?.value)
          return result.success
            ? 'Ogiltigt fastighetsvärde'
            : `${String(propertyKey)}: ${result.error.issues.map((issue) => issue.message).join('; ')}`
        },
      },
    })
  }
}
