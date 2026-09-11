// Mäter faktiskt godkända assertions. Semantiken ägs av fryst facit
// och beteendenegativkontrollen; funnen fil eller testnamn räcker inte.
const report = require('./apps/api/jest-report.json')
const required = [
  ['consumption/delivery-decisions.db.spec.ts', [
    '2a-01', '2a-02', '2a-03', '2a-04', '2a-05', '2a-06',
    '2a-07', '2a-08', '2a-09', '2a-10', '2a-11', '2a-12',
    '2a-13', '2a-14', '2a-15', '2a-16', '2a-17',
  ]],
  ['consumption/delivery-execution.db.spec.ts', [
    '2b-01', '2b-02', '2b-03', '2b-04', '2b-05', '2b-06',
    '2b-07', '2b-08', '2b-09', '2b-10', '2b-11', '2b-12',
    '2b-13', '2b-14', '2b-15', '2b-16', '2b-17', '2b-18',
    '2b-19', '2b-20', '2b-21', '2b-22', '2b-23', '2b-24',
    '2b-25', '2b-26', '2b-27', '2b-28', '2b-29', '2b-30',
    'r21-17', 'r21-18', 'r21-19', 'r21-20', 'r21-21',
  ]],
  ['invoices/rendering.real.spec.ts', [
    'r21-01', 'r21-02', 'r21-03', 'r21-04', 'r21-05', 'r21-06',
    'r21-07', 'r21-08', 'r21-09', 'r21-10', 'r21-11', 'r21-12',
    'r21-13', 'r21-14', 'r21-15', 'r21-16', 'r21-22', 'r21-23',
  ]],
]
for (const [file, ids] of required) {
  const suites = report.testResults.filter(s => s.name.endsWith('/' + file))
  if (suites.length !== 1 || suites[0].status !== 'passed') {
    throw new Error(file + ': saknad, dubbel eller underkänd svit; kräver ' + ids.join(', '))
  }
  const assertions = suites[0].assertionResults
  for (const id of ids) {
    const matches = assertions.filter(t => t.title.startsWith(id + ' '))
    if (matches.length !== 1 || matches[0].status !== 'passed' ||
        !(matches[0].numPassingAsserts > 0)) {
      throw new Error(file + ': ' + id + ' saknas eller saknar godkända genomförda assertions')
    }
  }
  if (assertions.some(t => t.status !== 'passed')) throw new Error(file + ': underkänt extra prov')
  console.warn(file + ': genomförda assertions verifierade för ' + ids.join(', '))
}
