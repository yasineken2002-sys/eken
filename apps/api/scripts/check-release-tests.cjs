// CI kräver faktiskt körda beteendeprov; en grön eller hoppad tom svit räcker inte.
const { readFileSync } = require('node:fs')
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const required = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
]
if (!Array.isArray(report.testResults)) throw new Error('Jest report missing suites')
for (const id of required) {
  const suites = report.testResults.filter((suite) =>
    suite.name.endsWith('/release/api-release-gate.spec.ts'),
  )
  const tests = suites
    .flatMap((suite) => suite.assertionResults ?? [])
    .filter((test) => test.title.startsWith(`api-release-${id} `))
  if (
    suites.length !== 1 ||
    suites[0].status !== 'passed' ||
    tests.length !== 1 ||
    tests[0].status !== 'passed' ||
    !(tests[0].numPassingAsserts > 0)
  )
    throw new Error(`Required executed test api-release-${id} missing or failed`)
}
process.stdout.write(
  `API-release: ${required.length} required tests executed with positive assertions.\n`,
)
