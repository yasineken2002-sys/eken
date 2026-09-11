import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer'

export interface DocumentContext {
  asOf: string
  logo: { dataUrl: string; digest: string } | null
}

export interface PdfRenderingContext extends DocumentContext {
  environment: string
}

export function renderingDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function documentContext(asOf: Date, logo: string | null): DocumentContext {
  return {
    asOf: asOf.toISOString(),
    logo: logo === null ? null : { dataUrl: logo, digest: renderingDigest(logo) },
  }
}

export function renderingLogo(context: DocumentContext): string | null {
  if (context.logo && renderingDigest(context.logo.dataUrl) !== context.logo.digest) {
    throw new Error('Rendering resource digest mismatch')
  }
  return context.logo?.dataUrl ?? null
}

export function stampPdfDates(pdf: Buffer, context: DocumentContext): Buffer {
  const bytes = Buffer.from(pdf)
  const end = bytes.indexOf('\nendobj')
  const info = bytes.subarray(0, end).toString('latin1')
  const trailer = bytes.subarray(bytes.lastIndexOf('\ntrailer\n')).toString('latin1')
  if (
    !info.startsWith('%PDF-1.4\n') ||
    !info.includes('\n1 0 obj\n<<') ||
    info.split(/\n\d+ \d+ obj\n/).length !== 2 ||
    [...trailer.matchAll(/\/Info\b/g)].length !== 1 ||
    !/\/Info 1 0 R\b/.test(trailer)
  )
    throw new Error('Unsupported PDF Info structure')
  const date = new Date(context.asOf).toISOString().slice(0, 19).replace(/\D/g, '')
  for (const field of ['CreationDate', 'ModDate']) {
    const matches = [...info.matchAll(new RegExp(`/${field} \\(D:[0-9]{14}\\+00'00'\\)`, 'g'))]
    if (matches.length !== 1 || info.split(`/${field}`).length !== 2)
      throw new Error(`Unsupported PDF ${field}`)
    const match = matches[0]!
    const replacement = `/${field} (D:${date}+00'00')`
    if (replacement.length !== match[0].length) throw new Error('PDF date width changed')
    bytes.write(replacement, match.index!, replacement.length, 'latin1')
  }
  return bytes
}

const execute = promisify(execFile)

async function command(file: string, args: string[]): Promise<string> {
  const result = await execute(file, args, { env: { ...process.env, LC_ALL: 'C' } })
  return result.stdout
}

function installationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const file = join(directory, entry.name)
    return entry.isDirectory() ? installationFiles(file) : [file]
  })
}

// Deliberate file/package boundary, never an application import graph.
export function renderingCodeManifest(): Array<[string, string]> {
  const files = [
    './pdf.service',
    '../consumption/delivery-renderer',
    './rendering-context',
    './pdf-wait-until',
    './templates/invoice-pdf.template',
    './invoice-debt',
    '../avisering/avisering.service',
    '../avisering/rent-reminder.service',
    '../avisering/rent-debt.service',
    '../collections/collection-export.service',
    '../collections/rent-collection-export.service',
    '../common/utils/rent-notice-total.util',
    '@prisma/client',
    '../mail/mail.renderer',
    '../mail/mail.service',
    '@prisma/client/runtime/library',
  ].map((name) => require.resolve(name))
  const shared = require.resolve('@eken/shared')
  files.push(
    shared,
    process.execPath,
    join(dirname(shared), 'constants/branding.js'),
    join(dirname(shared), 'constants/index.js'),
  )
  const prisma = createRequire(require.resolve('@prisma/client'))
  files.push(prisma.resolve('.prisma/client/default'), prisma.resolve('.prisma/client/index'))
  files.push(...installationFiles(dirname(createRequire(shared).resolve('@eken/ui'))))
  files.push(...installationFiles(join(__dirname, '../mail/templates')))
  files.push(...installationFiles(join(__dirname, '../common/branding')))
  const visited = new Set<string>()
  const links: Array<[string, string]> = []
  const visit = (name: string, parent: string, optional = false): void => {
    const path = createRequire(parent)
      .resolve.paths(name)
      ?.map((root) => join(root, name, 'package.json'))
      .find(existsSync)
    links.push([`${parent}:${name}`, path ? realpathSync(path) : 'ABSENT'])
    if (!path && optional) return
    if (!path || name.startsWith('@eken/')) throw new Error(`Undeclared engine package: ${name}`)
    const manifest = realpathSync(path)
    if (visited.has(manifest)) return
    visited.add(manifest)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    files.push(...installationFiles(dirname(manifest)))
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }).sort())
      visit(
        dependency,
        manifest,
        dependency in (pkg.optionalDependencies ?? {}) ||
          pkg.peerDependenciesMeta?.[dependency]?.optional === true,
      )
  }
  for (const root of ['puppeteer', '@react-email/render', '@react-email/components'])
    visit(root, __filename)
  return links.concat(
    [...new Set(files)].sort().map((file) => [file, renderingDigest(readFileSync(file))]),
  )
}

export const renderingCodeIdentity = () =>
  renderingDigest(
    JSON.stringify([
      renderingCodeManifest(),
      process.versions,
      process.env.NODE_ENV,
      Intl.DateTimeFormat().resolvedOptions(),
    ]),
  )
export const INITIAL_RENDERING_CODE = (() => {
  try {
    return renderingCodeIdentity()
  } catch {
    return null
  }
})()

/** Collects actual dependencies, never a cached substitute for their bytes.
 * The installation must remain immutable for the entire Chromium lifetime.
 */
export async function pdfEnvironmentIdentity(): Promise<string> {
  if (process.platform !== 'linux')
    throw new Error('PDF rendering requires the verified Linux environment')
  const chrome = puppeteer.executablePath()
  const fonts = (await command('/usr/bin/fc-list', ['--format', '%{file}\n'])).trim().split('\n')
  const configList = await command('/usr/bin/fc-conflist', [])
  const configs = [...configList.matchAll(/^\+ (.+?): /gm)].map((match) => match[1]!)
  configs.push(process.env.FONTCONFIG_FILE ?? '/etc/fonts/fonts.conf')
  const libraries: string[] = []
  for (const executable of [chrome, process.execPath, '/usr/bin/fc-list']) {
    const dependencies = await command('/usr/bin/ldd', [executable])
    for (const line of dependencies.split('\n')) {
      const match = line.match(/(?:=>\s+|^\s*)(\/\S+)\s+\(/)
      if (match) libraries.push(match[1]!)
      else if (line.includes('not found')) throw new Error('Missing renderer library')
    }
  }
  const files = [
    ...new Set([
      ...installationFiles(dirname(chrome)),
      ...fonts,
      ...configs,
      ...libraries,
      '/usr/bin/fc-list',
      '/usr/bin/fc-conflist',
      '/etc/os-release',
    ]),
  ].sort()
  return renderingDigest(
    JSON.stringify({
      files: files.map((file) => [file, renderingDigest(readFileSync(file))]),
      configList,
      fontconfig: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key.startsWith('FONTCONFIG_') || ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'].includes(key),
        ),
      ),
    }),
  )
}
