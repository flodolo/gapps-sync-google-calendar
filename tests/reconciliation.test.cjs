const assert = require('node:assert/strict');
const {context, runner} = require('./helpers.cjs');

const {test, done} = runner();
const clone = (value) => JSON.parse(JSON.stringify(value));
const previousRun = '2026-09-09T08:00:00.000Z';
const away = (id = 'source') => ({
  id, iCalUID: `${id}@example.com`, summary: 'PTO', eventType: 'outOfOffice',
  start: {dateTime: '2026-09-15T09:00:00Z'},
  end: {dateTime: '2026-09-15T17:00:00Z'},
  updated: '2026-09-10T07:00:00Z',
});

function fixture(mode) {
  const ctx = context(['sync-team-calendar.js', 'publish-my-time-off.js'],
    ['TEAM_CALENDAR_IDS', 'PUBLISH_CALENDAR_IDS']);
  const {c, state, config} = ctx;
  const calendar = config.TEAM_CALENDAR_IDS[0];
  config.PUBLISH_CALENDAR_IDS.push(calendar);
  const email = mode === 'team' ? 'alice@example.com' : 'me@example.com';
  const key = `${mode === 'team' ? 'lastRun' : 'lastPublish'}:${calendar}:${email}`;
  const copies = new Map();
  let sources = [];
  const requests = [];
  c.Calendar.Events.list = (id, params) => {
    requests.push({id, ...params});
    if (id === calendar) return {items: clone([...copies.values()])};
    // Other members may legitimately be on the ACL; only the fixture's own
    // person has source events.
    if (id !== email) return {items: []};
    return {items: clone(sources.filter((event) =>
      (!params.updatedMin || event.updated > params.updatedMin) &&
      (!params.timeMin || event.status === 'cancelled' ||
        event.recurrence || new Date(event.end.dateTime) > new Date(params.timeMin)) &&
      (!params.timeMax || event.status === 'cancelled' ||
        event.recurrence || new Date(event.start.dateTime) < new Date(params.timeMax))))};
  };
  c.Calendar.Events.import = (event, id) => {
    assert.equal(id, calendar);
    const copy = {...clone(event), id: `copy-${event.id}`};
    state.imports.push(copy);
    copies.set(copy.id, copy);
    return clone(copy);
  };
  c.Calendar.Events.remove = (id, eventId) => {
    assert.equal(id, calendar);
    state.removed.push(eventId);
    copies.delete(eventId);
  };
  const copy = (event = away(), owner = email) => {
    const result = {...clone(event), id: `copy-${event.id}`, summary: '[alice] Away',
      extendedProperties: {private: {awaySource: `${owner}/${event.id}`}}};
    copies.set(result.id, result);
    return result;
  };
  return {...ctx, calendar, email, key, copies, requests, copy,
    setSources(events) { sources = events; },
    sync(options = {}) { (mode === 'team' ? c.runSync : c.runPublish)(options); },
  };
}

