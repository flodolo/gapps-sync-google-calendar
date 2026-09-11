// Based on: https://developers.google.com/apps-script/samples/automations/vacation-calendar
//
// Copyright 2022 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
//
// FJoseph Sep 10 2026: This code has been updated with Claude to fix a few issues
// 1. Enable teams across multiple timezones so events >= 12 hours are seen as all-day events
// 2. Optimization on string conversion
// 3. Pin V8 runtime and Google Calendar API library requirements

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

// The team calendar to write to. Find the ID on the calendar's settings page.
const TEAM_CALENDAR_ID = 'your-other-calendar-id@group.calendar.google.com';

// A single Google Group email, or an array of them:
//   const GROUP_EMAIL = ['team-a@example.com', 'team-b@example.com'];
// Keep each group under ~500 members to avoid timeouts.
const GROUP_EMAIL = 'addons-core-team@mozilla.com';

// true  = only direct members of the group(s)
// false = direct members plus members of nested groups
const ONLY_DIRECT_MEMBERS = false;

const MONTHS_IN_ADVANCE = 3;

// --- What gets imported ------------------------------------------- //

// An event is a candidate if its title contains one of these anywhere,
// case-insensitively.
const KEYWORDS = ['vacation', 'ooo', 'pto', 'wellness', 'holiday', 'on leave'];

// Also treat Google's native "Out of office" entries as candidates,
// regardless of their title.
const INCLUDE_OUT_OF_OFFICE_EVENTS = true;

// --- Full-day rule ------------------------------------------------- //

// Candidates must resolve to a full day. Events already marked all-day
// always qualify. Timed events qualify only at or above this duration,
// and are rewritten as all-day so they read correctly in every timezone.
const ALL_DAY_MIN_HOURS = 12;

// Append the original local times to the description when a long timed
// event is converted to all-day.
const NOTE_ORIGINAL_TIMES = true;

// --- Deletions ----------------------------------------------------- //

// Remove the team-calendar entry when the source event is deleted.
const PROPAGATE_DELETIONS = true;

// --- Timezones ----------------------------------------------------- //

// Used when a member's calendar timezone cannot be read. UTC is the
// least-wrong default for a distributed team; using the script timezone
// biases day boundaries toward one region.
const FALLBACK_TIME_ZONE = 'Etc/UTC';

// Manual overrides for members whose calendars are not readable.
// Keys are email addresses, values are IANA timezone ids.
const MEMBER_TIME_ZONES = {
  // 'kenji@example.com': 'Asia/Tokyo',
  // 'anna@example.com': 'Europe/Berlin',
};

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const MS_PER_HOUR = 60 * 60 * 1000;
const LAST_RUN_KEY = 'lastRun';

// Re-examine a few minutes either side of the last run so that events
// modified while the previous execution was in flight are not missed.
const SYNC_OVERLAP_MS = 5 * 60 * 1000;

/** @type {!Map<string, string>} Per-execution timezone cache. */
const timeZoneCache = new Map();

/* ------------------------------------------------------------------ *
 * Setup and maintenance
 * ------------------------------------------------------------------ */

/**
 * Sets up the script to run automatically every hour.
 */
function setup() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length > 0) {
    throw new Error('Triggers are already set up. Run removeTriggers() first.');
  }
  ScriptApp.newTrigger('sync').timeBased().everyHours(1).create();
  sync(); // Run the first sync immediately.
}

/**
 * Deletes every trigger owned by this project.
 */
function removeTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    ScriptApp.deleteTrigger(trigger);
  }
  console.log('All triggers removed.');
}

/**
 * Clears the incremental-sync watermark so the next run re-imports the full
 * date range. Run this after changing KEYWORDS or ALL_DAY_MIN_HOURS.
 */
function resetLastRun() {
  PropertiesService.getScriptProperties().deleteProperty(LAST_RUN_KEY);
  console.log('lastRun cleared. The next sync will do a full import.');
}

/**
 * Prints match results for sample titles, without touching any calendar.
 * Run this after editing KEYWORDS.
 */
function testKeywordMatching() {
  const samples = [
    'Vacation', 'PTO', 'PTO/Vacation', 'OOO', 'On leave', 'Holidays',
    'Wellness day', 'Annual holiday - Spain', 'Team standup', 'Design review',
  ];
  for (const summary of samples) {
    console.log('%s  %s',
      matchesKeyword({ summary: summary }) ? 'MATCH' : 'skip ', summary);
  }
}

/* ------------------------------------------------------------------ *
 * Main sync
 * ------------------------------------------------------------------ */

/**
 * Looks through the group members' calendars and copies qualifying leave
 * events into the shared team calendar.
 */
