import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Zod schemas (runtime validation) ──

/**
 * Raw credential response payload as serialized by @simplewebauthn/browser.
 * Matches the `RegistrationResponseJSON` shape from the SimpleWebAuthn spec.
 */
const authenticatorAttachmentSchema = z.enum(['platform', 'cross-platform']);

const credentialResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    attestationObject: z.string().min(1),
    clientDataJSON: z.string().min(1),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema.optional(),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

export const verifyPasskeyRegistrationSchema = z.object({
  /** The original base64url challenge that was sent to generateRegistrationOptions. */
  expectedChallenge: z.string().min(1),
  /** The credential response from the client after the authenticator ceremony. */
  credential: credentialResponseSchema,
  /** Human-readable device name for the credential record. */
  deviceName: z.string().max(120).optional(),
});

export type VerifyPasskeyRegistrationInput = z.infer<typeof verifyPasskeyRegistrationSchema>;

// ── Swagger DTO (documentation only — validation is done by Zod pipe) ──

class CredentialResponseDto {
  @ApiProperty({ description: 'Base64url credential ID' })
  id!: string;

  @ApiProperty({ description: 'Base64url-encoded raw credential ID' })
  rawId!: string;

  @ApiProperty({ description: 'Authenticator response payloads' })
  response!: {
    attestationObject: string;
    clientDataJSON: string;
  };

  @ApiPropertyOptional({ enum: ['platform', 'cross-platform'] })
  authenticatorAttachment?: 'platform' | 'cross-platform';

  @ApiProperty({ enum: ['public-key'] })
  type!: 'public-key';

  @ApiPropertyOptional({ description: 'WebAuthn client extension results' })
  clientExtensionResults?: Record<string, unknown>;
}

export class VerifyPasskeyRegistrationDto {
  @ApiProperty({
    description:
      'The base64url challenge previously returned by the registration options endpoint',
  })
  expectedChallenge!: string;

  @ApiProperty({ description: 'Credential response from @simplewebauthn/browser' })
  credential!: CredentialResponseDto;

  @ApiPropertyOptional({ description: 'Device name (e.g. "YubiKey 5", "macOS Touch ID")' })
  deviceName?: string;
}

export class PasskeyCredentialDto {
  @ApiProperty({ description: 'Unique WebAuthn credential ID' })
  credentialId!: string;

  @ApiProperty({ description: 'Base64url-encoded credential public key' })
  publicKey!: string;

  @ApiProperty({ description: 'Signature counter for replay protection' })
  counter!: number;
}
