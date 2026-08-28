import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, PolicyEvaluatorService],
  exports: [BudgetService, PolicyEvaluatorService],
})
export class BudgetModule {}
