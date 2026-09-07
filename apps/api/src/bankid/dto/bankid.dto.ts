import { IsString, IsNotEmpty, MaxLength } from 'class-validator'

import type { BankIdCollectInput, BankIdUserChooseInput, SammaNycklar } from '@eken/shared'

/**
 * DTO:erna importeras som VÄRDEN i controllern, aldrig med `import type`:
 * ValidationPipe läser reflect-metadata i runtime, och en typ-import raderas —
 * då försvinner all validering tyst. Se DTO-regeln i CLAUDE.md.
 */

/** `orderRef` är opakt och kommer från providern. Vi validerar bara formen. */
export class BankIdCollectDto implements BankIdCollectInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  orderRef!: string
}

export class BankIdChooseDto implements BankIdUserChooseInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  chooseToken!: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string
}

// OPERATÖRENS realm. Klassnamnen sammanfaller med hyresgästportalens
// (`tenant-portal/dto/tenant-auth.dto.ts`) och det är rätt — samma handling i
// två världar. Typerna skiljer sig där fälten gör det: `userId` här, `tenantId`
// där, två register med olika föräldrar.
const _kontraktCollect: SammaNycklar<BankIdCollectDto, BankIdCollectInput> = true
const _kontraktChoose: SammaNycklar<BankIdChooseDto, BankIdUserChooseInput> = true
void _kontraktCollect
void _kontraktChoose
