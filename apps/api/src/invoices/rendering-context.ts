import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
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
    !/\/Info 1 0 R\b/.test(trailer)
  )
    throw new Error('Unsupported PDF Info structure')
  const date = new Date(context.asOf).toISOString().slice(0, 19).replace(/\D/g, '')
  for (const field of ['CreationDate', 'ModDate']) {
    const matches = [...info.matchAll(new RegExp(`/${field} \\(D:[0-9]{14}\\+00'00'\\)`, 'g'))]
    if (matches.length !== 1) throw new Error(`Unsupported PDF ${field}`)
    const replacement = `/${field} (D:${date}+00'00')`
    if (replacement.length !== matches[0][0].length) throw new Error('PDF date width changed')
    bytes.write(replacement, matches[0].index, replacement.length, 'latin1')
  }
  return bytes
}

const execute = promisify(execFile)

async function command(file: string, args: string[]): Promise<string> {
  const result = await execute(file, args, { env: { ...process.env, LC_ALL: 'C' } })
  return result.stdout
}

async function installationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await installationFiles(file)))
    else files.push(file)
  }
  return files
}

/** Collects actual dependencies, never a cached substitute for their bytes.
 * The installation must remain immutable for the entire Chromium lifetime.
 */
export async function pdfEnvironmentIdentity(): Promise<string> {
  if (process.platform !== 'linux')
    throw new Error('PDF rendering requires the verified Linux environment')
  const chrome = puppeteer.executablePath()
  const fonts = (await command('/usr/bin/fc-list', ['--format', '%{file}\n'])).trim().split('\n')
  const configList = await command('/usr/bin/fc-conflist', [])
  const configs = [...configList.matchAll(/^\+ (.+?): /gm)].map((match) => match[1])
  configs.push(process.env.FONTCONFIG_FILE ?? '/etc/fonts/fonts.conf')
  const libraries: string[] = []
  for (const executable of [chrome, process.execPath, '/usr/bin/fc-list']) {
    const dependencies = await command('/usr/bin/ldd', [executable])
    for (const line of dependencies.split('\n')) {
      const match = line.match(/(?:=>\s+|^\s*)(\/\S+)\s+\(/)
      if (match) libraries.push(match[1])
      else if (line.includes('not found')) throw new Error('Missing renderer library')
    }
  }
  const files = [
    ...new Set([
      ...(await installationFiles(dirname(chrome))),
      ...fonts,
      ...configs,
      ...libraries,
      process.execPath,
      '/usr/bin/fc-list',
      '/usr/bin/fc-conflist',
      '/etc/os-release',
    ]),
  ].sort()
  const digests: Array<[string, string]> = []
  for (const file of files) digests.push([file, renderingDigest(await readFile(file))])
  return renderingDigest(
    JSON.stringify({
      revision: 'payment-rendering-2.1',
      files: digests,
      configList,
      node: process.versions,
      architecture: process.arch,
      chrome: await command(chrome, ['--version']),
      locale: Intl.DateTimeFormat().resolvedOptions(),
      fontconfig: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key.startsWith('FONTCONFIG_') || ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'].includes(key),
        ),
      ),
    }),
  )
}
