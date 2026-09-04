import { IsString, IsNotEmpty, MaxLength } from 'class-validator'

/**
 * DTO:erna importeras som VÄRDEN i controllern, aldrig med `import type`:
 * ValidationPipe läser reflect-metadata i runtime, och en typ-import raderas —
 * då försvinner all validering tyst. Se DTO-regeln i CLAUDE.md.
 */

/** `orderRef` är opakt och kommer från providern. Vi validerar bara formen. */
export class BankIdCollectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  orderRef!: string
}

export class BankIdChooseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  chooseToken!: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string
}
