// AUTO-GENERERAD — REDIGERA INTE FÖR HAND.
// Aggregat av alla genererade lagtext-moduler.
// Kör om: pnpm --filter @eken/api knowledge:generate
import type { LegalKnowledgeDocument } from '../legal-knowledge.types'
import { bokforingslagen } from './bokforingslagen.generated'
import { bostadsrattslagen } from './bostadsrattslagen.generated'
import { diskrimineringslagen } from './diskrimineringslagen.generated'
import { hyreslagen } from './hyreslagen.generated'
import { mervardesskattelagen } from './mervardesskattelagen.generated'
import { ranteslagen } from './ranteslagen.generated'

export const GENERATED_LEGAL_DOCUMENTS: LegalKnowledgeDocument[] = [
  bokforingslagen,
  bostadsrattslagen,
  diskrimineringslagen,
  hyreslagen,
  mervardesskattelagen,
  ranteslagen,
]
