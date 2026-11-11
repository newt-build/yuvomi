/**
 * Port of AgentOS packages/family/src/timer-plan.ts.
 * Keep the Family allocation semantics: compress once at start, proportionally
 * to elasticity; never shrink fixed steps or cross compressible minima.
 * Flexible duration stays unknown. Optional play is remaining time, not work
 * a child must confirm. Input is a validated server-owned routine snapshot.
 *
 * This is the planner only: it does not persist runs, authenticate a device,
 * complete a mission or award points.
 */

function toEpochSeconds(value) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid plan instant');
  return Math.floor(milliseconds / 1000);
}

export function isStepReduced(step, assignedSeconds) {
  return step.durationClass === 'compressible'
    && step.plannedSeconds !== null
    && assignedSeconds < step.plannedSeconds;
}

export function planRoutine(steps, options) {
  const deadline = toEpochSeconds(options.deadline);
  const start = toEpochSeconds(options.start);
  const required = steps.filter(step => step.durationClass === 'fixed' || step.durationClass === 'compressible');
  const plannedTotal = required.reduce((sum, step) => sum + (step.durationClass === 'compressible' ? (step.plannedSeconds ?? 0) : (step.durationSeconds ?? 0)), 0);
  const minimumTotal = required.reduce((sum, step) => sum + (step.durationClass === 'compressible' ? (step.minimumSeconds ?? 0) : (step.durationSeconds ?? 0)), 0);
  const compressionStartsAt = deadline - plannedTotal;
  const available = deadline - start;
  const deficit = Math.max(0, plannedTotal - available);
  const overrunsDeadline = deficit > 0 && available < minimumTotal;
  const reductionsToApply = Math.min(deficit, plannedTotal - minimumTotal);
  const elastic = required.map(step => step.durationClass === 'compressible'
    ? Math.max(0, (step.plannedSeconds ?? 0) - (step.minimumSeconds ?? 0))
    : 0);
  const totalElastic = elastic.reduce((sum, amount) => sum + amount, 0);
  const allocated = elastic.map(amount => totalElastic === 0 ? 0 : Math.floor(reductionsToApply * amount / totalElastic));
  let remainder = reductionsToApply - allocated.reduce((sum, amount) => sum + amount, 0);
  const ranking = elastic.map((amount, index) => ({ index, remainder: totalElastic === 0 ? 0 : (reductionsToApply * amount) % totalElastic }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of ranking) {
    if (remainder === 0) break;
    if (allocated[item.index] < elastic[item.index]) {
      allocated[item.index]++;
      remainder--;
    }
  }
  const summaries = required.map((step, index) => {
    const plannedSeconds = step.durationClass === 'compressible' ? (step.plannedSeconds ?? 0) : (step.durationSeconds ?? 0);
    const durationSeconds = plannedSeconds - allocated[index];
    return { step, durationSeconds, plannedSeconds, isReduced: isStepReduced(step, durationSeconds) };
  });
  const assignedTotal = summaries.reduce((sum, step) => sum + step.durationSeconds, 0);
  const optionalPlaySeconds = overrunsDeadline ? 0 : Math.max(0, available - assignedTotal);
  return {
    steps: summaries,
    optionalPlaySeconds,
    compressionStartsAt,
    overrunsDeadline,
    flexibleStepsMakeEstimateUpperBound: steps.some(step => step.durationClass === 'flexible'),
  };
}
