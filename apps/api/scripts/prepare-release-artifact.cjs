// Framtida builder-steg EFTER API-build. Är inte inkopplat i Dockerfile.
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { artifact, buildSources } = require('./release-gate.cjs')
const root = resolve(__dirname, '../../..')
const revision = process.env.RAILWAY_GIT_COMMIT_SHA
// SHA kommer från den betrodda byggmiljön. Samtliga valda byggkällor verifieras
// senare mot GitHub; kompilatorns korrekthet/imagen är fortfarande en tillitsgräns.
// Framtida Docker-context måste uttryckligen inkludera .github/workflows/ci.yml.
const manifest = artifact(
  join(root, 'apps/api'),
  revision,
  readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
  buildSources(root),
)
writeFileSync(join(root, 'apps/api/release-artifact.json'), JSON.stringify(manifest))
