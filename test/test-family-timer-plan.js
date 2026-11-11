import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoutine, isStepReduced } from '../server/services/family-timer-plan.js';

// The same behavioural cases used by AgentOS packages/family/test/timer-plan.test.ts.
const at = time => `2026-10-15T${time}:00+02:00`;
const deadline = at('07:45');
function step(id, durationClass, planned, minimumSeconds = null) {
  return { id, label: id, durationClass, durationSeconds: durationClass === 'fixed' ? planned : null,
    plannedSeconds: durationClass === 'compressible' ? planned : null, minimumSeconds, order: 0, illustration: 'generic-step' };
}
const steps = [step('wash', 'fixed', 300), step('teeth', 'fixed', 300),
  step('breakfast', 'compressible', 1200, 480), step('dress', 'compressible', 600, 180)];
const plan = time => planRoutine(steps, { start: at(time), deadline });
const durations = result => result.steps.map(value => value.durationSeconds);

test('early start leaves optional play without lengthening required steps', () => {
  assert.deepEqual(durations(plan('06:45')), [300, 300, 1200, 600]);
  assert.equal(plan('06:45').optionalPlaySeconds, 1200);
  assert.equal(plan('06:40').optionalPlaySeconds, 1500);
  assert.equal(plan('06:45').compressionStartsAt, Date.parse(at('07:05')) / 1000);
});
test('exact compression boundary does not reduce steps', () => {
  assert.deepEqual(durations(plan('07:05')), [300, 300, 1200, 600]);
  assert.equal(plan('07:05').optionalPlaySeconds, 0);
  assert.ok(plan('07:05').steps.every(value => !value.isReduced));
});
test('late start distributes reductions proportionally, not greedily per step', () => {
  assert.deepEqual(durations(plan('07:15')), [300, 300, 821, 379]);
  assert.equal(plan('07:15').optionalPlaySeconds, 0);
  assert.equal(plan('07:15').overrunsDeadline, false);
});
test('minimum fitting window respects fixed time and compressible floors', () => {
  assert.deepEqual(durations(plan('07:24')), [300, 300, 480, 180]);
  assert.equal(plan('07:24').overrunsDeadline, false);
});
test('too late is an explicit overrun, never a negative budget or shortened fixed step', () => {
  assert.deepEqual(durations(plan('07:30')), [300, 300, 480, 180]);
  assert.equal(plan('07:30').overrunsDeadline, true);
  assert.equal(plan('07:30').optionalPlaySeconds, 0);
  assert.deepEqual(durations(plan('07:50')), [300, 300, 480, 180]);
});
test('flexible remains unknown and optional play is not a required confirmation', () => {
  const mixed = planRoutine([...steps, step('play', 'optional', null), step('bag', 'flexible', null)], { start: at('06:45'), deadline });
  assert.equal(mixed.steps.length, 4);
  assert.equal(mixed.optionalPlaySeconds, 1200);
  assert.equal(mixed.flexibleStepsMakeEstimateUpperBound, true);
  assert.ok(mixed.steps.slice(0, 2).every(value => !isStepReduced(value.step, value.durationSeconds)));
});
test('invalid timestamps fail rather than inventing a deadline', () => {
  assert.throws(() => planRoutine(steps, { start: 'not-a-date', deadline }), RangeError);
  assert.throws(() => planRoutine(steps, { start: at('06:45'), deadline: NaN }), RangeError);
});
test('allocations remain bounded and conserve every second across the start window', () => {
  for (let available = -20; available <= 3000; available++) {
    const result = planRoutine(steps, { deadline: 4_000_000, start: 4_000_000 - available * 1000 });
    const assigned = durations(result);
    assert.deepEqual(assigned.slice(0, 2), [300, 300]);
    assert.ok(assigned[2] >= 480 && assigned[2] <= 1200);
    assert.ok(assigned[3] >= 180 && assigned[3] <= 600);
    assert.equal(assigned.reduce((a, b) => a + b, 0), Math.max(1260, Math.min(2400, available)));
    assert.equal(result.optionalPlaySeconds, Math.max(0, available - 2400));
  }
});
