import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PasskeyService } from './passkey.service';
import { PrismaService } from '../../../database/prisma.service';

// ── Mock @simplewebauthn/server ──
const mockVerifyRegistrationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
}));

// ── Helpers ──

interface MockTx {
  passkeyChallenge: { deleteMany: Mock };
  passkeyCredential: { create: Mock };
}

function buildMockPrisma() {
  const txMock: MockTx = {
    passkeyChallenge: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    passkeyCredential: { create: vi.fn() },
  };

  return {
    user: {
      findUnique: vi.fn(),
    },
    passkeyChallenge: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    passkeyCredential: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: MockTx) => Promise<MockTx>) => {
      return cb(txMock);
    }),
    _txMock: txMock,
  };
}

function buildMockConfig() {
  return {
    getOrThrow: vi.fn().mockReturnValue({
      passkey: {
        rpId: 'localhost',
        rpName: 'Astroid',
        origin: 'http://localhost:3001',
      },
    }),
  };
}

const VALID_INPUT = {
  expectedChallenge: 'test-challenge-abc123',
  credential: {
    id: 'cred-id-123',
    rawId: 'cred-id-123',
    response: {
      attestationObject: 'o2NmbXRkbmF2U0dGMIIB3Q',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoidGVzdC1jaGFsbGVuZ2UtYWJjMTIzIn0',
    },
    type: 'public-key' as const,
  },
  deviceName: 'YubiKey 5',
};

// ── Tests ──

describe('PasskeyService', () => {
  let prisma: ReturnType<typeof buildMockPrisma>;
  let config: ReturnType<typeof buildMockConfig>;
  let service: PasskeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = buildMockPrisma();
    config = buildMockConfig();
    service = new PasskeyService(prisma as unknown as PrismaService, config as unknown as ConfigService);
  });

  describe('verifyRegistration', () => {
    it('should verify and persist a valid registration credential', async () => {
      // Setup mocks
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'test-challenge-abc123',
        expiresAt: new Date(Date.now() + 300_000),
      });

      // Mock successful verification
      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: 'none',
          aaguid: '00000000-0000-0000-0000-000000000000',
          credential: {
            id: 'cred-id-123',
            publicKey: new Uint8Array([165, 1, 2, 3, 38, 32, 1]),
            counter: 0,
          },
          credentialType: 'public-key',
          attestationObject: new Uint8Array([160]),
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
          rpID: 'localhost',
        },
      });

      prisma._txMock.passkeyCredential.create.mockResolvedValue({
        id: 'pk-1',
        userId: 'user-1',
        credentialId: 'cred-id-123',
        publicKey: 'pQEDJg',
        counter: 0,
        deviceName: 'YubiKey 5',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
      });

      const result = await service.verifyRegistration('user-1', VALID_INPUT, 'Mozilla/5.0');

      // Verify the service called simplewebauthn correctly
      expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          response: VALID_INPUT.credential,
          expectedChallenge: 'test-challenge-abc123',
          expectedOrigin: 'http://localhost:3001',
          expectedRPID: 'localhost',
        }),
      );

      // Verify challenge was invalidated
      expect(prisma._txMock.passkeyChallenge.deleteMany).toHaveBeenCalled();

      // Verify credential was persisted
      expect(prisma._txMock.passkeyCredential.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          credentialId: 'cred-id-123',
          publicKey: expect.stringMatching(/.+/),
          counter: 0,
          deviceName: 'YubiKey 5',
          userAgent: 'Mozilla/5.0',
        },
      });

      // Verify return shape
      expect(result).toEqual({
        credentialId: 'cred-id-123',
        publicKey: expect.stringMatching(/.+/),
        counter: 0,
      });
    });

    it('should throw NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyRegistration('nonexistent-user', VALID_INPUT),
      ).rejects.toThrow('User');
    });

    it('should throw ValidationException when no active challenge exists', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyRegistration('user-1', VALID_INPUT),
      ).rejects.toThrow('No active registration challenge');
    });

    it('should throw UnauthorizedException when verification fails', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'test-challenge-abc123',
        expiresAt: new Date(Date.now() + 300_000),
      });

      // Mock failed verification (wrong challenge, bad signature, etc.)
      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: false,
        registrationInfo: undefined,
      });

      await expect(
        service.verifyRegistration('user-1', VALID_INPUT),
      ).rejects.toThrow('verification failed');
    });

    it('should pass user agent to the credential record', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      prisma.passkeyChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        userId: 'user-1',
        challenge: 'test-challenge-abc123',
        expiresAt: new Date(Date.now() + 300_000),
      });

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: 'none',
          aaguid: '00000000-0000-0000-0000-000000000000',
          credential: {
            id: 'cred-id-456',
            publicKey: new Uint8Array([165, 1, 2, 3]),
            counter: 1,
          },
          credentialType: 'public-key',
          attestationObject: new Uint8Array([160]),
          userVerified: false,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:3001',
        },
      });

      prisma._txMock.passkeyCredential.create.mockResolvedValue({
        id: 'pk-2',
        userId: 'user-1',
        credentialId: 'cred-id-456',
        publicKey: 'pQED',
        counter: 1,
        deviceName: null,
        userAgent: 'Chrome/120',
        createdAt: new Date(),
      });

      await service.verifyRegistration('user-1', {
        ...VALID_INPUT,
        deviceName: undefined,
      }, 'Chrome/120');

      expect(prisma._txMock.passkeyCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userAgent: 'Chrome/120',
          deviceName: null,
        }),
      });
    });
  });
});