for (const mode of ['team', 'publish']) {
  for (const date of ['2027-02-01', '2026-08-01']) {
    test(`${mode}: incremental sync removes a copy moved to ${date}`, () => {
      const f = fixture(mode);
      f.copy();
      f.state.properties[f.key] = previousRun;
      f.setSources([{...away(), start: {dateTime: `${date}T09:00:00Z`},
        end: {dateTime: `${date}T17:00:00Z`}}]);
      f.sync();
      assert.deepEqual(f.state.removed, ['copy-source']);
      assert.equal(f.state.imports.length, 0);
      assert.notEqual(f.state.properties[f.key], previousRun);
      const request = f.requests.find((item) => item.id === f.email);
      assert.equal(request.updatedMin, previousRun);
      assert.equal(request.timeMin, undefined);
      assert.equal(request.timeMax, undefined);
    });
  }

  test(`${mode}: full sync repairs stale copies and preserves unrelated and historical events`, () => {
    const f = fixture(mode);
    f.copy();
    f.copy({...away('old'), start: {dateTime: '2026-08-01T09:00:00Z'},
      end: {dateTime: '2026-08-01T17:00:00Z'}});
    f.copy(away('someone-else'), 'other@example.com');
    f.copies.set('manual', {...away('manual'), summary: '[alice] Away'});
    f.copy(away('still-present'));
    f.setSources([away('still-present'), {...away(),
      start: {dateTime: '2027-02-01T09:00:00Z'}, end: {dateTime: '2027-02-01T17:00:00Z'}}]);
    f.state.properties[f.key] = previousRun;
    f.sync({ignoreLastRun: true});
    assert.deepEqual(f.state.removed, ['copy-source']);
    assert.equal(f.copies.size, 4);
    assert.equal(f.requests.filter((item) => item.id === f.calendar).length, 1);
  });

  test(`${mode}: dry-run reconciliation logs removals without writes`, () => {
    const f = fixture(mode);
    f.copy();
    f.state.properties[f.key] = previousRun;
    f.sync({ignoreLastRun: true, dryRun: true});
    assert.deepEqual(f.state.removed, []);
    assert.equal(f.state.imports.length, 0);
    assert.equal(f.state.properties[f.key], previousRun);
    assert.ok(f.state.logs.some((line) => line.startsWith('Would remove:')));
  });

  test(`${mode}: failed reconciliation keeps the checkpoint and retries`, () => {
    const f = fixture(mode);
    f.copy();
    f.state.properties[f.key] = previousRun;
    const remove = f.c.Calendar.Events.remove;
    f.c.Calendar.Events.remove = () => { throw Error('503'); };
    assert.throws(() => f.sync({ignoreLastRun: true}), /failed/);
    assert.equal(f.state.properties[f.key], previousRun);
    assert.equal(f.state.released, 1);
    f.c.Calendar.Events.remove = remove;
    f.sync({ignoreLastRun: true});
    assert.deepEqual(f.state.removed, ['copy-source']);
    assert.notEqual(f.state.properties[f.key], previousRun);
  });

  for (const allDay of [false, true]) {
    test(`${mode}: cancels only the ${allDay ? 'converted all-day' : 'timed'} recurring occurrence`, () => {
      const f = fixture(mode);
      const master = f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']});
      if (allDay) {
        master.start = {date: '2026-09-15'};
        master.end = {date: '2026-09-16'};
      }
      f.state.properties[f.key] = previousRun;
      f.setSources([{id: 'series_exception', recurringEventId: 'series', status: 'cancelled',
        originalStartTime: {dateTime: allDay ? '2026-09-15T00:00:00+02:00' : '2026-09-15T09:00:00Z',
          timeZone: allDay ? 'Europe/Berlin' : 'UTC'}, updated: '2026-09-10T07:00:00Z'}]);
      let pages = 0;
      f.c.Calendar.Events.instances = (id, seriesId, params) => {
        assert.equal(id, f.calendar);
        assert.equal(seriesId, 'copy-series');
        assert.equal(params.originalStart, allDay ? '2026-09-15' : '2026-09-15T09:00:00Z');
        pages++;
        return params.pageToken ? {items: [{id: 'destination-occurrence'}]} :
          {items: [], nextPageToken: 'second'};
      };
      f.sync();
      assert.equal(pages, 2);
      assert.deepEqual(f.state.removed, ['destination-occurrence']);
      assert.ok(f.copies.has('copy-series'));
      assert.notEqual(f.state.properties[f.key], previousRun);
    });
  }

  test(`${mode}: new series is imported before its cancellation and added to the cached index`, () => {
    const f = fixture(mode);
    f.setSources([
      {id: 'series_exception', recurringEventId: 'series', status: 'cancelled',
        originalStartTime: {dateTime: '2026-09-15T09:00:00Z'}},
      {...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']},
    ]);
    f.c.Calendar.Events.instances = (id, seriesId) => {
      assert.equal(seriesId, 'copy-series');
      assert.ok(f.copies.has(seriesId));
      return {items: [{id: 'destination-occurrence'}]};
    };
    f.sync({ignoreLastRun: true});
    assert.deepEqual(f.state.removed, ['destination-occurrence']);
    assert.equal(f.requests.filter((item) => item.id === f.calendar).length, 1);
  });

  test(`${mode}: recurring lookup failures preserve the checkpoint`, () => {
    const f = fixture(mode);
    f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']});
    f.state.properties[f.key] = previousRun;
    f.setSources([{id: 'series_exception', recurringEventId: 'series', status: 'cancelled',
      originalStartTime: {dateTime: '2026-09-15T09:00:00Z'}, updated: '2026-09-10T07:00:00Z'}]);
    f.c.Calendar.Events.instances = () => { throw Error('503'); };
    assert.throws(() => f.sync(), /failed/);
    assert.equal(f.state.properties[f.key], previousRun);
    assert.deepEqual(f.state.removed, []);
  });

  test(`${mode}: recurring dry run and deletion failure leave the checkpoint intact`, () => {
    const f = fixture(mode);
    f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']});
    f.state.properties[f.key] = previousRun;
    f.setSources([{id: 'series_exception', recurringEventId: 'series', status: 'cancelled',
      originalStartTime: {dateTime: '2026-09-15T09:00:00Z'}, updated: '2026-09-10T07:00:00Z'}]);
    f.c.Calendar.Events.instances = () => ({items: [{id: 'destination-occurrence'}]});
    f.sync({dryRun: true});
    assert.deepEqual(f.state.removed, []);
    assert.equal(f.state.properties[f.key], previousRun);
    assert.ok(f.state.logs.some((line) => line.includes('Would remove:') &&
      line.includes('destination-occurrence')));
    f.c.Calendar.Events.remove = () => { throw Error('503'); };
    assert.throws(() => f.sync(), /failed/);
    assert.equal(f.state.properties[f.key], previousRun);
  });

  test(`${mode}: incomplete full source scan never deletes destination copies`, () => {
    const f = fixture(mode);
    f.copy();
    f.state.properties[f.key] = previousRun;
    f.c.Calendar.Events.list = (id, params) => {
      assert.equal(id, f.email);
      if (params.pageToken) throw Error('503');
      return {items: [], nextPageToken: 'second'};
    };
    assert.throws(() => f.sync({ignoreLastRun: true}), /failed/);
    assert.deepEqual(f.state.removed, []);
    assert.equal(f.state.properties[f.key], previousRun);
  });

  test(`${mode}: full reconciliation retains completed recurring series`, () => {
    const f = fixture(mode);
    f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260801T090000Z']});
    f.c.Calendar.Events.instances = () => ({items: []});
    f.sync({ignoreLastRun: true});
    assert.deepEqual(f.state.removed, []);
    assert.ok(f.copies.has('copy-series'));
  });

  test(`${mode}: reconciliation uses the destination time zone for all-day copies`, () => {
    const f = fixture(mode);
    f.copy({...away(), start: {date: '2026-09-09'}, end: {date: '2026-09-10'}});
    const list = f.c.Calendar.Events.list;
    f.c.Calendar.Events.list = (id, params) => ({...list(id, params), timeZone: 'Pacific/Honolulu'});
    f.sync({ignoreLastRun: true});
    // At the frozen clock (Sep 10 08:00 UTC), it is still Sep 9 in Honolulu.
    assert.deepEqual(f.state.removed, ['copy-source']);
  });

  test(`${mode}: updated recurring series uses occurrences to check the scan window`, () => {
    const f = fixture(mode);
    const series = {...away('series'), recurrence: ['RRULE:FREQ=WEEKLY'],
      start: {dateTime: '2020-01-01T09:00:00Z'}, end: {dateTime: '2020-01-01T17:00:00Z'}};
    f.copy(series);
    f.state.properties[f.key] = previousRun;
    f.setSources([series]);
    // The source series and its copy are asked about separately: the copy has
    // its own recurrence, so it can still be generating occurrences the source
    // no longer covers. That, not the source alone, is what makes it stale.
    let active = true;
    let copyActive = true;
    f.c.Calendar.Events.instances = (id, seriesId, params) => {
      assert.ok(params.timeMin && params.timeMax);
      if (id === f.calendar) {
        assert.equal(seriesId, 'copy-series');
        return {items: copyActive ? [away('copy-occurrence')] : []};
      }
      assert.equal(id, f.email);
      assert.equal(seriesId, 'series');
      return {items: active ? [away('occurrence')] : []};
    };
    f.sync();
    assert.equal(f.state.imports.length, 1);
    assert.deepEqual(f.state.removed, []);
    // Source no longer in the window while the copy still shows occurrences
    // there: the copy is advertising time off that is not happening.
    active = false;
    f.state.properties[f.key] = previousRun;
    f.sync();
    assert.deepEqual(f.state.removed, ['copy-series']);
  });
}

test('departed members lose future copies and recurring series, but history and unrelated events remain', () => {
  const f = fixture('team');
  f.state.properties[f.key] = previousRun;
  f.copy();
  f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY'],
    start: {dateTime: '2020-01-01T09:00:00Z'}, end: {dateTime: '2020-01-01T17:00:00Z'}});
  f.copy({...away('history'), start: {dateTime: '2026-08-01T09:00:00Z'},
    end: {dateTime: '2026-08-01T17:00:00Z'}});
  f.copy(away('other'), 'bob@example.com');
  f.copies.set('manual', away('manual'));
  f.c.getCalendarEditors = () => ['carol@example.com'];
  f.c.Calendar.Events.instances = (id, seriesId, params) => {
    assert.equal(id, f.calendar);
    assert.equal(seriesId, 'copy-series');
    assert.equal(params.timeMax, undefined);
    return {items: [away('occurrence')]};
  };
  f.sync();
  assert.deepEqual(f.state.removed, ['copy-source', 'copy-series']);
  assert.equal(f.state.properties[f.key], undefined);
  assert.equal(f.copies.size, 3);
  // The departed member's own calendar is never read; the remaining member's
  // is, because they are still being synced.
  assert.ok(f.requests.every((item) => item.id !== f.email));
});

