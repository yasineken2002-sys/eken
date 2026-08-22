import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { Injectable } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { aiEffectExtension } from './ai-effect-extension'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super()
    /**
     * UTFALLSKOPPLINGEN ÄR PÅKOPPLAD HÄR — på klienten, inte i något verktyg.
     *
     * `$extends` returnerar en NY klient i stället för att mutera den här, så
     * resultatet måste tilldelas tillbaka. Att bara anropa `this.$extends(...)`
     * och kasta bort returvärdet kompilerar, kör, och gör INGENTING — den
     * felskrivningen är exakt varför `ai-effect-extension.spec.ts` mäter mot en
     * riktig databas och inte mot en attrapp.
     *
     * `as this` behövs för att den utökade klientens typ är strukturellt
     * bredare; ytan vi använder är oförändrad.
     */
    return this.$extends(aiEffectExtension) as unknown as this
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
