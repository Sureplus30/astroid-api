import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

const Decimal = Prisma.Decimal;

// ── Input / Output types ──

export interface PolicyEvaluationRequest {
  /** Organization the agent belongs to. */
  organizationId: string;
  /** Agent initiating the transaction (optional — org-wide policies apply when absent). */
  agentId?: string;
  /** Wallet performing the payment. */
  walletId: string;
  /** Stellar asset code (e.g. "XLM", "USDC"). */
  asset: string;
  /** Transaction amount as a string to preserve precision. */
  amount: string;
  /** Destination Stellar address. */
  recipientAddress: string;
  /** Optional budget ID to check budget headroom. */
  budgetId?: string;
}

export interface PolicyComplianceResult {
  /** Whether the transaction is allowed by all evaluated policies and budgets. */
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
  /** Remaining spend capacity for the tightest limit (as a decimal string). */
  remainingLimit?: string;
}

// ── Statuses that count as "executed" for spend aggregation ──
const SPENT_STATUSES = ['COMPLETED', 'CONFIRMED', 'SUBMITTED'];

/**
 * Standalone, high-performance evaluator that validates a pending transaction
 * against active spending policies and budget restrictions. Designed to be
 * called in the transaction execution path — keeps all queries fast and
 * avoids unnecessary I/O.
 *
 * Checks performed (in order):
 *   1. Single-transaction max-amount limit (from policy configuration)
 *   2. Aggregated daily spend against daily limit (queried from transaction logs)
 *   3. Aggregated weekly spend against weekly limit (queried from transaction logs)
 *   4. Destination address against allowed recipient whitelist
 *   5. Budget headroom (if a budget ID is supplied)
 *
 * Uses Prisma.Decimal throughout to preserve Stellar's 7-decimal precision
 * without floating-point drift.
 */
