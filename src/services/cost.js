/**
 * Cost tracking + budget guard (shared requirement #7: cost tracked per call,
 * attributed, with a budget guard).
 *
 * Every vision/embedding call — including $0 fixture and local-Ollama calls —
 * gets a cost_log row with provider, model, operation, entity reference and
 * USD cost. call_id is UNIQUE so re-logging the same entry is a no-op
 * (idempotent). The budget guard refuses new calls once the configured monthly
 * budget is exhausted, and the job raises a failure alert.
 */
const crypto = require('crypto');
const { getDb } = require('../db');

class BudgetExceededError extends Error {
  constructor(total, budget) {
    super(`cost budget exceeded: ${total.toFixed(4)} >= ${budget} USD this month`);
    this.code = 'BUDGET_EXCEEDED';
  }
}

class CostTracker {
  constructor(tenantId = 'default') {
    this.tenantId = tenantId;
  }

  /**
   * Attribute one call. Returns the row (or the existing row on duplicate).
   */
  logCall({ callId, provider, model, operation, entityRef, inputUnits, costUsd, status = 'ok', error = null }) {
    const db = getDb();
    const id = callId || crypto.randomUUID();
    db.prepare(
      `INSERT INTO cost_log (call_id, tenant_id, provider, model, operation, entity_ref, input_units, cost_usd, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(call_id) DO NOTHING`
    ).run(id, this.tenantId, provider, model, operation, entityRef || null, inputUnits || null, costUsd ?? 0, status, error);
    return { callId: id, costUsd: costUsd ?? 0 };
  }

  monthStart() {
    return new Date().toISOString().slice(0, 8) + '01';
  }

  totalThisMonth() {
    const db = getDb();
    const row = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE created_at >= ?`
    ).get(this.monthStart());
    return row.total;
  }

  summary() {
    const db = getDb();
    const total = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS t, COUNT(*) AS n FROM cost_log`).get();
    const byOperation = db.prepare(
      `SELECT operation, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM cost_log GROUP BY operation`
    ).all();
    const byProvider = db.prepare(
      `SELECT provider, model, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost FROM cost_log GROUP BY provider, model`
    ).all();
    const budget = Number(process.env.COST_BUDGET_USD || 1);
    return {
      total_calls: total.n,
      total_cost_usd: total.t,
      budget_usd: budget,
      budget_exceeded: total.t >= budget,
      by_operation: byOperation,
      by_provider: byProvider,
    };
  }

  /** Budget guard: throws before a call is made if the budget is exhausted. */
  assertWithinBudget() {
    const budget = Number(process.env.COST_BUDGET_USD || 1);
    const total = this.totalThisMonth();
    if (total >= budget) throw new BudgetExceededError(total, budget);
    return { total, budget };
  }
}

module.exports = { CostTracker, BudgetExceededError };