test('departed-member dry run preserves events and checkpoint', () => {
  const f = fixture('team');
  f.copy();
  f.state.properties[f.key] = previousRun;
  f.c.getCalendarEditors = () => ['carol@example.com'];
  f.sync({dryRun: true});
  assert.deepEqual(f.state.removed, []);
  assert.equal(f.state.properties[f.key], previousRun);
  assert.ok(f.state.logs.some((line) => line.startsWith('Would remove:')));
});

test('failed departed-member cleanup retains its checkpoint, permits active members, and retries', () => {
  const f = fixture('team');
  const departed = `lastRun:${f.calendar}:departed@example.com`;
  f.state.properties[departed] = previousRun;
  f.copy(away('departed'), 'departed@example.com');
  const remove = f.c.Calendar.Events.remove;
  f.c.Calendar.Events.remove = () => { throw Error('503'); };
  assert.throws(() => f.sync(), /failed/);
  assert.equal(f.state.properties[departed], previousRun);
  assert.ok(f.state.properties[f.key]);
  f.c.Calendar.Events.remove = remove;
  f.sync();
  assert.deepEqual(f.state.removed, ['copy-departed']);
  assert.equal(f.state.properties[departed], undefined);
});

test('departure preserves copies still managed by publishing to the same destination', () => {
  const f = fixture('team');
  f.copy();
  f.state.properties[f.key] = previousRun;
  f.state.properties[`lastPublish:${f.calendar}:${f.email}`] = previousRun;
  f.c.getCalendarEditors = () => ['carol@example.com'];
  f.sync();
  assert.deepEqual(f.state.removed, []);
  // The checkpoint is the only thing that triggers this cleanup, so skipping
  // the removal must not discard it: if publishing to this calendar stops
  // later, the copies have to remain reclaimable.
  assert.equal(f.state.properties[f.key], previousRun);
});

