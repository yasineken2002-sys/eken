// Regenererar src/css/tokens.css ur den kompilerade sanningen (dist/cjs/tokens.js).
// Körs via `pnpm --filter @eken/ui gen:tokens` (som bygger först). tokens.css är
// en GENERERAD artefakt och committas — redigera aldrig den för hand.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderTokensCss } = require(join(here, '..', 'dist', 'cjs', 'tokens.js'))

const outPath = join(here, '..', 'src', 'css', 'tokens.css')
writeFileSync(outPath, renderTokensCss(), 'utf8')
console.warn('[gen:tokens] skrev', outPath)