function sync() {
  const runStartedAt = new Date();

  const maxDate = new Date(runStartedAt.getTime());
  maxDate.setMonth(maxDate.getMonth() + MONTHS_IN_ADVANCE);

  const lastRun = readLastRun();

  const users = getTeamMembers();
  console.log('Syncing %s team member(s).', users.length);

  let imported = 0;
  let removed = 0;
  let ignored = 0;

  for (const user of users) {
    const email = user.getEmail();
    const username = email.split('@')[0];

    const events = findEvents(user, runStartedAt, maxDate, lastRun);
    if (events.length === 0) {
      continue;
    }

    // Only look up the timezone for members who actually have events.
    const userTimeZone = getUserTimeZone(email);

    for (const event of events) {
      const decision = classifyEvent(event, userTimeZone);

      if (decision.action === 'import') {
        if (importEvent(username, event, decision.span)) {
          imported++;
        } else {
          ignored++;
        }
      } else if (decision.action === 'delete') {
        if (removeFromTeamCalendar(event)) {
          removed++;
        } else {
          ignored++;
        }
      } else {
        ignored++;
      }
    }
  }

  // Store as an ISO 8601 string. Never store a Date object directly:
  // setProperty() coerces it with toString(), and re-parsing that format
  // is not guaranteed across runtime versions.
  PropertiesService.getScriptProperties()
    .setProperty(LAST_RUN_KEY, runStartedAt.toISOString());

  console.log('Imported %s, removed %s, ignored %s.', imported, removed, ignored);
}

/**
 * Reads the stored watermark, tolerating a missing or unparseable value.
 * @return {?Date} The adjusted watermark, or null for a full sync.
 */
function readLastRun() {
  const raw = PropertiesService.getScriptProperties().getProperty(LAST_RUN_KEY);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) {
    console.warn('Unparseable lastRun value "%s". Falling back to a full sync.', raw);
    return null;
  }
  return new Date(parsed.getTime() - SYNC_OVERLAP_MS);
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/**
 * Decides what to do with a source event.
 * @param {!Object} event The event resource.
 * @param {string} timeZone Fallback IANA timezone for the member.
 * @return {{action: string, span: (Object|undefined), reason: (string|undefined)}}
 */
function classifyEvent(event, timeZone) {
  if (event.status === 'cancelled') {
    if (!PROPAGATE_DELETIONS) {
      return { action: 'ignore', reason: 'cancelled' };
    }
    // Skip the team-calendar lookup when we can prove it was never imported.
    // Cancelled stubs often carry no summary, in which case we must check.
    const couldHaveBeenImported =
      !event.summary ||
      matchesKeyword(event) ||
      (INCLUDE_OUT_OF_OFFICE_EVENTS && event.eventType === 'outOfOffice');
    if (!couldHaveBeenImported) {
      return { action: 'ignore', reason: 'cancelled, never imported' };
    }
    return { action: 'delete' };
  }

  const isOutOfOffice =
    INCLUDE_OUT_OF_OFFICE_EVENTS && event.eventType === 'outOfOffice';
  if (!isOutOfOffice && !matchesKeyword(event)) {
    return { action: 'ignore', reason: 'no keyword, not out-of-office' };
  }

  if (!event.start || !event.end) {
    return { action: 'ignore', reason: 'no start/end' };
  }

  const span = resolveAllDaySpan(event, timeZone);
  if (!span) {
    return { action: 'ignore', reason: `under ${ALL_DAY_MIN_HOURS}h` };
  }
  return { action: 'import', span: span };
}

/**
 * @param {!Object} event An event resource.
 * @return {boolean} True if the title contains one of KEYWORDS.
 */
function matchesKeyword(event) {
  const summary = (event.summary || '').toLowerCase();
  if (!summary) {
    return false;
  }
  return KEYWORDS.some((keyword) => summary.includes(keyword.toLowerCase()));
}

/**
 * Resolves an event to an all-day span, or null if it does not qualify.
 *
 * Day boundaries are computed in the event owner's timezone, so a member in
 * Tokyo taking Monday off produces a Monday entry no matter where the viewer
 * is. The resulting all-day event carries no timezone at all.
 *
 * @param {!Object} event The event resource.
 * @param {string} defaultTimeZone Fallback IANA timezone.
 * @return {?Object} The span, or null if the event is too short.
 */