test('departed-member cleanup preserves a completed recurring series', () => {
  const f = fixture('team');
  f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260801T090000Z']});
  f.state.properties[f.key] = previousRun;
  f.c.getCalendarEditors = () => ['carol@example.com'];
  f.c.Calendar.Events.instances = () => ({items: []});
  f.sync();
  assert.deepEqual(f.state.removed, []);
  assert.equal(f.state.properties[f.key], undefined);
});

// Regression tests for the findings of the code review of this change.

for (const mode of ['team', 'publish']) {
  test(`${mode}: editing a past event keeps its historical copy`, () => {
    const f = fixture(mode);
    const past = {...away(), start: {dateTime: '2026-08-03T09:00:00Z'},
      end: {dateTime: '2026-08-03T17:00:00Z'}};
    f.copy(past);
    f.state.properties[f.key] = previousRun;
    // Same dates, only the title touched, so the copy still records the truth.
    f.setSources([{...past, summary: 'PTO (booked)'}]);
    f.sync();
    assert.deepEqual(f.state.removed, []);
    assert.equal(f.state.imports.length, 0);
    assert.ok(f.state.logs.some((line) =>
      line.startsWith('Outside the scan window, copy left in place')));
  });

  test(`${mode}: an event moved into the past still loses its stale copy`, () => {
    const f = fixture(mode);
    f.copy();   // copy sits at 2026-09-15, inside the window
    f.state.properties[f.key] = previousRun;
    f.setSources([{...away(), start: {dateTime: '2026-08-01T09:00:00Z'},
      end: {dateTime: '2026-08-01T17:00:00Z'}}]);
    f.sync();
    assert.deepEqual(f.state.removed, ['copy-source']);
  });

  test(`${mode}: a timed event that ended earlier today keeps its copy`, () => {
    const f = fixture(mode);
    // The clock is frozen at 2026-09-10T08:00Z; this ended at 07:00Z.
    const earlier = {...away(), start: {dateTime: '2026-09-10T06:00:00Z'},
      end: {dateTime: '2026-09-10T07:00:00Z'}};
    f.copy(earlier);
    f.state.properties[f.key] = previousRun;
    f.setSources([earlier]);
    f.sync();
    assert.deepEqual(f.state.removed, []);
  });
}

