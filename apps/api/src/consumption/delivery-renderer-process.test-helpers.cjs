// Fresh Node/Chromium, no cache from the sealing process. Input contains only saved data.
const { readFileSync } = require('node:fs')
const { PrismaClient } = require('@prisma/client')
const { PdfService } = require('../invoices/pdf.service')
const { MailRenderer } = require('../mail/mail.renderer')
const { DeliveryRenderer } = require('./delivery-renderer')
const { DeliveryExecution } = require('./delivery-execution')
const input = JSON.parse(readFileSync(0, 'utf8'))
const unavailable = new Proxy(
  {},
  {
    get() {
      throw new Error('CURRENT_DATA_FORBIDDEN')
    },
  },
)
async function main() {
  if (input.replay || input.blocked) {
    const db = new PrismaClient()
    try {
      const execution = new DeliveryExecution(db, input.identity, unavailable)
      const result = input.blocked
        ? { run: await execution.run(input.decisionId) }
        : { dispatch: await execution.enqueue(input.command) }
      process.stdout.write('\nR22_RESULT=' + JSON.stringify({ pid: process.pid, ...result }) + '\n')
    } finally {
      await db.$disconnect()
    }
    return
  }
  const pdf = new PdfService(unavailable, unavailable)
  const renderer = new DeliveryRenderer(pdf, new MailRenderer())
  try {
    const bodies = []
    for (const saved of input.saved)
      bodies.push(await renderer.reproduce(saved.snapshot, saved.command, saved.sealed))
    const chromiumPid = pdf.controlled.browser.process().pid
    process.stdout.write(
      '\nR22_RESULT=' + JSON.stringify({ pid: process.pid, chromiumPid, bodies }) + '\n',
    )
  } finally {
    await pdf.onModuleDestroy()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
