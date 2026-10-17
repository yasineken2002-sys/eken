import { createHash, type Hash } from 'node:crypto'
import { CheckpointContextSchema } from './fortnox-read-checkpoint-context'
import { stable } from './fortnox-ledger-validation'

type ContextKind = 'MAPPINGS' | 'OWN_EXPORTS'
const mappingsSchema = CheckpointContextSchema.shape.mappings.max(100)
const exportsSchema = CheckpointContextSchema.shape.ownExports.max(100)

/**
 * Exakt checkpointDigest({ version: 1, input, mappings, ownExports }) utan att
 * samla hela arrayerna. Anroparen ansvarar fortfarande för fulla antal och
 * sididentiteter; denna instans bevarar bara given ordning och kanoniska bytes.
 * Varje append behåller högst aktuell sida, inte en beständig SHA-checkpoint.
 */
export class CheckpointContextDigest {
  private readonly hash: Hash
  private phase: ContextKind = 'MAPPINGS'
  private hasItems = false
  private closed = false
  private failure: { error: unknown } | null = null
  private readonly closedError = new Error('Kontextdigesten är redan avslutad')

  constructor(input: unknown) {
    const validated = CheckpointContextSchema.shape.input.parse(input)
    // Ingen canonicalCheckpointInput: kostkontonas ordning/dubbletter och
    // uttryckliga undefined-fält ska ha samma stable-representation som förut.
    const serialized = stable(validated)
    this.hash = createHash('sha256').update(`{"input":${serialized},"mappings":[`)
  }

  append(kind: ContextKind, items: unknown): void {
    this.assertOpen()
    try {
      if (kind !== 'MAPPINGS' && kind !== 'OWN_EXPORTS')
        throw new TypeError('Ogiltig kontextsamling')
      if (this.phase === 'OWN_EXPORTS' && kind === 'MAPPINGS')
        throw new Error('Kontextsamlingarna kommer i fel ordning')

      // Validera och serialisera HELA sidan innan hash/fastillstånd ändras.
      const validated =
        kind === 'MAPPINGS' ? mappingsSchema.parse(items) : exportsSchema.parse(items)
      const serialized = validated.map((item) => stable(item)).join(',')
      if (kind === 'OWN_EXPORTS' && this.phase === 'MAPPINGS') {
        this.hash.update('],"ownExports":[')
        this.phase = 'OWN_EXPORTS'
        this.hasItems = false
      }
      if (validated.length > 0) {
        if (this.hasItems) this.hash.update(',')
        this.hash.update(serialized)
        this.hasItems = true
      }
    } catch (error) {
      this.failure = { error }
      throw error
    }
  }

  digest(): string {
    this.assertOpen()
    try {
      this.hash.update(
        this.phase === 'MAPPINGS' ? '],"ownExports":[],"version":1}' : '],"version":1}',
      )
      const result = this.hash.digest('hex')
      this.closed = true
      return result
    } catch (error) {
      this.failure = { error }
      throw error
    }
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure.error
    if (this.closed) throw this.closedError
  }
}