test('an ACL with no individual users never triggers departed-member cleanup', () => {
  const f = fixture('team');
  f.copy();
  f.state.properties[f.key] = previousRun;
  // Sharing switched to a group, or MEMBER_ROLES narrowed: indistinguishable
  // from the whole team leaving, so acting on it would strip the calendar.
  f.c.getCalendarEditors = () => [];
  f.sync();
  assert.deepEqual(f.state.removed, []);
  assert.equal(f.state.properties[f.key], previousRun);
  assert.ok(f.state.logs.some((line) => line.includes('returned no individual')));
});

test('a malformed recurring exception warns instead of stalling the member', () => {
  const f = fixture('team');
  const series = {...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']};
  f.copy({...series, start: {date: '2026-09-15'}, end: {date: '2026-09-16'}});
  f.state.properties[f.key] = previousRun;
  f.setSources([
    series,
    // An exception whose originalStartTime cannot be resolved to a date.
    {...away('occurrence'), status: 'cancelled', recurringEventId: 'series',
      originalStartTime: {dateTime: 'not-a-date'}},
  ]);
  f.c.Calendar.Events.instances = () => ({items: []});
  // Must not throw: the checkpoint has to advance or the member never syncs.
  f.sync();
  assert.notEqual(f.state.properties[f.key], previousRun);
});

test('a dry run reports the occurrence it would remove from a new series', () => {
  const f = fixture('publish');
  const series = {...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']};
  f.setSources([
    series,
    {...away('occurrence'), status: 'cancelled', recurringEventId: 'series',
      originalStartTime: {dateTime: '2026-09-22T09:00:00Z'}},
  ]);
  f.sync({dryRun: true, ignoreLastRun: true});
  assert.equal(f.state.imports.length, 0);
  assert.equal(f.state.removed.length, 0);
  assert.ok(f.state.logs.some((line) => line.startsWith('Would import as Free')));
  // Previously silent: the series only exists in this same dry run.
  assert.ok(f.state.logs.some((line) =>
    line.startsWith('Would remove the 2026-09-22T09:00:00Z occurrence')));
});

test('a dry run reports each removal once, not once per path', () => {
  const f = fixture('team');
  f.copy();
  f.state.properties[f.key] = previousRun;
  f.setSources([{...away(), status: 'cancelled'}]);
  f.sync({dryRun: true});
  const reported = f.state.logs.filter((line) => line.startsWith('Would remove:'));
  assert.equal(reported.length, 1);
  assert.deepEqual(f.state.removed, []);
});

for (const mode of ['team', 'publish']) {
  // A moved occurrence's copy is part of the imported series, so it is not
  // reachable by the exception's own id.
  const movedOccurrence = (start, end) => ({
    ...away('occurrence'), recurringEventId: 'series',
    originalStartTime: {dateTime: '2026-09-15T09:00:00Z'},
    start: {dateTime: start}, end: {dateTime: end},
  });
  const seriesFixture = (mode) => {
    const f = fixture(mode);
    f.copy({...away('series'), recurrence: ['RRULE:FREQ=WEEKLY']});
    f.state.properties[f.key] = previousRun;
    f.c.Calendar.Events.instances = (id, seriesId, params) => {
      assert.equal(id, f.calendar);
      assert.equal(seriesId, 'copy-series');
      if (!params.originalStart) return {items: []};
      return {items: [{id: 'copy-occurrence', summary: '[alice] Away',
        start: {dateTime: params.originalStart}, end: {dateTime: params.originalStart}}]};
    };
    return f;
  };

  test(`${mode}: an occurrence moved out of the window loses its old copy`, () => {
    const f = seriesFixture(mode);
    f.setSources([movedOccurrence('2027-02-01T09:00:00Z', '2027-02-01T17:00:00Z')]);
    f.sync();
    assert.deepEqual(f.state.removed, ['copy-occurrence']);
  });

  test(`${mode}: an occurrence edited in place keeps its copy`, () => {
    const f = seriesFixture(mode);
    // Same slot as originalStartTime, but in the past and merely retitled.
    f.setSources([{...movedOccurrence('2026-09-15T09:00:00Z', '2026-09-15T17:00:00Z'),
      originalStartTime: {dateTime: '2026-09-15T09:00:00Z'}, summary: 'PTO (confirmed)'}]);
    f.sync();
    assert.deepEqual(f.state.removed, []);
  });
}

done();