@Injectable()
export class PolicyEvaluatorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluate a pending transaction against all active spending policies and
   * optional budget constraints. Returns immediately on the first hard failure
   * for speed.
   */
  async evaluate(request: PolicyEvaluationRequest): Promise<PolicyComplianceResult> {
    const {
      organizationId,
      agentId,
      walletId,
      asset,
      amount,
      recipientAddress,
      budgetId,
    } = request;

    const txAmount = new Decimal(amount);

    // 1. Load active policies scoped to this org + agent
    const policies = await this.prisma.policy.findMany({
      where: {
        organizationId,
        enabled: true,
        deletedAt: null,
        OR: [{ agentId: null }, ...(agentId ? [{ agentId }] : [])],
      },
      orderBy: { priority: 'asc' },
    });

    if (policies.length === 0) {
      // No active policies — check budget only
      return this.checkBudgetHeadroom(organizationId, budgetId, txAmount);
    }

    // 2. Check single-transaction max amount
    const maxAmountResult = this.checkMaxAmount(policies, txAmount);
    if (maxAmountResult) return maxAmountResult;

    // 3. Aggregate historical spend for daily / weekly limit checks
    const spendResult = await this.checkPeriodicLimits(
      organizationId,
      agentId,
      walletId,
      asset,
      txAmount,
      policies,
    );
    if (spendResult) return spendResult;

    // 4. Destination address whitelist
    const recipientResult = this.checkRecipientWhitelist(policies, recipientAddress);
    if (recipientResult) return recipientResult;

    // 5. Budget headroom
    return this.checkBudgetHeadroom(organizationId, budgetId, txAmount);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Checks the transaction amount against every policy's maxAmount (or
   * active temporary override). Returns the first violation found, or null.
   */
  private checkMaxAmount(
    policies: Array<{ configuration: Prisma.JsonValue; overrideLimit?: Prisma.Decimal | null; overrideUntil?: Date | null; originalLimit?: Prisma.Decimal | null }>,
    txAmount: Prisma.Decimal,
  ): PolicyComplianceResult | null {
    const now = new Date();

    for (const policy of policies) {
      const config = policy.configuration as Record<string, unknown>;
      if (config.maxAmount === undefined) continue;

      // Resolve effective limit: active temporary override wins
      const overrideActive =
        policy.overrideLimit != null &&
        policy.overrideUntil != null &&
        now <= policy.overrideUntil;

      const effectiveLimit = overrideActive
        ? new Decimal(policy.overrideLimit!)
        : policy.originalLimit != null
          ? new Decimal(policy.originalLimit!)
          : new Decimal(config.maxAmount as number);

      if (txAmount.greaterThan(effectiveLimit)) {
        return {
          allowed: false,
          reason: `Amount ${txAmount.toFixed(7)} exceeds single-transaction limit of ${effectiveLimit.toFixed(7)} (policy: ${config.maxAmount})`,
          remainingLimit: effectiveLimit.minus(txAmount).isNegative()
            ? '0.0000000'
            : effectiveLimit.minus(txAmount).toFixed(7),
        };
      }
    }
    return null;
  }

  /**
   * Aggregates completed transaction spend for the current UTC day and week,
   * then checks daily and weekly limits from policy configurations.
   */
  private async checkPeriodicLimits(
    organizationId: string,
    agentId: string | undefined,
    walletId: string,
    asset: string,
    txAmount: Prisma.Decimal,
    policies: Array<{ configuration: Prisma.JsonValue }>,
  ): Promise<PolicyComplianceResult | null> {
    // Determine if any policy has daily or weekly limits
    let hasDailyLimit = false;
    let hasWeeklyLimit = false;

    for (const policy of policies) {
      const config = policy.configuration as Record<string, unknown>;
      if (typeof config.dailyLimit === 'number' && config.dailyLimit > 0) hasDailyLimit = true;
      if (typeof config.weeklyLimit === 'number' && config.weeklyLimit > 0) hasWeeklyLimit = true;
    }

    if (!hasDailyLimit && !hasWeeklyLimit) return null;

    const now = new Date();

    // Compute UTC boundaries
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Week starts on Monday (ISO). Compute the most recent Monday at 00:00 UTC.
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - daysSinceMonday);

    // Query aggregated spend in a single query using Prisma's _sum
    const result = await this.prisma.transaction.aggregate({
      where: {
        organizationId,
        ...(agentId ? { agentId } : {}),
        walletId,
        asset,
        status: { in: SPENT_STATUSES as never[] },
        createdAt: { gte: startOfWeek }, // Covers both daily and weekly
      },
      _sum: { amount: true },
    });

    const totalSpend = result._sum.amount ?? new Decimal(0);

    // For daily limit: need only today's spend. Re-query if daily limit exists.
    // Optimisation: if weekly limit is the only concern, use totalSpend directly.
    let dailySpend = totalSpend;
    if (hasDailyLimit) {
      const dailyResult = await this.prisma.transaction.aggregate({
        where: {
          organizationId,
          ...(agentId ? { agentId } : {}),
          walletId,
          asset,
          status: { in: SPENT_STATUSES as never[] },
          createdAt: { gte: startOfDay },
        },
        _sum: { amount: true },
      });
      dailySpend = dailyResult._sum.amount ?? new Decimal(0);
    }

    // Check daily limits
    for (const policy of policies) {
      const config = policy.configuration as Record<string, unknown>;
      const dailyLimit = config.dailyLimit;
      if (typeof dailyLimit !== 'number' || dailyLimit <= 0) continue;

      const limit = new Decimal(dailyLimit);
      const projected = dailySpend.plus(txAmount);
      if (projected.greaterThan(limit)) {
        const remaining = limit.minus(dailySpend);
        return {
          allowed: false,
          reason: `Projected daily spend ${projected.toFixed(7)} would exceed daily limit of ${limit.toFixed(7)}`,
          remainingLimit: remaining.isNegative() ? '0.0000000' : remaining.toFixed(7),
        };
      }
    }

    // Check weekly limits
    for (const policy of policies) {
      const config = policy.configuration as Record<string, unknown>;
      const weeklyLimit = config.weeklyLimit;
      if (typeof weeklyLimit !== 'number' || weeklyLimit <= 0) continue;

      const limit = new Decimal(weeklyLimit);
      const projected = totalSpend.plus(txAmount);
      if (projected.greaterThan(limit)) {
        const remaining = limit.minus(totalSpend);
        return {
          allowed: false,
          reason: `Projected weekly spend ${projected.toFixed(7)} would exceed weekly limit of ${limit.toFixed(7)}`,
          remainingLimit: remaining.isNegative() ? '0.0000000' : remaining.toFixed(7),
        };
      }
    }

    return null;
  }

  /**
   * Checks the recipient address against all policies' allowedRecipients
   * whitelists. If ANY policy defines an allowlist and the address is not in
   * it, the transaction is blocked.
   */
  private checkRecipientWhitelist(
    policies: Array<{ configuration: Prisma.JsonValue }>,
    recipientAddress: string,
  ): PolicyComplianceResult | null {
    for (const policy of policies) {
      const config = policy.configuration as Record<string, unknown>;
      const allowedRecipients = config.allowedRecipients;
      if (!Array.isArray(allowedRecipients) || allowedRecipients.length === 0) continue;

      if (!allowedRecipients.includes(recipientAddress)) {
        return {
          allowed: false,
          reason: `Recipient ${recipientAddress} is not in the allowed destination whitelist`,
        };
      }
    }
    return null;
  }

  /**
   * Checks the budget's remaining headroom against the pending amount.
   * Returns a soft info result when no budget is linked.
   */
  private async checkBudgetHeadroom(
    organizationId: string,
    budgetId: string | undefined,
    txAmount: Prisma.Decimal,
  ): Promise<PolicyComplianceResult> {
    if (!budgetId) {
      return { allowed: true };
    }

    const budget = await this.prisma.budget.findFirst({
      where: { id: budgetId, organizationId, deletedAt: null },
    });

    if (!budget) {
      return {
        allowed: false,
        reason: `Budget '${budgetId}' not found or deleted`,
      };
    }

    const limit = new Decimal(budget.limitAmount);
    const spent = new Decimal(budget.spent);
    const remaining = limit.minus(spent);

    if (remaining.isNegative()) {
      return {
        allowed: false,
        reason: `Budget '${budget.name}' is already over limit (spent: ${spent.toFixed(7)}, limit: ${limit.toFixed(7)})`,
        remainingLimit: '0.0000000',
      };
    }

    if (txAmount.greaterThan(remaining)) {
      return {
        allowed: false,
        reason: `Budget '${budget.name}' has insufficient headroom (remaining: ${remaining.toFixed(7)}, requested: ${txAmount.toFixed(7)})`,
        remainingLimit: remaining.toFixed(7),
      };
    }

    return {
      allowed: true,
      remainingLimit: remaining.minus(txAmount).toFixed(7),
    };
  }
}
