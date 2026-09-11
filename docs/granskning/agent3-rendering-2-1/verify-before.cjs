/* Read-only verification of independent raw baseline artifacts. Not renderer acceptance tests. */
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const root = __dirname
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = (series, file) => readFileSync(join(root, series, file))
const manifest = series => JSON.parse(read(series, 'manifest.json'))
let verifiedArtifacts = 0
for (const series of ['before-1', 'before-2', 'before-controlled-1', 'before-controlled-2', 'before-final-1', 'before-final-2']) {
  const info = manifest(series)
  assert.equal(info.sourceHead, '5ae9906b152307eae0d79eec719d4303a042742c')
  assert.equal(info.fixtureSourceSha256, hash(readFileSync(join(root, 'fixture-source-before.ts.txt'))))
  for (const record of info.records) {
    for (const value of Object.values(record)) {
      if (!value || typeof value !== 'object' || !value.file) continue
      const bytes = read(series, value.file)
      assert.equal(hash(bytes), value.sha256, series + '/' + value.file)
      assert.equal(bytes.length, value.bytes)
      verifiedArtifacts++
    }
  }
}
function pdfDatesOnly(bytes) {
  const infoEnd = bytes.indexOf('\nendobj')
  const info = bytes.subarray(0, infoEnd).toString('latin1')
  const trailer = bytes.subarray(bytes.lastIndexOf('\ntrailer\n')).toString('latin1')
  assert.ok(infoEnd > 0 && info.includes('\n1 0 obj\n<<'))
  assert.match(trailer, /\/Info 1 0 R\b/)
  const comparable = Buffer.from(bytes)
  const fields = []
  for (const name of ['CreationDate', 'ModDate']) {
    const matches = [...info.matchAll(new RegExp(`/${name} \\(D:([0-9]{14})\\+00'00'\\)`, 'g'))]
    assert.equal(matches.length, 1)
    const offset = matches[0].index + name.length + 5
    assert.equal(bytes.subarray(offset, offset + 14).toString(), matches[0][1])
    comparable.fill(0x30, offset, offset + 14)
    fields.push({ name, offset, length: 14, original: matches[0][1] })
  }
  return { comparable, fields }
}
const comparisons = []
for (const [left, right] of [['before-1', 'before-2'], ['before-controlled-1', 'before-controlled-2'], ['before-1', 'before-controlled-1'], ['before-final-1', 'before-final-2']]) {
  for (const record of manifest(left).records) {
    for (const [kind, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object' || !value.file) continue
      const first = read(left, value.file)
      const second = read(right, value.file)
      let exception = null
      if (kind === 'pdf') {
        const a = pdfDatesOnly(first), b = pdfDatesOnly(second)
        assert.deepEqual(a.comparable, b.comparable, record.id)
        exception = a.fields
      } else if (kind === 'envelope') {
        const a = JSON.parse(first), b = JSON.parse(second)
        for (let i = 0; i < (a.attachments ?? []).length; i++) {
          const pa = pdfDatesOnly(Buffer.from(a.attachments[i].content, 'base64'))
          const pb = pdfDatesOnly(Buffer.from(b.attachments[i].content, 'base64'))
          assert.deepEqual(pa.comparable, pb.comparable)
          a.attachments[i].content = pa.comparable.toString('base64')
          b.attachments[i].content = pb.comparable.toString('base64')
        }
        assert.deepEqual(a, b)
        exception = a.attachments?.length ? 'Only the two date fields in decoded PDF attachments' : null
      } else assert.deepEqual(first, second, record.id + ':' + kind)
      comparisons.push({ left, right, file: value.file, rawEqual: first.equals(second),
        firstSha256: hash(first), secondSha256: hash(second), exception })
    }
  }
}
const final = manifest('before-final-1')
assert.equal(final.captureSourceSha256, hash(readFileSync(join(root, 'capture-before.cjs'))))
const result = { verifiedArtifacts, rawComparisons: comparisons.length, comparisons }
writeFileSync(join(root, 'verified-before-comparisons.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ verifiedArtifacts, rawComparisons: comparisons.length, outcome: 'passed; baseline only' }))
