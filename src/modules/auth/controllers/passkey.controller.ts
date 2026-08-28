import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ThrottleTierDecorator } from '../../../common/decorators/throttle-tier.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import {
  verifyPasskeyRegistrationSchema,
  VerifyPasskeyRegistrationInput,
  PasskeyCredentialDto,
} from '../dto/passkey.dto';
import { PasskeyService } from '../services/passkey.service';

/**
 * WebAuthn passkey endpoints.
 *
 * The registration-verification flow:
 *   1. Client calls an RP endpoint (not yet implemented) to obtain registration
 *      options and a challenge.
 *   2. Client completes the WebAuthn ceremony via @simplewebauthn/browser.
 *   3. Client POSTs the credential response here for server-side verification
 *      and persistence.
 */
@ApiTags('auth')
@Controller('auth/passkey')
export class PasskeyController {
  constructor(private readonly passkeyService: PasskeyService) {}

  /**
   * POST /auth/passkey/register/verify
   *
   * Consumes the registration challenge response credential, cryptographically
   * verifies it, invalidates the stored challenge, and persists the new passkey
   * credential atomically.
   */
  @Post('register/verify')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Verify a WebAuthn registration challenge response',
    description:
      'Validates the attestation credential from @simplewebauthn/browser, ' +
      'persists the public key and credential ID, and invalidates the challenge.',
  })
  verifyRegistration(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(verifyPasskeyRegistrationSchema))
    body: VerifyPasskeyRegistrationInput,
    @Req() req: Request,
  ): Promise<PasskeyCredentialDto> {
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.passkeyService.verifyRegistration(user.id, body, userAgent);
  }
}
