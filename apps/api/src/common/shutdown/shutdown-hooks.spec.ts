import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Injectable, Module } from '@nestjs/common'
import type { OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'

/**
 * MEKANIKEN bakom `app.enableShutdownHooks()` i main.ts.
 *
 * ── VAD DEN HÄR SPECEN ÄR, OCH VAD DEN INTE ÄR ──────────────────────────────
 *
 * Den bevisar att hooken GÖR något: att den ger processen en SIGTERM-lyssnare
 * och att nedstängningen faktiskt kör providers destroy-hookar. Den bevisar
 * INTE att main.ts anropar den — en spec som prövar mekanismen i stället för
 * ingångspunkten är precis den defekt som mättes upp tidigare i kodbasen (åtta
 * gröna tester överlevde att grinden kopplades bort).
 *
 * Påkopplingen ägs därför av apps/api/scripts/check-graceful-shutdown.mjs, som
 * kräver att raden står i main.ts och FÖRE app.listen. De två hör ihop:
 *
 *   spec utan vakt  → mekaniken fungerar, ingen använder den
 *   vakt utan spec  → raden står där, ingen vet att den gör något
 *
 * ── KANARIEFÅGELN ───────────────────────────────────────────────────────────
 *
 * Nollan är mätt, inte antagen. En kontroll som bara kräver ">= 1 lyssnare"
 * kan vara grön för att någon annan i processen råkar lyssna på SIGTERM. Testet
 * mäter därför DELTAT mot en app utan hooken, och kräver att en app UTAN hooken
 * ger noll nya lyssnare. Uppmätt på den riktiga appen i dev-läge:
 *
 *     utan hook   0 lyssnare   SIGTERM → exit      26 ms
 *     med  hook   1 lyssnare   SIGTERM → exit   2 564 ms
 *
 * ── VARFÖR INGEN RIKTIG SIGNAL SKICKAS ──────────────────────────────────────
 *
 * Nests signalhanterare avslutar med `process.kill(process.pid, signal)` när
 * nedstängningen är klar. Ett `process.emit('SIGTERM')` här hade alltså dödat
 * jest-workern mitt i sviten. Vi mäter lyssnaren och kör nedstängningen via
 * `app.close()`, vilket är samma väg utan självmordet på slutet.
 */

const spårFrånNedstängning: string[] = []

@Injectable()
class SpårandeProvider implements OnModuleDestroy, OnApplicationShutdown {
  onModuleDestroy(): void {
    spårFrånNedstängning.push('onModuleDestroy')
  }

  onApplicationShutdown(signal?: string): void {
    spårFrånNedstängning.push(`onApplicationShutdown:${signal ?? '<ingen signal>'}`)
  }
}

@Module({ providers: [SpårandeProvider] })
class MinimalModul {}

async function skapaKontext(medHook: boolean): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(MinimalModul, { logger: false })
  if (medHook) app.enableShutdownHooks()
  return app
}

describe('graceful shutdown — mekaniken bakom enableShutdownHooks()', () => {
  beforeEach(() => {
    spårFrånNedstängning.length = 0
  })

  it('en app UTAN enableShutdownHooks lägger till NOLL SIGTERM-lyssnare', async () => {
    const före = process.listenerCount('SIGTERM')
    const app = await skapaKontext(false)
    try {
      expect(process.listenerCount('SIGTERM') - före).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('enableShutdownHooks() ger processen minst en SIGTERM-lyssnare', async () => {
    const före = process.listenerCount('SIGTERM')
    const app = await skapaKontext(true)
    try {
      // Det som gör kontrollen skarp är deltat, inte det absoluta talet: en
      // annan lyssnare i processen får inte kunna göra testet grönt åt oss.
      expect(process.listenerCount('SIGTERM') - före).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  it('lyssnaren tas bort igen när appen stängs — inget läckage mellan tester', async () => {
    const före = process.listenerCount('SIGTERM')
    const app = await skapaKontext(true)
    await app.close()
    expect(process.listenerCount('SIGTERM')).toBe(före)
  })

  it('nedstängningen kör providers destroy- OCH shutdown-hookar', async () => {
    const app = await skapaKontext(true)
    await app.close()
    // Ordningen är Nests: destroy före shutdown. PdfService (Chromium),
    // PrismaService ($disconnect) och RedisService (quit) hänger på den första;
    // @nestjs/bull:s köstängning på den andra.
    // `app.close()` utan signal ger signal=undefined. Vid en riktig SIGTERM
    // står signalnamnet där i stället — det är samma väg, samma hookar.
    expect(spårFrånNedstängning).toEqual([
      'onModuleDestroy',
      'onApplicationShutdown:<ingen signal>',
    ])
  })
})

describe('graceful shutdown — beroendets kontrakt', () => {
  /**
   * Hela nyttan för köerna vilar på att @nestjs/bull sätter
   * `queue.onApplicationShutdown = function () { return this.close() }` på varje
   * kö den bygger. Vi skriver ingen egen köstängning; vi litar på den raden.
   *
   * Ett mekanikpåstående som ingen mäter slutar tyst att gälla. Försvinner
   * raden vid en uppgradering blir enableShutdownHooks() plötsligt bara
   * Prisma/Redis/Chromium, och köerna fortsätter hämta jobb till SIGKILL utan
   * att något blir rött. Därför prövas den.
   */
  it('@nestjs/bull kopplar fortfarande köns stängning till onApplicationShutdown', () => {
    const providers = join(dirname(require.resolve('@nestjs/bull')), 'bull.providers.js')
    const källa = readFileSync(providers, 'utf8')
    expect(källa).toMatch(/queue\.onApplicationShutdown\s*=/)
    expect(källa).toMatch(/return this\.close\(\)/)
  })
})
