import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { PrismaService } from '../../../database/prisma.service';
import { AuthConfig } from '../../../config/auth.config';
import { VerifyPasskeyRegistrationInput } from '../dto/passkey.dto';
import {
  UnauthorizedException,
  ValidationException,
  NotFoundException,
} from '../../../common/exceptions/domain.exception';

export interface PasskeyRegistrationResult {
  credentialId: string;
  publicKey: string;
  counter: number;
}

/**
 * Handles WebAuthn passkey registration verification and credential persistence.
 *
 * Uses `@simplewebauthn/server` to cryptographically verify the attestation
 * response, then atomically stores the credential and invalidates the challenge
 * to prevent replay attacks.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly auth: AuthConfig;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  /**
   * Verifies a WebAuthn registration response and persists the new credential.
   *
   * Steps:
   * 1. Confirm the user exists in the database.
   * 2. Delegate to @simplewebauthn/server for cryptographic verification of the
   *    attestation (checks challenge match, origin, RP ID, signature, etc.).
   * 3. Within a transaction, invalidate the stored challenge and persist the
   *    credential — both succeed or both fail.
   *
   * @throws NotFoundException  if the user does not exist
   * @throws ValidationException if the challenge was not previously stored
   * @throws UnauthorizedException if cryptographic verification fails
   */
  async verifyRegistration(
    userId: string,
    input: VerifyPasskeyRegistrationInput,
    userAgent?: string,
  ): Promise<PasskeyRegistrationResult> {
    // 1. Confirm user exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User', userId);
    }

    // 2. Fetch the stored challenge
    const challengeRecord = await this.prisma.passkeyChallenge.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
    });

    if (!challengeRecord) {
      throw new ValidationException(
        'No active registration challenge found. Please request a new one.',
      );
    }

    // 3. Cryptographic verification via @simplewebauthn/server
    const credential = input.credential as RegistrationResponseJSON;
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: this.auth.passkey.origin,
      expectedRPID: this.auth.passkey.rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException(
        'Passkey registration verification failed — invalid credential response.',
      );
    }

    const { credential: webauthnCredential } = verification.registrationInfo;
    const counter = webauthnCredential.counter;

    // Convert the Uint8Array public key to a base64url string for storage.
    const publicKey = bufferToBase64url(webauthnCredential.publicKey);

    // 4. Atomic: invalidate challenge + persist credential
    const saved = await this.prisma.$transaction(async (tx) => {
      // Invalidate the challenge to prevent replay
      await tx.passkeyChallenge.deleteMany({
        where: { userId },
      });

      // Persist the verified credential
      return tx.passkeyCredential.create({
        data: {
          userId,
          credentialId: webauthnCredential.id,
          publicKey,
          counter,
          deviceName: input.deviceName ?? null,
          userAgent: userAgent ?? null,
        },
      });
    });

    this.logger.log(
      `Passkey registered for user ${userId}: credential ${saved.credentialId}`,
    );

    return {
      credentialId: saved.credentialId,
      publicKey: saved.publicKey,
      counter: saved.counter,
    };
  }
}

// ── Helpers ──

/**
 * Converts a Uint8Array to a URL-safe base64 string (no padding).
 * This is the standard encoding for WebAuthn credential IDs and keys.
 */
function bufferToBase64url(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer);
  return bytes.toString('base64url');
}
