/**
 * Cost tracking + budget guard tests (shared requirement #7).
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, repos } = require('./helpers');
const { CostTracker, BudgetExceededError } = require('../src/services/cost');

before(async () => {
  await setupTestDb();
});

test('summary aggregates every call by operation and provider', () => {
  const s = new CostTracker('default').summary();
  assert.ok(s.total_calls >= 61, `expected >= 61 logged calls (56 vision + 5 embed batches), got ${s.total_calls}`);
  const vision = s.by_operation.find((o) => o.operation === 'vision');
  const embedding = s.by_operation.find((o) => o.operation === 'embedding');
  assert.ok(vision && vision.calls >= 56);
  assert.ok(embedding && embedding.calls >= 5);
  assert.equal(s.budget_exceeded, false);
});

test('logCall attributes provider/model/operation/entity and is idempotent on call_id', () => {
  const ct = new CostTracker('default');
  const entry = {
    callId: 'test-call-idempotent-1', provider: 'fixture', model: 'fixture',
    operation: 'vision', entityRef: 'img-test', inputUnits: 1, costUsd: 0,
  };
  ct.logCall(entry);
  ct.logCall(entry); // duplicate call_id must NOT create a second row
  const rows = repos.recentCostCalls(200).filter((r) => r.call_id === 'test-call-idempotent-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'fixture');
  assert.equal(rows[0].operation, 'vision');
  assert.equal(rows[0].entity_ref, 'img-test');
});

test('budget guard refuses new calls once the budget is exhausted', () => {
  const ct = new CostTracker('default');
  process.env.COST_BUDGET_USD = '0';
  try {
    assert.throws(() => ct.assertWithinBudget(), (e) => e instanceof BudgetExceededError || e.code === 'BUDGET_EXCEEDED');
  } finally {
    delete process.env.COST_BUDGET_USD;
  }
});

test('monthly window: totalThisMonth only counts this month (sanity, non-negative)', () => {
  const ct = new CostTracker('default');
  const total = ct.totalThisMonth();
  assert.ok(Number.isFinite(total) && total >= 0);
});
