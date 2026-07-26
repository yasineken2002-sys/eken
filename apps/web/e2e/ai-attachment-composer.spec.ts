import { test, expect } from '@playwright/test'
import { deflateSync } from 'node:zlib'

/**
 * Spår B4 — bilage-UI i AI-kompositören.
 *
 * Beviset gäller det som INTE går att se i en enhetstest: att brickan speglar
 * serverns svar, att en avvisad fil blockerar sändning i stället för att tyst
 * försvinna, och att alla tre vägarna in (filväljare, inklistring, släpp)
 * hamnar i samma bricka.
 *
 * KRÄVER INGEN AI-NYCKEL: testet skickar aldrig ett meddelande. Det stannar vid
 * kompositörens tillstånd, vilket är precis vad B4 äger — sändningen är B2:s och
 * verifierad där. Uppladdningen går mot det riktiga API:t och kräver därför att
 * R2/S3 är konfigurerat; utan det hoppas testet över sig självt hellre än att
 * fälla bygget på en miljöfråga.
 */

const API = 'http://localhost:3000/v1'

/** En riktig PDF med känt sidantal (okomprimerat sidträd). */
function pdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj`,
    ...Array.from({ length: pages }, (_, i) => `${3 + i} 0 obj<</Type/Page>>endobj`),
  ]
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer<</Root 1 0 R>>\n`, 'latin1')
}

/** Minimal giltig PNG (1×1, deflate-komprimerad scanline). */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.alloc(4), Buffer.from(type, 'latin1'), data])
    head.writeUInt32BE(data.length, 0)
    const crcTable: number[] = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const b of Buffer.concat([Buffer.from(type, 'latin1'), data])) {
      crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8)
    }
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
    return Buffer.concat([head, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('AI-kompositören: bilagor via filväljare, inklistring och släpp', async ({
  page,
  request,
}) => {
  const stamp = Date.now()
  const email = `e2e.attach+${stamp}@eveno.test`
  const password = 'TestE2e123!'

  const reg = await request.post(`${API}/auth/register`, {
    data: {
      email,
      password,
      firstName: 'E2E',
      lastName: 'Attach',
      organizationName: `E2E Attach ${stamp}`,
      acceptTerms: true,
    },
  })
  expect(reg.ok()).toBeTruthy()
  const login = await request.post(`${API}/auth/login`, { data: { email, password } })
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken

  // Fungerar lagringen alls i den här miljön? Utan R2/S3-konfiguration är
  // uppladdningen omöjlig, och det är en miljöfråga — inte en regression.
  const probe = await request.post(`${API}/ai/attachments`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'probe.pdf', mimeType: 'application/pdf', buffer: pdf(1) },
    },
  })
  test.skip(
    probe.status() === 500,
    'Fillagring (R2/S3) är inte konfigurerad i denna miljö — bilagor kan inte laddas upp',
  )
  expect(probe.ok()).toBeTruthy()

  // ── Logga in i webbläsaren ─────────────────────────────────────────────────
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((u) => !u.pathname.includes('login'))
  await page.goto('/ai')
  await expect(page.locator('textarea')).toBeVisible()

  // ── 1. Filväljaren: sidantalet på kortet kommer från SERVERNS räkning ─────
  await page.setInputFiles('input[type=file]', {
    name: 'kontrakt.pdf',
    mimeType: 'application/pdf',
    buffer: pdf(4),
  })
  const pdfCard = page.locator('div', {
    has: page.getByRole('button', { name: /Ta bort kontrakt/ }),
  })
  await expect(pdfCard.first()).toContainText('kontrakt.pdf')
  // "4 sidor" kan bara komma från backendens countPdfPages — frontend räknar inte.
  await expect(pdfCard.first()).toContainText('4 sidor')
  await expect(page.locator('button[title="Skicka"]')).toBeDisabled() // ingen text ännu

  // ── 2. Avvisad filtyp: felkort + sändning blockerad med SYNLIGT skäl ─────
  await page.setInputFiles('input[type=file]', {
    name: 'anteckning.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('inte tillåtet'),
  })
  await page.locator('textarea').fill('Läs filerna')
  const blockedSend = page.locator(
    'button[title="Ta bort bilagan som inte kunde laddas upp först"]',
  )
  await expect(blockedSend).toBeVisible()
  await expect(blockedSend).toBeDisabled()
  // Skälet ska stå UTSKRIVET, inte trunkerat till oläslighet.
  await expect(
    page.getByText('Bara PDF, JPG, PNG och WEBP kan skickas till assistenten'),
  ).toBeVisible()

  // Ta bort felkortet → sändning fri igen.
  await page.getByRole('button', { name: /Ta bort anteckning/ }).click()
  await expect(page.locator('button[title="Skicka"]')).toBeEnabled()

  // ── 3. Inklistring: en bild blir en bilaga med miniatyr ───────────────────
  await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'skarmdump.png', { type: 'image/png' }))
    const ta = document.querySelector('textarea')!
    ta.focus()
    ta.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, png().toString('base64'))

  const imgCard = page.locator('div', {
    has: page.getByRole('button', { name: /Ta bort skarmdump/ }),
  })
  await expect(imgCard.first()).toContainText('skarmdump.png')
  await expect(imgCard.first().locator('img')).toBeVisible()

  // Inklistrad TEXT ska hamna i textarean — inte bli en bilaga.
  const cardsBefore = await page.getByRole('button', { name: /^Ta bort/ }).count()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', ' och sammanfatta')
    const ta = document.querySelector('textarea')!
    ta.focus()
    ta.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })
  expect(await page.getByRole('button', { name: /^Ta bort/ }).count()).toBe(cardsBefore)

  // ── 4. Dra-och-släpp: markering under draget, bilaga efter släppet ────────
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1])], 'dummy.pdf', { type: 'application/pdf' }))
    document
      .querySelector('textarea')!
      .parentElement!.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
  })
  await expect(page.locator('textarea')).toHaveAttribute('placeholder', 'Släpp filen här…')

  await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'slappt.pdf', { type: 'application/pdf' }))
    document
      .querySelector('textarea')!
      .parentElement!.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
  }, pdf(2).toString('base64'))

  await expect(
    page.locator('div', { has: page.getByRole('button', { name: /Ta bort slappt/ }) }).first(),
  ).toContainText('2 sidor')
  // Släppmarkeringen ska släppa taget efter droppet.
  await expect(page.locator('textarea')).not.toHaveAttribute('placeholder', 'Släpp filen här…')

  // ── 5. Borttagning tar bort bilagan på SERVERN också ─────────────────────
  const deleteCalls: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/ai/attachments/')) deleteCalls.push(r.url())
  })
  await page.getByRole('button', { name: /Ta bort slappt/ }).click()
  await expect
    .poll(() => deleteCalls.length, { message: 'DELETE mot /ai/attachments förväntades' })
    .toBeGreaterThan(0)

  // ── 6. Taket på fem bilagor ──────────────────────────────────────────────
  await page.setInputFiles(
    'input[type=file]',
    Array.from({ length: 6 }, (_, i) => ({
      name: `extra${i}.pdf`,
      mimeType: 'application/pdf',
      buffer: pdf(1),
    })),
  )
  await expect.poll(() => page.getByRole('button', { name: /^Ta bort/ }).count()).toBe(5)
})