function resolveAllDaySpan(event, defaultTimeZone) {
  // Already all-day: the Calendar API represents these with `date`
  // rather than `dateTime`.
  if (event.start.date) {
    return {
      start: { date: event.start.date },
      end: { date: event.end.date },
      converted: false,
    };
  }

  const timeZone = event.start.timeZone || defaultTimeZone;
  const startTime = new Date(event.start.dateTime);
  const endTime = new Date(event.end.dateTime);
  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    return null;
  }

  const durationHours = (endTime.getTime() - startTime.getTime()) / MS_PER_HOUR;
  if (durationHours < ALL_DAY_MIN_HOURS) {
    return null;
  }

  const startDay = formatDayKey(startTime, timeZone);

  // All-day events use an EXCLUSIVE end date. An event finishing at 18:00 on
  // the 5th ends on the 6th; one finishing at exactly midnight on the 6th
  // already ends on the 6th.
  let endDay = formatDayKey(endTime, timeZone);
  if (!isLocalMidnight(endTime, timeZone)) {
    endDay = shiftDayKey(endDay, 1);
  }
  if (endDay <= startDay) { // ISO date strings compare correctly as strings.
    endDay = shiftDayKey(startDay, 1);
  }

  return {
    start: { date: startDay },
    end: { date: endDay },
    converted: true,
    timeZone: timeZone,
    originalStart: startTime,
    originalEnd: endTime,
  };
}

/* ------------------------------------------------------------------ *
 * Writing to the team calendar
 * ------------------------------------------------------------------ */

/**
 * Imports one qualifying event into the team calendar.
 * @param {string} username The team member attending the event.
 * @param {!Object} event The event resource to import.
 * @param {!Object} span The all-day span from resolveAllDaySpan().
 * @return {boolean} True if the event was imported.
 */
function importEvent(username, event, span) {
  event.summary = `[${username}] ${event.summary || 'Out of office'}`;
  event.organizer = { id: TEAM_CALENDAR_ID };
  event.attendees = [];

  // Prevent the shared calendar from notifying every subscriber.
  event.reminders = { useDefault: false, overrides: [] };

  // Only 'default' events can be imported.
  if (event.eventType !== 'default') {
    event.eventType = 'default';
    event.outOfOfficeProperties = undefined;
    event.focusTimeProperties = undefined;
  }

  if (span.converted && NOTE_ORIGINAL_TIMES) {
    const note = `Original time: ${formatLocal(span.originalStart, span.timeZone)} – ` +
      `${formatLocal(span.originalEnd, span.timeZone)} (${span.timeZone})`;
    event.description = event.description ?
      `${event.description}\n\n${note}` : note;
  }

  event.start = span.start;
  event.end = span.end;

  // A recurring instance's originalStartTime must use the same format,
  // otherwise the import is rejected.
  if (span.converted && event.originalStartTime &&
    event.originalStartTime.dateTime) {
    const original = new Date(event.originalStartTime.dateTime);
    if (!isNaN(original.getTime())) {
      event.originalStartTime = { date: formatDayKey(original, span.timeZone) };
    }
  }

  console.log('Importing: %s (%s to %s)',
    event.summary, span.start.date, span.end.date);
  try {
    Calendar.Events.import(event, TEAM_CALENDAR_ID);
    return true;
  } catch (e) {
    console.error('Error importing "%s": %s. Skipping.',
      event.summary, e.toString());
    return false;
  }
}

/**
 * Removes the team-calendar copy of a deleted source event, matched on
 * iCalUID, which Events.import preserves.
 * @param {!Object} event The cancelled source event.
 * @return {boolean} True if something was removed.
 */
