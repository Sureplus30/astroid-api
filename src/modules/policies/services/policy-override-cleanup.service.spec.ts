import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PolicyOverrideCleanupService } from './policy-override-cleanup.service';

// A minimal Decimal stand-in: the service only calls .toNumber() on it.
const dec = (n: number) => ({ toNumber: () => n });

const now = new Date('2026-08-01T00:00:00Z');

interface MockTx {
  policy: {
    findUnique: Mock;
    updateMany: Mock;
  };
}

describe('PolicyOverrideCleanupService', () => {
  let prisma: Partial<PrismaService>;
  let tx: MockTx;
  let eventBus: Partial<EventBusService>;
  let service: PolicyOverrideCleanupService;

  beforeEach(() => {
    tx = {
      policy: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    prisma = {
      policy: { findMany: vi.fn() },
      $transaction: vi.fn(async (cb: (t: MockTx) => Promise<MockTx>) => cb(tx)),
    } as unknown as Partial<PrismaService>;
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    service = new PolicyOverrideCleanupService(
      prisma as PrismaService,
      eventBus as EventBusService,
    );
  });

  it('restores an expired override and emits the typed event', async () => {
    const row = {
      id: 'p1',
      organizationId: 'org-1',
      overrideLimit: dec(2000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: dec(500),
    };
    const policyRow = {
      id: 'p1',
      organizationId: 'org-1',
      configuration: { maxAmount: 500 },
      overrideLimit: dec(2000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: dec(500),
    };
    (prisma.policy as unknown as { findMany: Mock }).findMany.mockResolvedValue([row]);
    tx.policy.findUnique.mockResolvedValue(policyRow);
    tx.policy.updateMany.mockResolvedValue({ count: 1 });

    const results = await service.runCleanup(now);

    expect(results).toEqual([
      { policyId: 'p1', organizationId: 'org-1', previousLimit: 2000, restoredLimit: 500 },
    ]);

    expect(tx.policy.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', overrideLimit: { not: null }, overrideUntil: { lt: now } },
      data: {
        overrideLimit: null,
        overrideUntil: null,
        originalLimit: null,
        configuration: { maxAmount: 500 },
      },
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.PolicyOverrideExpired,
      {
        policyId: 'p1',
        previousLimit: 2000,
        restoredLimit: 500,
        expiredAt: now,
      },
      { organizationId: 'org-1', aggregateType: 'policy', aggregateId: 'p1' },
    );
  });

  it('falls back to the configured maxAmount when originalLimit is absent', async () => {
    const row = {
      id: 'p2',
      organizationId: 'org-1',
      overrideLimit: dec(9000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: null,
    };
    const policyRow = {
      id: 'p2',
      organizationId: 'org-1',
      configuration: { maxAmount: 250 },
      overrideLimit: dec(9000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: null,
    };
    (prisma.policy as unknown as { findMany: Mock }).findMany.mockResolvedValue([row]);
    tx.policy.findUnique.mockResolvedValue(policyRow);
    tx.policy.updateMany.mockResolvedValue({ count: 1 });

    const results = await service.runCleanup(now);

    expect(results[0].restoredLimit).toBe(250);
    expect(tx.policy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ configuration: { maxAmount: 250 } }),
      }),
    );
  });

  it('does not reset a row that a concurrent request extended', async () => {
    const row = {
      id: 'p3',
      organizationId: 'org-1',
      overrideLimit: dec(2000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: dec(500),
    };
    const policyRow = {
      id: 'p3',
      organizationId: 'org-1',
      configuration: { maxAmount: 500 },
      overrideLimit: dec(2000),
      overrideUntil: new Date('2026-07-31T00:00:00Z'),
      originalLimit: dec(500),
    };
    (prisma.policy as unknown as { findMany: Mock }).findMany.mockResolvedValue([row]);
    tx.policy.findUnique.mockResolvedValue(policyRow);
    tx.policy.updateMany.mockResolvedValue({ count: 0 });

    const results = await service.runCleanup(now);

    expect(results).toEqual([]);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('does nothing when there are no expired overrides', async () => {
    (prisma.policy as unknown as { findMany: Mock }).findMany.mockResolvedValue([]);

    const results = await service.runCleanup(now);

    expect(results).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
