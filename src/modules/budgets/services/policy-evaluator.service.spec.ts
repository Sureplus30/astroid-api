import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PolicyEvaluatorService } from './policy-evaluator.service';
import { PrismaService } from '../../../database/prisma.service';

const Decimal = Prisma.Decimal;

// ── Mock PrismaService ──

function buildMockPrisma() {
  return {
    policy: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    budget: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
}

const BASE_REQUEST = {
  organizationId: 'org-1',
  agentId: 'agent-1',
  walletId: 'wallet-1',
  asset: 'USDC',
  amount: '100.0000000',
  recipientAddress: 'GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZA567',
};

function policyConfig(overrides: Record<string, unknown>) {
  return {
    id: 'policy-1',
    name: 'Test Policy',
    enabled: true,
    agentId: null,
    priority: 100,
    configuration: overrides,
    overrideLimit: null,
    overrideUntil: null,
    originalLimit: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

/** Creates a mock aggregate result with a Decimal-compatible amount. */
function aggregateResult(amount: number | null) {
  return { _sum: { amount: amount != null ? new Decimal(amount) : null } };
}

// ── Tests ──

describe('PolicyEvaluatorService', () => {
  let prisma: ReturnType<typeof buildMockPrisma>;
  let service: PolicyEvaluatorService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = buildMockPrisma();
    service = new PolicyEvaluatorService(prisma as unknown as PrismaService);
  });

  describe('single-transaction max amount', () => {
    it('allows a transaction below the max amount limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 500 }),
      ]);

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '100.0000000' });

      expect(result.allowed).toBe(true);
    });

    it('blocks a transaction exceeding the max amount limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 50 }),
      ]);

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '100.0000000' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds single-transaction limit');
      expect(result.remainingLimit).toBeDefined();
    });

    it('allows a transaction matching exactly the max amount', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 100 }),
      ]);

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '100.0000000' });

      expect(result.allowed).toBe(true);
    });

    it('blocks a transaction exceeding the limit by 0.0000001', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 100 }),
      ]);

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '100.0000001' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('exceeds single-transaction limit');
    });
  });

  describe('daily spend aggregation', () => {
    it('allows a transaction within daily limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ dailyLimit: 1000 }),
      ]);
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(null))   // weekly (skipped)
        .mockResolvedValueOnce(aggregateResult(500));    // daily

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '400.0000000' });

      expect(result.allowed).toBe(true);
    });

    it('blocks a transaction that would exceed daily limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ dailyLimit: 1000 }),
      ]);
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(null))   // weekly (skipped)
        .mockResolvedValueOnce(aggregateResult(800));    // daily

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '300.0000000' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('daily limit');
      expect(result.remainingLimit).toBeDefined();
    });

    it('returns exact remaining limit before projection', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ dailyLimit: 1000 }),
      ]);
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(null))
        .mockResolvedValueOnce(aggregateResult(750));

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '300.0000000' });

      expect(result.allowed).toBe(false);
      // remaining = limit - currentSpend = 1000 - 750 = 250
      expect(result.remainingLimit).toBe('250.0000000');
    });
  });

  describe('weekly spend aggregation', () => {
    it('allows a transaction within weekly limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ weeklyLimit: 5000 }),
      ]);
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(3000));   // weekly

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '1500.0000000' });

      expect(result.allowed).toBe(true);
    });

    it('blocks a transaction that would exceed weekly limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ weeklyLimit: 5000 }),
      ]);
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(4500));   // weekly

      const result = await service.evaluate({ ...BASE_REQUEST, amount: '600.0000000' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('weekly limit');
    });
  });

  describe('recipient whitelist', () => {
    it('allows a transaction to an address in the whitelist', async () => {
      const allowedAddress = 'GALLOWED123456789012345678901234567890123456789012345';
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ allowedRecipients: [allowedAddress, 'GOTHER99999999999999999999999999999999999999999999'] }),
      ]);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        recipientAddress: allowedAddress,
      });

      expect(result.allowed).toBe(true);
    });

    it('blocks a transaction to an address not in the whitelist', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ allowedRecipients: ['GALLOWED123456789012345678901234567890123456789012345'] }),
      ]);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        recipientAddress: 'GBLOCKED999999999999999999999999999999999999999999999',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in the allowed destination whitelist');
    });

    it('skips whitelist check when no policy defines allowedRecipients', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 5000 }),
      ]);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        recipientAddress: 'GANYTHING999999999999999999999999999999999999999999999',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('budget headroom', () => {
    it('allows a transaction within budget headroom', async () => {
      prisma.policy.findMany.mockResolvedValue([]);
      prisma.budget.findFirst.mockResolvedValue({
        id: 'budget-1',
        name: 'Q3 Marketing',
        limitAmount: new Decimal('10000'),
        spent: new Decimal('5000'),
        deletedAt: null,
      });

      const result = await service.evaluate({
        ...BASE_REQUEST,
        budgetId: 'budget-1',
        amount: '2000.0000000',
      });

      expect(result.allowed).toBe(true);
      expect(result.remainingLimit).toBe('3000.0000000');
    });

    it('blocks a transaction exceeding budget headroom', async () => {
      prisma.policy.findMany.mockResolvedValue([]);
      prisma.budget.findFirst.mockResolvedValue({
        id: 'budget-1',
        name: 'Q3 Marketing',
        limitAmount: new Decimal('10000'),
        spent: new Decimal('9000'),
        deletedAt: null,
      });

      const result = await service.evaluate({
        ...BASE_REQUEST,
        budgetId: 'budget-1',
        amount: '2000.0000000',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('insufficient headroom');
      expect(result.remainingLimit).toBe('1000.0000000');
    });

    it('returns allowed when no budget ID is provided', async () => {
      prisma.policy.findMany.mockResolvedValue([]);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        budgetId: undefined,
      });

      expect(result.allowed).toBe(true);
    });

    it('blocks when budget is already over limit', async () => {
      prisma.policy.findMany.mockResolvedValue([]);
      prisma.budget.findFirst.mockResolvedValue({
        id: 'budget-1',
        name: 'Q3 Marketing',
        limitAmount: new Decimal('10000'),
        spent: new Decimal('11000'),
        deletedAt: null,
      });

      const result = await service.evaluate({
        ...BASE_REQUEST,
        budgetId: 'budget-1',
        amount: '100.0000000',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('already over limit');
      expect(result.remainingLimit).toBe('0.0000000');
    });

    it('blocks when budget not found', async () => {
      prisma.policy.findMany.mockResolvedValue([]);
      prisma.budget.findFirst.mockResolvedValue(null);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        budgetId: 'nonexistent-budget',
        amount: '100.0000000',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('no policies configured', () => {
    it('allows the transaction when no policies exist', async () => {
      prisma.policy.findMany.mockResolvedValue([]);

      const result = await service.evaluate(BASE_REQUEST);

      expect(result.allowed).toBe(true);
    });
  });

  describe('combined checks', () => {
    it('evaluates max amount before daily limits', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ maxAmount: 500, dailyLimit: 10000 }),
      ]);

      const result = await service.evaluate({
        ...BASE_REQUEST,
        amount: '600.0000000',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('single-transaction limit');
      // Should not have queried transactions (max amount fails first)
      expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    });

    it('checks daily limit before weekly limit', async () => {
      prisma.policy.findMany.mockResolvedValue([
        policyConfig({ dailyLimit: 1000, weeklyLimit: 50000 }),
      ]);
      // Daily spend is 900 — adding 200 exceeds daily but not weekly
      prisma.transaction.aggregate
        .mockResolvedValueOnce(aggregateResult(null))    // weekly (skipped, no daily-only failure)
        .mockResolvedValueOnce(aggregateResult(900));     // daily

      const result = await service.evaluate({
        ...BASE_REQUEST,
        amount: '200.0000000',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('daily limit');
    });
  });
});
