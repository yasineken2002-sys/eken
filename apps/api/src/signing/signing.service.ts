import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma, SigningRequestStatus } from '@prisma/client'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { SigningCryptoService } from './signing-crypto.service'
import {
  SIGNING_PROVIDER,
  type DocumentSigningProvider,
  type SignerRoleT,
  type ProviderPartyEvidence,
} from './signing.types'

interface ExpectedParty {
  role: SignerRoleT
  expectedPersonalNumberHash?: string
}

/**
 * Orkestrerar dokument-signering. Rör ALDRIG bokföringskedjan eller lease-status-
 * maskinen. Adaptern (Stub/Mock/Scrive) sköter själva signaturen; denna service
 * äger säkerheten: contentHash-frysning, WYSIWYS-verifiering, identitetsavstämning,
 * append-only bevis och förseglad PDF som ny låst Document-version.
 */
@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SigningCryptoService,
    private readonly storage: StorageService,
    @Inject(SIGNING_PROVIDER) private readonly provider: DocumentSigningProvider,
  ) {}

  private idempotencyKey(documentId: string, contentHash: string): string {
    return crypto.createHash('sha256').update(`${documentId}:${contentHash}`).digest('hex')
  }

  // ── Skapa signeringsbegäran ───────────────────────────────────────────────────
  // Fryser kontraktets contentHash (WYSIWYS-ankaret). Idempotent på (org, docId+hash):
  // samma dokument+version → samma request (ingen andra-envelope).
  async createSigningRequest(organizationId: string, userId: string | null, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId },
      select: {
        id: true,
        category: true,
        contentHash: true,
        storageKey: true,
        locked: true,
        leaseId: true,
      },
    })
    if (!doc) throw new NotFoundException('Dokumentet hittades inte')
    if (doc.category !== 'CONTRACT') {
      throw new BadRequestException('Endast kontrakt kan signeras')
    }
    if (!doc.contentHash) {
      throw new BadRequestException('Kontraktet saknar contentHash — generera om det först')
    }
    if (doc.locked) {
      throw new BadRequestException('Kontraktet är redan låst/signerat')
    }

    const idempotencyKey = this.idempotencyKey(doc.id, doc.contentHash)
    const existing = await this.prisma.signingRequest.findFirst({
      where: { organizationId, idempotencyKey },
    })
    if (existing) return existing

    // v1: endast hyresgästen signerar. Förväntad signerare = leasens hyresgäst;
    // bind sloten till hens personnummer (blind-index) om det finns registrerat.
    const expectedParties = await this.buildExpectedParties(doc.leaseId, organizationId)

    const created = await this.provider.createRequest({
      documentId: doc.id,
      contentHash: doc.contentHash,
      storageKey: doc.storageKey,
      parties: expectedParties.map((p) => ({
        role: p.role,
        name: p.role,
        ...(p.expectedPersonalNumberHash
          ? { expectedPersonalNumberHash: p.expectedPersonalNumberHash }
          : {}),
      })),
      visibleText: `Jag signerar hyreskontrakt ${doc.id}`,
      idempotencyKey,
    })

    return this.prisma.signingRequest.create({
      data: {
        organizationId,
        documentId: doc.id,
        ...(doc.leaseId ? { leaseId: doc.leaseId } : {}),
        contentHash: doc.contentHash,
        provider: this.provider.name,
        providerRequestId: created.providerRequestId,
        idempotencyKey,
        status: SigningRequestStatus.SIGNING_IN_PROGRESS,
        requiredRoles: expectedParties as unknown as Prisma.InputJsonValue,
        ...(userId ? { createdByUserId: userId } : {}),
      },
    })
  }

  private async buildExpectedParties(
    leaseId: string | null,
    organizationId: string,
  ): Promise<ExpectedParty[]> {
    if (!leaseId) return [{ role: 'TENANT' }]
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, unit: { property: { organizationId } } },
      select: { tenant: { select: { personalNumber: true } } },
    })
    const pn = lease?.tenant?.personalNumber
    const party: ExpectedParty = { role: 'TENANT' }
    if (pn && this.crypto.configured) party.expectedPersonalNumberHash = this.crypto.blindIndex(pn)
    return [party]
  }

  // ── Uppdatera status (poll ELLER webhook) ─────────────────────────────────────
  // Läser providerns status, skriver bevis för NYA färdiga parter (med WYSIWYS- +
  // identitetskontroll), och driver envelope-statusmaskinen. Idempotent.
  async refreshStatus(organizationId: string, signingRequestId: string) {
    const req = await this.prisma.signingRequest.findFirst({
      where: { id: signingRequestId, organizationId },
      include: { evidence: { select: { orderRef: true, signerRole: true } } },
    })
    if (!req) throw new NotFoundException('Signeringsbegäran hittades inte')
    if (!req.providerRequestId) return req

    const status = await this.provider.getStatus(req.providerRequestId)
    const expected = req.requiredRoles as unknown as ExpectedParty[]
    const alreadyRecorded = new Set(req.evidence.map((e) => e.orderRef))

    for (const party of status.parties) {
      if (party.status !== 'signed' || !party.evidence) continue
      if (alreadyRecorded.has(party.evidence.orderRef)) continue
      await this.recordEvidence(
        req.id,
        organizationId,
        req.documentId,
        req.contentHash,
        expected,
        party.evidence,
      )
    }

    return this.reconcileRequestStatus(req.id, organizationId)
  }

  // Skriver ETT append-only bevis efter WYSIWYS- + identitetskontroll. Kastar (och
  // skriver INGET bevis) vid hash-mismatch eller fel signerare.
  private async recordEvidence(
    signingRequestId: string,
    organizationId: string,
    documentId: string,
    frozenContentHash: string,
    expected: ExpectedParty[],
    ev: ProviderPartyEvidence,
  ): Promise<void> {
    // WYSIWYS: det signerade innehållet MÅSTE vara exakt det frusna.
    if (ev.signedContentHash !== frozenContentHash) {
      this.logger.error(
        `[signing] hashMismatch för request ${signingRequestId} (part ${ev.role}) — bevis EJ skrivet`,
      )
      throw new BadRequestException('Signerat innehåll matchar inte det frusna kontraktet')
    }

    // Identitetsavstämning: rätt person signerade rätt slot.
    const pnHash = this.crypto.blindIndex(ev.personalNumber)
    const slot = expected.find((e) => e.role === ev.role)
    if (slot?.expectedPersonalNumberHash && slot.expectedPersonalNumberHash !== pnHash) {
      this.logger.error(
        `[signing] identitet ≠ förväntad signerare för request ${signingRequestId} (part ${ev.role}) — bevis EJ skrivet`,
      )
      throw new BadRequestException('BankID-identiteten matchar inte den förväntade signeraren')
    }

    try {
      await this.prisma.signatureEvidence.create({
        data: {
          organizationId,
          signingRequestId,
          documentId,
          signerRole: ev.role,
          signerName: ev.signerName,
          personalNumberEnc: this.crypto.encrypt(ev.personalNumber),
          personalNumberHash: pnHash,
          provider: this.provider.name,
          orderRef: ev.orderRef,
          signedContentHash: ev.signedContentHash,
          ...(ev.signaturePayload
            ? { signaturePayload: this.crypto.encrypt(ev.signaturePayload) }
            : {}),
          ...(ev.certificate ? { certificate: this.crypto.encrypt(ev.certificate) } : {}),
          signedAt: ev.signedAt,
          ...(ev.ip ? { ip: ev.ip } : {}),
          ...(ev.userAgent ? { userAgent: ev.userAgent } : {}),
        },
      })
    } catch (err) {
      // Unik (org, provider, orderRef) → idempotent: en parallell/retry-skrivning av
      // samma bevis är en no-op, inte ett fel.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
      throw err
    }
  }

  // Räknar färdiga bevis mot requiredRoles (EXPLICIT lista) och sätter status. Vid
  // FULLY_SIGNED: försegla PDF:en som ny låst Document-version + lås originalet.
  private async reconcileRequestStatus(signingRequestId: string, organizationId: string) {
    const req = await this.prisma.signingRequest.findFirstOrThrow({
      where: { id: signingRequestId, organizationId },
      include: { evidence: { select: { signerRole: true } } },
    })
    const required = (req.requiredRoles as unknown as ExpectedParty[]).map((e) => e.role)
    const signed = new Set(req.evidence.map((e) => e.signerRole))
    const allSigned = required.every((r) => signed.has(r))

    let status: SigningRequestStatus = req.status
    if (allSigned) status = SigningRequestStatus.FULLY_SIGNED
    else if (signed.size > 0) status = SigningRequestStatus.PARTIALLY_SIGNED

    if (allSigned && req.status !== SigningRequestStatus.FULLY_SIGNED) {
      const sealedDocumentId = await this.sealAndLock(
        req.id,
        organizationId,
        req.documentId,
        req.providerRequestId!,
      )
      return this.prisma.signingRequest.update({
        where: { id: req.id },
        data: { status, ...(sealedDocumentId ? { sealedDocumentId } : {}) },
      })
    }
    if (status !== req.status) {
      return this.prisma.signingRequest.update({ where: { id: req.id }, data: { status } })
    }
    return req
  }

  // Hämtar förseglad PDF från providern, lagrar den som en NY LÅST Document-version
  // (previousVersionId → originalet) och låser originalet. Beviset binder den frusna
  // OSIGNERADE hashen; den förseglade PDF:en är en härledd artefakt.
  private async sealAndLock(
    _signingRequestId: string,
    organizationId: string,
    documentId: string,
    providerRequestId: string,
  ): Promise<string | null> {
    const original = await this.prisma.document.findFirstOrThrow({
      where: { id: documentId, organizationId },
    })
    const sealed = await this.provider.fetchSealed(providerRequestId)

    let sealedDocumentId: string | null = null
    if (sealed) {
      const key = `documents/${organizationId}/signed/${documentId}-sealed.pdf`
      const url = await this.storage.uploadFile(sealed.bytes, key, 'application/pdf')
      const sealedHash = crypto.createHash('sha256').update(sealed.bytes).digest('hex')
      const sealedDoc = await this.prisma.document.create({
        data: {
          organizationId,
          name: `${original.name} (signerad)`,
          storageKey: key,
          storageUrl: url,
          mimeType: 'application/pdf',
          fileSize: sealed.bytes.length,
          category: 'CONTRACT',
          ...(original.leaseId ? { leaseId: original.leaseId } : {}),
          ...(original.tenantId ? { tenantId: original.tenantId } : {}),
          contentHash: sealedHash,
          locked: true,
          previousVersionId: documentId,
        },
      })
      sealedDocumentId = sealedDoc.id
    }

    // Lås originalet (får ej ändras efter signering). Rör inte lease-statusmaskinen.
    await this.prisma.document.update({
      where: { id: documentId },
      data: { locked: true, signedAt: new Date() },
    })
    return sealedDocumentId
  }

  // ── Säker projektion (portal/UI/AI) — ALDRIG känsliga fält ────────────────────
  async getStatusSafe(organizationId: string, signingRequestId: string) {
    const req = await this.prisma.signingRequest.findFirst({
      where: { id: signingRequestId, organizationId },
      select: {
        id: true,
        documentId: true,
        status: true,
        requiredRoles: true,
        sealedDocumentId: true,
        createdAt: true,
        evidence: { select: SAFE_SIGNATURE_EVIDENCE_SELECT },
      },
    })
    if (!req) throw new NotFoundException('Signeringsbegäran hittades inte')
    return req
  }

  // Webhook-väg: verifiera signatur → hitta request → refresha status.
  async handleWebhook(
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
  ): Promise<{ handled: boolean }> {
    const verified = this.provider.verifyWebhook(headers, rawBody)
    if (!verified.valid || !verified.providerRequestId) {
      throw new BadRequestException('Ogiltig webhook-signatur')
    }
    const req = await this.prisma.signingRequest.findFirst({
      where: { providerRequestId: verified.providerRequestId },
      select: { id: true, organizationId: true },
    })
    if (!req) throw new NotFoundException('Ingen signeringsbegäran för denna callback')
    await this.refreshStatus(req.organizationId, req.id)
    return { handled: true }
  }
}

/**
 * Allow-list: de ENDA SignatureEvidence-fält som får lämna backend. Känsliga fält
 * (personalNumberEnc/Hash, signaturePayload, certificate, orderRef, signedContentHash,
 * organizationId) är MEDVETET uteslutna och får ALDRIG nå portal/AI/frontend.
 * (Spegel av tenant-portal-läcktätningens SAFE_*_SELECT-mönster, #156-160.)
 */
export const SAFE_SIGNATURE_EVIDENCE_SELECT = {
  id: true,
  signerRole: true,
  signerName: true,
  signedAt: true,
} as const
