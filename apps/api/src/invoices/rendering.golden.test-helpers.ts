import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REQUIRED_RENDERING_CASES = [
  'invoice-customer-classic',
  'invoice-rent-classic',
  'invoice-utility-classic',
  'invoice-customer-modern',
  'invoice-customer-minimal',
  'invoice-customer-multipage',
  'notice-rent',
  'notice-prorated-backfill',
  'notice-deposit',
  'notice-utility-credit',
  'reminder-rent-partpaid',
  'reminder-utility-partpaid-credit',
  'collection-invoice-clean',
  'collection-invoice-utility',
  'collection-notice-clean',
  'collection-notice-utility-credit',
  'mail-invoice',
  'mail-overdue',
  'mail-friendly',
  'mail-formal',
  'mail-notice',
  'mail-notice-reminder',
] as const
export type Artifact = { file: string; sha256: string; bytes: number }
export type CaptureRecord = {
  id: string
  hasConsumption?: boolean
  input?: Artifact
  pdf?: Artifact
  html?: Artifact
  text?: Artifact
  envelope?: Artifact
}
export type CaptureManifest = {
  baseSha: string
  sourceHead: string
  pid: number
  chromiumPid: number
  fixtureSha256: string
  renderingCodeIdentity?: string
  environment: Record<string, unknown>
  records: CaptureRecord[]
}
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const readArtifact = (directory: string, artifact: Artifact) => {
  const bytes = readFileSync(join(directory, artifact.file))
  assert.equal(bytes.length, artifact.bytes, artifact.file + ': length')
  assert.equal(hash(bytes), artifact.sha256, artifact.file + ': raw hash')
  return bytes
}
export function loadCapture(directory: string): CaptureManifest {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8'),
  ) as CaptureManifest
  assert.deepEqual(
    manifest.records.map((record) => record.id),
    [...REQUIRED_RENDERING_CASES],
  )
  assert.equal(manifest.records.filter((record) => record.pdf).length, 16)
  assert.equal(manifest.records.filter((record) => record.hasConsumption === false).length, 11)
  for (const record of manifest.records) {
    for (const key of ['input', 'pdf', 'html', 'text', 'envelope'] as const) {
      const artifact = record[key]
      if (artifact) readArtifact(directory, artifact)
    }
  }
  return manifest
}

// Independent golden rule: only these two fourteen-digit fields, no PDF rewrite/parser library.
export function comparablePdf(bytes: Buffer) {
  const infoEnd = bytes.indexOf('\nendobj')
  assert.ok(infoEnd > 0, 'Missing first Info object terminator')
  const info = bytes.subarray(0, infoEnd).toString('latin1')
  const trailerAt = bytes.lastIndexOf('\ntrailer\n')
  assert.ok(trailerAt > infoEnd, 'Missing trailer')
  const trailer = bytes.subarray(trailerAt).toString('latin1')
  assert.ok(info.startsWith('%PDF-1.4\n') && info.includes('\n1 0 obj\n<<'))
  assert.equal([...trailer.matchAll(/\/Info\b/g)].length, 1)
  assert.match(trailer, /\/Info 1 0 R\b/)
  const comparable = Buffer.from(bytes)
  const fields = ['CreationDate', 'ModDate'].map((name) => {
    assert.equal(info.split('/' + name).length, 2, 'Exactly one ' + name + ' key')
    const matches = [...info.matchAll(new RegExp(`/${name} \\(D:([0-9]{14})\\+00'00'\\)`, 'g'))]
    assert.equal(matches.length, 1, 'Exact date syntax for ' + name)
    const match = matches[0]!
    const offset = match.index! + name.length + 5
    assert.equal(bytes.subarray(offset, offset + 14).toString(), match[1])
    comparable.fill(0x30, offset, offset + 14)
    return { name, offset, length: 14, value: match[1]! }
  })
  return { comparable, fields }
}
export function assertPdfGolden(before: Buffer, after: Buffer) {
  const a = comparablePdf(before),
    b = comparablePdf(after)
  assert.deepEqual(
    a.fields.map(({ value: _value, ...field }) => field),
    b.fields.map(({ value: _value, ...field }) => field),
    'Info offsets cannot drift',
  )
  assert.ok(b.comparable.equals(a.comparable), 'Undeclared PDF byte difference')
}
export function comparableEnvelope(bytes: Buffer): Buffer {
  const envelope = JSON.parse(bytes.toString()) as { attachments?: Array<{ content: string }> }
  let result = bytes.toString()
  for (const attachment of envelope.attachments ?? []) {
    assert.equal(
      Buffer.from(attachment.content, 'base64').toString('base64'),
      attachment.content,
      'Canonical attachment base64',
    )
    const original = JSON.stringify(attachment.content)
    assert.equal(result.split(original).length, 2, 'Unique raw attachment value')
    const pdf = comparablePdf(Buffer.from(attachment.content, 'base64'))
    result = result.replace(original, JSON.stringify(pdf.comparable.toString('base64')))
  }
  return Buffer.from(result)
}
export function assertGoldenPair(before: string, after: string) {
  const left = loadCapture(before),
    right = loadCapture(after)
  const comparisons: Array<Record<string, unknown>> = []
  for (const [index, record] of left.records.entries()) {
    const target = right.records[index]!
    for (const key of ['input', 'pdf', 'html', 'text', 'envelope'] as const) {
      const a = record[key],
        b = target[key]
      assert.equal(Boolean(a), Boolean(b), record.id + ':' + key)
      if (!a || !b) continue
      const first = readArtifact(before, a),
        second = readArtifact(after, b)
      if (key === 'pdf') assertPdfGolden(first, second)
      else if (key === 'envelope')
        assert.deepEqual(comparableEnvelope(first), comparableEnvelope(second))
      else assert.deepEqual(first, second, record.id + ':' + key)
      comparisons.push({
        id: record.id,
        kind: key,
        rawEqual: first.equals(second),
        before: hash(first),
        after: hash(second),
        exception:
          key === 'pdf'
            ? comparablePdf(first).fields
            : key === 'envelope'
              ? 'two Info dates in PDF attachment only'
              : null,
      })
    }
  }
  return comparisons
}