function removeFromTeamCalendar(event) {
  if (!event.iCalUID) {
    return false;
  }
  try {
    const response = Calendar.Events.list(TEAM_CALENDAR_ID, {
      iCalUID: event.iCalUID,
      showDeleted: false,
      maxResults: 10,
    });
    const items = response.items || [];
    for (const item of items) {
      Calendar.Events.remove(TEAM_CALENDAR_ID, item.id);
      console.log('Removed: %s', item.summary);
    }
    return items.length > 0;
  } catch (e) {
    console.error('Error removing event %s: %s', event.iCalUID, e.toString());
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Reading member calendars
 * ------------------------------------------------------------------ */

/**
 * Returns every event in a member's calendar within the date range.
 * Filtering happens locally in classifyEvent(), because the API cannot
 * filter on duration and one unfiltered call is cheaper than several
 * narrower ones.
 * @param {!GroupsApp.User} user The member to read events for.
 * @param {!Date} start The start of the range.
 * @param {!Date} end The end of the range.
 * @param {?Date} optSince Only return events modified since this time.
 * @return {!Array<!Object>} Event resources.
 */
function findEvents(user, start, end, optSince) {
  const params = {
    timeMin: formatDateAsRFC3339(start),
    timeMax: formatDateAsRFC3339(end),
    showDeleted: PROPAGATE_DELETIONS,
    maxResults: 250,
  };
  if (optSince) {
    // Skips events that have not been modified since the last run.
    params.updatedMin = formatDateAsRFC3339(optSince);
  }
  return listAllEvents(user.getEmail(), params);
}

/**
 * Pages through Calendar.Events.list, collecting every result.
 * @param {string} email The calendar to read.
 * @param {!Object} params Query parameters.
 * @return {!Array<!Object>} Event resources.
 */
function listAllEvents(email, params) {
  const events = [];
  let pageToken = null;
  do {
    const request = Object.assign({}, params, { pageToken: pageToken });
    let response;
    try {
      response = Calendar.Events.list(email, request);
    } catch (e) {
      console.error('Error retrieving events for %s: %s. Skipping remaining pages.',
        email, e.toString());
      break; // Never `continue` here: pageToken is unchanged, so it would loop forever.
    }
    for (const item of (response.items || [])) {
      events.push(item);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Returns the IANA timezone of a member's calendar, falling back to a manual
 * override and then to FALLBACK_TIME_ZONE.
 * @param {string} email The member's email address.
 * @return {string} An IANA timezone id.
 */
function getUserTimeZone(email) {
  if (timeZoneCache.has(email)) {
    return timeZoneCache.get(email);
  }

  let timeZone = MEMBER_TIME_ZONES[email] || null;

  if (!timeZone) {
    try {
      timeZone = Calendar.Calendars.get(email).timeZone;
    } catch (e) {
      console.warn('Could not read the timezone for %s (%s); using %s. ' +
        'Add an entry to MEMBER_TIME_ZONES if that is wrong.',
        email, e.message, FALLBACK_TIME_ZONE);
    }
  }

  timeZone = timeZone || FALLBACK_TIME_ZONE;
  timeZoneCache.set(email, timeZone);
  return timeZone;
}

/* ------------------------------------------------------------------ *
 * Group membership
 * ------------------------------------------------------------------ */

/**
 * Resolves the configured group(s) into a deduplicated member list.
 * @return {!Array<!GroupsApp.User>} The team members.
 */
function getTeamMembers() {
  const groupEmails = Array.isArray(GROUP_EMAIL) ? GROUP_EMAIL : [GROUP_EMAIL];

  const users = [];
  const seen = new Set();
  for (const groupEmail of groupEmails) {
    const members = ONLY_DIRECT_MEMBERS ?
      GroupsApp.getGroupByEmail(groupEmail).getUsers() :
      getAllMembers(groupEmail);
    for (const user of members) {
      const email = user.getEmail();
      if (!seen.has(email)) {
        seen.add(email);
        users.push(user);
      }
    }
  }
  return users;
}

/**
 * Returns direct and indirect members of a group.
 * @param {string} groupEmail The group's email address.
 * @param {!Set<string>=} visited Groups already expanded, to stop cycles.
 * @return {!Array<!GroupsApp.User>} The members.
 */
function getAllMembers(groupEmail, visited) {
  visited = visited || new Set();
  if (visited.has(groupEmail)) {
    return []; // Nested groups can reference each other in a cycle.
  }
  visited.add(groupEmail);

  const group = GroupsApp.getGroupByEmail(groupEmail);
  let users = group.getUsers();
  for (const childGroup of group.getGroups()) {
    users = users.concat(getAllMembers(childGroup.getEmail(), visited));
  }
  return users;
}

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

/**
 * @param {!Date} date The instant to format.
 * @param {string} timeZone An IANA timezone id.
 * @return {string} The calendar date in that zone, as yyyy-MM-dd.
 */
function formatDayKey(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
}

/**
 * Adds or subtracts whole days from a yyyy-MM-dd string. The arithmetic is
 * done in UTC so that DST transitions cannot shift it.
 * @param {string} dayKey A yyyy-MM-dd date string.
 * @param {number} days The number of days to add.
 * @return {string} The shifted yyyy-MM-dd string.
 */
function shiftDayKey(dayKey, days) {
  const parts = dayKey.split('-');
  const date = new Date(Date.UTC(
    Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  date.setUTCDate(date.getUTCDate() + days);
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

/**
 * @param {!Date} date The instant to test.
 * @param {string} timeZone An IANA timezone id.
 * @return {boolean} True if the instant is midnight in that zone.
 */
function isLocalMidnight(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'HH:mm:ss') === '00:00:00';
}

/**
 * @param {!Date} date The instant to format.
 * @param {string} timeZone An IANA timezone id.
 * @return {string} A human-readable local timestamp.
 */
function formatLocal(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'EEE d MMM yyyy HH:mm');
}

/**
 * @param {!Date} date The date to format.
 * @return {string} An RFC 3339 timestamp in UTC.
 */
function formatDateAsRFC3339(date) {
  return Utilities.formatDate(date, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}
