/** Native routine catalogue and daily occurrence projection, with no legacy backend writer. */
import { householdMemberSql, memberOrderSql } from './household-members.js';
import { personAvatarUrlSql } from './person-avatar.js';
import { shiftDateKey, utcToWall } from '../utils/timezone.js';
import { TimerError } from './family-timer-store.js';

function civilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new TimerError(400, 'timer_invalid_range', 'Intervallo del timer non valido.');
  }
  return value;
}

/** Reject a missing or repeated wall-clock instant, as the original routine's policy requires. */
function localInstant(date, clock, timezone) {
  const wall = `${date}T${clock}:00`;
  const naive = Date.parse(wall + 'Z');
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = naive + hours * 3600000;
    const parts = utcToWall(new Date(sample).toISOString(), timezone);
    if (parts) offsets.add(Date.parse(`${parts.date}T${parts.time}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(candidate => {
    const parts = utcToWall(new Date(candidate).toISOString(), timezone);
    return parts && `${parts.date}T${parts.time}` === wall;
  });
  if (candidates.length !== 1) throw new TimerError(422, 'timer_ambiguous_time', 'Orario locale inesistente o ambiguo: serve una verifica adulta.');
  return new Date(candidates[0]).toISOString();
}

/** Fail closed rather than silently approximating recurrence semantics not yet ported. */
export function validateTimerRecurrence(value) {
  if (!value || value.rule !== 'FREQ=DAILY' || value.dstPolicy !== 'reject' || value.quota !== null
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)
    || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440
    || !Array.isArray(value.exceptions) || !Array.isArray(value.rdates) || !Array.isArray(value.excludedOccurrences)) {
    throw new TimerError(422, 'timer_recurrence_unsupported', 'La ricorrenza richiede un port esplicito prima dell’attivazione.');
  }
  civilDate(value.fromDate);
  if (value.untilDate !== null) civilDate(value.untilDate);
  for (const valueDate of value.exceptions) civilDate(valueDate);
  for (const extra of [...value.rdates, ...value.excludedOccurrences]) {
    civilDate(extra.slice(0, 10));
    if (extra.length !== 10 && !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(extra)) {
      throw new TimerError(422, 'timer_recurrence_unsupported', 'Eccezione di ricorrenza non supportata.');
    }
  }
  return value;
}

export function readNativeTimerScope(database, { from, to, deadline, now = new Date() } = {}) {
  const members = database.prepare(`SELECT u.id,u.display_name AS label,${personAvatarUrlSql('u')} AS avatar
    FROM users u WHERE ${householdMemberSql('u')} ORDER BY ${memberOrderSql('u')}`).all();
  const allowed = new Set(members.map(member => member.id));
  const records = database.prepare('SELECT * FROM family_timer_routines WHERE enabled=1 ORDER BY label,id').all();
  const routines = [];
  const reportable = new Set();
  for (const record of records) {
    const recurrence = validateTimerRecurrence(JSON.parse(record.recurrence));
    const zoneDay = utcToWall(deadline ?? now.toISOString(), record.timezone)?.date;
    const startDate = civilDate(from ?? zoneDay);
    const endDate = civilDate(to ?? shiftDateKey(startDate, deadline ? 1 : 3));
    const days = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000;
    if (days < 1 || days > 31) throw new TimerError(400, 'timer_invalid_range', 'Scegli un intervallo fino a 31 giorni.');
    const subjects = database.prepare('SELECT user_id,source_subject_id FROM family_timer_subjects WHERE routine_id=? ORDER BY user_id')
      .all(record.id).filter(subject => allowed.has(subject.user_id));
    const steps = JSON.parse(record.steps);
    for (let date = startDate; date < endDate; date = shiftDateKey(date, 1)) {
      const included = new Set();
      if (date >= recurrence.fromDate && (recurrence.untilDate === null || date <= recurrence.untilDate)) included.add(recurrence.localTime);
      for (const extra of recurrence.rdates) if (extra.slice(0, 10) === date) included.add(extra.length === 10 ? recurrence.localTime : extra.slice(11));
      if (recurrence.exceptions.includes(date) || recurrence.excludedOccurrences.includes(date)) continue;
      for (const clock of [...included].sort()) {
        if (recurrence.excludedOccurrences.includes(`${date}T${clock}`)) continue;
        const start = localInstant(date, clock, record.timezone);
        const exit = new Date(Date.parse(start) + recurrence.durationMinutes * 60000).toISOString();
        for (const subject of subjects) {
          reportable.add(subject.user_id);
          routines.push({
            routineId: record.id, routineVersion: record.version, revision: record.version,
            occurrenceKey: `${date}T${clock}:${recurrence.dstPolicy}:${subject.source_subject_id}`,
            label: record.label, timezone: record.timezone, start, deadline: exit,
            steps, subjectIds: [subject.user_id], actions: ['report_done'],
          });
        }
      }
    }
  }
  return { routines, members: members.filter(member => reportable.has(member.id)).map(member => ({ ...member, reportable: true })) };
}
