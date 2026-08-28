import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import {
  loginSchema,
  LoginInput,
  LoginDto,
  registerSchema,
  RegisterInput,
  RegisterDto,
  refreshSchema,
  RefreshInput,
  RefreshDto,
} from './auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleTierDecorator } from '../../common/decorators/throttle-tier.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import {
  UnauthorizedException,
} from '../../common/exceptions/domain.exception';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ThrottleTierDecorator('auth')
  @ApiOperation({ summary: 'Register a new organization and its owner' })
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Req() req: Request,
  ) {
    return this.authService.register(body, this.sessionContext(req));
  }

  @Public()
  @Post('login')
  @ThrottleTierDecorator('auth')
  @ApiOperation({ summary: 'Authenticate with email and password' })
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
  ) {
    return this.authService.login(body, this.sessionContext(req));
  }

  @Public()
  @Post('refresh')
  @ThrottleTierDecorator('auth')
  @ApiOperation({ summary: 'Rotate an access/refresh token pair' })
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke the current session' })
  logout(@CurrentUser() user: AuthenticatedUser) {
    if (!user.sessionId) {
      throw new UnauthorizedException('No active session on this token');
    }
    return this.authService.logout(user.sessionId);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the current authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  @Get('session')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the current session principal',
    description: 'PRD alias of GET /auth/me — resolves the authenticated user.',
  })
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  // Passkey endpoints have moved to PasskeyController under /auth/passkey/*.
  // See src/modules/auth/controllers/passkey.controller.ts

  /** Extracts best-effort device metadata for session records. */
  private sessionContext(req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;
    return {
      device: (req.headers['user-agent'] as string) ?? undefined,
      browser: (req.headers['user-agent'] as string) ?? undefined,
      ipAddress: ip,
    };
  }
}

// Re-export Swagger DTOs so they are picked up by the OpenAPI scanner.
export { LoginDto, RegisterDto, RefreshDto };
