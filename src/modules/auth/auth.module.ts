import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PasskeyController } from './controllers/passkey.controller';
import { PasskeyService } from './services/passkey.service';

/**
 * Authentication module. Registers the passport-jwt strategy and a bare
 * JwtModule (per-call secrets are supplied explicitly by AuthService so the
 * access and refresh tokens can use different signing keys).
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
  ],
  controllers: [AuthController, PasskeyController],
  providers: [AuthService, JwtStrategy, PasskeyService],
  exports: [AuthService, PasskeyService],
})
export class AuthModule {}
