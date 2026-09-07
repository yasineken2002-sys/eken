import * as crypto from 'node:crypto'
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ContractorWorkOrder } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { SendWorkOrderDto, WorkOrderResponseDto } from './dto/work-order.dto'

/** Svarslänkens livslängd. Se docblocket om varför båda spärrarna behövs. */
export const WORK_ORDER_TTL_MS = 14 * 24 * 60 * 60 * 1000

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * ARBETSORDER — det utåtriktade steget i etapp 10.
 *
 * ── VAD SOM SKILJER DEN FRÅN TILLDELNING ────────────────────────────────────
 *
 * Tilldelning (`assignedContractorId`) är en anteckning: den går att ändra hur
 * många gånger som helst utan att någon utanför systemet märker något. En
 * arbetsorder är ett mejl som lämnat huset. Därför är `contractorId` ett
 * uttryckligt fält i kroppen och härleds INTE ur tilldelningen — mottagaren är
 * det enda i hela flödet som inte går att ta tillbaka, och den ska väljas nu,
 * inte ärvas från ett tidigare klick.
 *
 * ── SVARSLÄNKEN: TRE SPÄRRAR, OCH VARFÖR ALLA TRE ───────────────────────────
 *
 *   HASHAD    `responseTokenHash` = sha256(token). Råvärdet lagras aldrig, så
 *             en databasdump ger inga användbara länkar. Samma form som
 *             aktiverings- och återställningstoken i TenantAuthService.
 *   ENGÅNGS   `respondedAt` sätts vid första svaret; nästa försök avvisas.
 *   KORTLIVAD `expiresAt`.
 *
 * De två sista är INTE utbytbara. En engångslänk utan livslängd är giltig för
 * alltid tills någon råkar klicka — och ett mejl ligger kvar i en inkorg i
 * åratal. En kortlivad länk utan engångsspärr kan spelas om av var och en som
 * ser mejlet, inklusive en vidarebefordran.
 *
 * Länken bär INGEN behörighet utöver att svara på just den här ordern: den
 * loggar inte in någon, den kan inte läsa ärendet, och den kan inte nå någon
 * annan order. Uppslaget sker på hashen, aldrig på ett id ur sökvägen.
 *
 * ── VAD TJÄNSTEN INTE GÖR ───────────────────────────────────────────────────
 *
 * Den bekräftar ingenting. Bekräftelsen före skick ägs av webben (knappen och
 * dess dialog) — se `HUMAN_PATHS`. Ett verktyg som anropar den här metoden
 * utan människa är spärrat av `agentAllowlist: false`, inte av en kontroll här.
 */
