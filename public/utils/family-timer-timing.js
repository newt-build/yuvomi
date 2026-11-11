/** Port of Family timing.ts: pure projections from a persisted, immutable run. */
export function readTimerTiming(run, now) {
  const currentIndex = run.completions.length;
  const step = run.routine.steps[currentIndex];
  let currentStep = null;
  if (step) {
    const startedAt = currentIndex === 0 ? run.startedAt : run.completions[currentIndex - 1].completedAt;
    const elapsedSeconds = Math.max(0, (now - Date.parse(startedAt)) / 1000);
    currentStep = step.durationSeconds === null
      ? { step, kind: 'flexible', elapsedSeconds, plannedSeconds: null, remainingSeconds: null, overrunSeconds: null }
      : { step, kind: 'fixed', elapsedSeconds, plannedSeconds: step.durationSeconds,
        remainingSeconds: Math.max(0, step.durationSeconds - elapsedSeconds),
        overrunSeconds: Math.max(0, elapsedSeconds - step.durationSeconds) };
  }
  let remainingFixedSeconds = currentStep?.kind === 'fixed' ? currentStep.remainingSeconds : 0;
  let remainingFlexibleSteps = currentStep?.kind === 'flexible' ? 1 : 0;
  for (let index = currentIndex + 1; index < run.routine.steps.length; index++) {
    const duration = run.routine.steps[index].durationSeconds;
    if (duration === null) remainingFlexibleSteps++;
    else remainingFixedSeconds += duration;
  }
  const remainingSeconds = Math.max(0, (Date.parse(run.routine.deadline) - now) / 1000);
  const requiredStepsCompleted = currentIndex === run.routine.steps.length;
  return {
    deadlineRemainingSeconds: remainingSeconds,
    deadlineLatenessSeconds: Math.max(0, (now - Date.parse(run.routine.deadline)) / 1000),
    currentIndex, currentStep, requiredStepsCompleted,
    forecast: { freeSeconds: Math.max(0, remainingSeconds - remainingFixedSeconds),
      kind: requiredStepsCompleted ? 'available' : remainingFlexibleSteps > 0 ? 'upper-bound' : 'planned',
      remainingFixedSeconds, remainingFlexibleSteps },
    optionalPlaySeconds: requiredStepsCompleted ? remainingSeconds : 0,
    completedAt: run.completedAt, withinDeadline: run.withinDeadline,
  };
}
export function formatTimerDuration(seconds) {
  const whole = Math.ceil(Math.abs(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');
  const sign = seconds < 0 ? '-' : '';
  return hours > 0 ? `${sign}${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${sign}${minutes}:${rest}`;
}
export function illustrationForStep(label) {
  return [
    [/\b(viso|faccia|lava(ti)? il viso)\b/i, 'face-wash'],
    [/\b(colazione|mangia|merenda|latte|pane)\b/i, 'breakfast'],
    [/\b(denti|dental|spazzol)\b/i, 'toothbrush'],
    [/\b(vestit|maglia|pantaloni|scarpe|divisa)\b/i, 'dressed'],
    [/\b(gioco|giocare|tempo libero|lego|disegn)\b/i, 'free-play'],
  ].find(([pattern]) => pattern.test(label))?.[1] ?? 'generic-step';
}