@Injectable()
export class WorkOrderService {
  private readonly logger = new Logger(WorkOrderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private svarsUrl(token: string): string {
    const bas = this.config.get<string>('APP_URL') ?? 'http://localhost:5173'
    return `${bas}/arbetsorder/${token}`
  }

  async send(
    ticketId: string,
    dto: SendWorkOrderDto,
    organizationId: string,
    userId: string,
  ): Promise<ContractorWorkOrder> {
    const ticket = await this.prisma.maintenanceTicket.findFirst({
      where: { id: ticketId, organizationId },
      include: {
        property: { select: { name: true, street: true, city: true, postalCode: true } },
        unit: { select: { name: true, unitNumber: true } },
        tenant: { select: { type: true, phone: true, email: true } },
        organization: { select: { name: true } },
      },
    })
    if (!ticket) throw new NotFoundException('Underhållsärende hittades inte')

    const contractor = await this.prisma.contractor.findFirst({
      where: { id: dto.contractorId, organizationId },
    })
    if (!contractor) throw new NotFoundException('Hantverkaren hittades inte')
    if (!contractor.isActive) {
      throw new BadRequestException('Hantverkaren är inaktiverad och kan inte bokas')
    }
    // UTAN E-POST GÅR INGEN ORDER ATT SKICKA. Felet sägs här, med namnet på det
    // som saknas — inte som ett tomt `to` som faller nere i mejlkön där ingen
    // ser det.
    if (!contractor.email) {
      throw new BadRequestException(
        `${contractor.name} saknar e-postadress. Lägg till en under Hantverkare innan du bokar.`,
      )
    }

    // EN ÖPPEN ORDER I TAGET per (ärende, hantverkare). Ett dubbelklick ska inte
    // ge två mejl, och två öppna svarslänkar till samma jobb hade dessutom gjort
    // "vad svarade hen" tvetydigt. En order som besvarats eller avbokats
    // blockerar inte en ny — då är det en ny fråga.
    const oppen = await this.prisma.contractorWorkOrder.findFirst({
      where: { ticketId, contractorId: contractor.id, status: 'SENT' },
    })
    if (oppen) {
      throw new BadRequestException(
        `En arbetsorder till ${contractor.name} är redan skickad och obesvarad.`,
      )
    }

    const delaKontakt = dto.delaHyresgastKontakt === true
    // VAD SOM DELAS SPARAS, så frågan "vad lämnades ut, till vem, när" går att
    // besvara i efterhand. NULL betyder att ingenting delades.
    const hyresgastKontakt =
      delaKontakt && ticket.tenant ? (ticket.tenant.phone ?? ticket.tenant.email ?? null) : null

    const token = crypto.randomBytes(32).toString('hex')
    const adress = [ticket.property.street, `${ticket.property.postalCode} ${ticket.property.city}`]
      .filter(Boolean)
      .join(', ')
    const enhet = ticket.unit ? `${ticket.unit.name} (${ticket.unit.unitNumber})` : null

    const subject = `Arbetsorder ${ticket.ticketNumber}: ${ticket.title}`
    const bodyText = [
      `Ärende ${ticket.ticketNumber}`,
      ticket.title,
      '',
      ticket.description,
      '',
      `Adress: ${adress}`,
      ...(enhet ? [`Enhet: ${enhet}`] : []),
      ...(hyresgastKontakt ? [`Hyresgästens kontakt: ${hyresgastKontakt}`] : []),
      ...(dto.meddelande ? ['', dto.meddelande] : []),
    ].join('\n')

    const order = await this.prisma.contractorWorkOrder.create({
      data: {
        organizationId,
        ticketId,
        contractorId: contractor.id,
        subject,
        bodyText,
        sentToEmail: contractor.email,
        ...(hyresgastKontakt ? { sharedTenantContact: hyresgastKontakt } : {}),
        responseTokenHash: sha256(token),
        expiresAt: new Date(Date.now() + WORK_ORDER_TTL_MS),
        sentByUserId: userId,
      },
    })

    // ── UTLÄMNANDET SYNS FÖR HYRESGÄSTEN, I EFTERHAND ────────────────────
    //
    // Hyresjuristens bedömning (etapp 10 PR 2): rättslig grund för att dela
    // kontaktuppgiften är AVTALETS FULLGÖRANDE, inte samtycke — hyresvärden har
    // en avhjälpandeskyldighet och hyresgästen en skyldighet att bereda
    // tillträde. Ett samtyckesfält hade dessutom varit sämre: ett samtycke som
    // återkallas mitt i ett ärende tar bort grunden medan skyldigheten står
    // kvar.
    //
    // Men transparensen kvarstår, och "ärendet är tilldelat" säger INGENTING om
    // att en kontaktuppgift lämnats ut — det är två olika fakta. Raden skrivs
    // därför som en ICKE-INTERN kommentar, alltså på en yta hyresgästen redan
    // ser i portalen (`SAFE_TICKET_SELECT`), och EFTER bokningen. Inte före, och
    // inte blockerbar: det hade bakvägen återinfört ett samtyckeskrav på en
    // grund som inte är villkorad av hyresgästens godkännande.
    //
    // KANALEN nämns, aldrig värdet. Numret står redan i `sharedTenantContact`;
    // att kopiera in det i en kommentar hade spridit uppgiften till en yta till
    // utan att någon blir klokare.
    if (hyresgastKontakt) {
      const kanal = ticket.tenant?.phone === hyresgastKontakt ? 'telefonnummer' : 'e-postadress'
      await this.prisma.maintenanceComment.create({
        data: {
          ticketId,
          content:
            `Hyresgästens ${kanal} delades med ${contractor.name} i samband med ` +
            `arbetsorder för ärende ${ticket.ticketNumber}.`,
          isInternal: false,
        },
      })
    }

    // MEJLET SIST, efter att raden finns. Kraschar processen mellan de två har
    // en order skrivits som aldrig skickades — synligt som SENT utan mottaget
    // svar, vilket är läsbart. Motsatt ordning hade gett ett mejl utan rad:
    // hantverkaren får en länk som inte går att lösa upp.
    const svarslank = this.svarsUrl(token)
    await this.mail.sendCustomEmail({
      to: contractor.email,
      organizationId,
      subject,
      tenantName: contractor.name,
      organizationName: ticket.organization.name,
      bodyHtml: [
        `<p>${bodyText.split('\n').join('<br>')}</p>`,
        `<p><a href="${svarslank}">Svara på arbetsordern</a></p>`,
      ].join(''),
      // Idempotensnyckeln är ORDERNS id, inte ärendets: en ny order till samma
      // hantverkare för samma ärende ÄR ett nytt mejl och ska skickas.
      idempotencyKey: `work-order:${order.id}`,
    })

    return order
  }

  /**
   * HANTVERKARENS SVAR. Uppslaget sker på HASHEN av token ur sökvägen — aldrig
   * på ett id, och aldrig på råvärdet.
   *
   * Alla tre avslagen ger samma text. Ett svar som skiljer "finns inte" från
   * "har gått ut" berättar för den som gissar vilka token som funnits.
   */
  async respond(token: string, dto: WorkOrderResponseDto): Promise<{ status: string }> {
    const nu = new Date()
    const order = await this.prisma.contractorWorkOrder.findUnique({
      where: { responseTokenHash: sha256(token) },
    })
    const avvisa = () =>
      new NotFoundException('Länken är inte längre giltig. Kontakta hyresvärden.')
    if (!order) throw avvisa()
    if (order.respondedAt) throw avvisa()
    if (order.expiresAt <= nu) throw avvisa()
    if (order.status !== 'SENT') throw avvisa()

    // ENGÅNGSSPÄRREN ÄR ETT VILLKOR I SKRIVNINGEN, inte en läsning följd av en
    // skrivning. Två samtidiga klick på samma länk skulle annars båda se
    // `respondedAt: null` och båda skriva. `updateMany` med villkoret i `where`
    // gör att exakt en av dem träffar en rad.
    const traff = await this.prisma.contractorWorkOrder.updateMany({
      where: { id: order.id, respondedAt: null, status: 'SENT' },
      data: {
        status: dto.accepterar ? 'ACCEPTED' : 'DECLINED',
        respondedAt: nu,
        ...(dto.proposedAt ? { proposedAt: new Date(dto.proposedAt) } : {}),
        ...(dto.note ? { responseNote: dto.note } : {}),
      },
    })
    if (traff.count === 0) throw avvisa()

    return { status: dto.accepterar ? 'ACCEPTED' : 'DECLINED' }
  }

  /**
   * AVBOKNING — en KOMPENSERANDE handling, inte en ångring.
   *
   * Mejlet är skickat och läst. Det här skickar ett nytt mejl som säger att
   * jobbet är av, och stänger svarslänken. Att kalla det "undo" hade varit
   * osant på samma sätt som för signeringsinbjudan (`prepare_contract_signing`,
   * klassad IRREVERSIBEL av exakt det skälet).
   */
  async cancel(id: string, organizationId: string, skal?: string): Promise<ContractorWorkOrder> {
    const order = await this.prisma.contractorWorkOrder.findFirst({
      where: { id, organizationId },
      include: {
        contractor: { select: { name: true, email: true } },
        organization: { select: { name: true } },
      },
    })
    if (!order) throw new NotFoundException('Arbetsordern hittades inte')
    if (order.status === 'CANCELLED') {
      throw new BadRequestException('Arbetsordern är redan avbokad')
    }

    const uppdaterad = await this.prisma.contractorWorkOrder.update({
      where: { id },
      data: { status: 'CANCELLED', respondedAt: order.respondedAt ?? new Date() },
    })

    if (order.contractor.email) {
      await this.mail.sendCustomEmail({
        to: order.contractor.email,
        organizationId,
        subject: `Avbokad: ${order.subject}`,
        tenantName: order.contractor.name,
        organizationName: order.organization.name,
        bodyHtml: `<p>Arbetsordern är avbokad.${skal ? ` Skäl: ${skal}` : ''}</p>`,
        idempotencyKey: `work-order-cancel:${order.id}`,
      })
    }
    return uppdaterad
  }
}
