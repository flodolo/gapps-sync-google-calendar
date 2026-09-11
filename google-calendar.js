// To learn how to use this script, refer to the documentation:
// https://developers.google.com/apps-script/samples/automations/vacation-calendar

/*
Copyright 2022 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Set the ID of the team calendar to add events to. You can find the calendar's
// ID on the settings page.
const TEAM_CALENDAR_ID = "your-calendar-id@group.calendar.google.com";
// Calendar ACL roles that identify a team member. 'writer' is "Make changes to
// events", 'owner' is "Make changes and manage sharing".
const MEMBER_ROLES = ["writer", "owner"];

const KEYWORDS = ['vacation', 'ooo', 'pto', 'wellness', 'holiday', 'on leave'];
const MONTHS_IN_ADVANCE = 3;

// When true, timed out-of-office events are imported only if their title
// contains one of KEYWORDS; all-day events are always imported. When false,
// every out-of-office event in the window is imported.
const STRICT_MATCH = true;

// When true, the original event title, description and location are discarded
// and the imported event is titled '[username] Away'. Keeps private details
// from personal calendars off the shared team calendar.
const SANITIZE_EVENTS = true;
const SANITIZED_TITLE = "Away";

/**
 * Sets up the script to run automatically: an hourly incremental sync, plus a
 * nightly full sync that re-scans the whole window.
 */
function setup() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length > 0) {
    throw new Error("Triggers are already setup.");
  }
  ScriptApp.newTrigger("sync").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("fullSync").timeBased().everyDays(1).atHour(3).create();
  // Runs the first sync immediately.
  fullSync();
}

/**
 * Looks through the calendars of everyone with write access to the team
 * calendar and adds any 'vacation' or 'out of office' events to it.
 */
function sync() {
  // Note: no parameters. Time-based triggers pass an event object as the first
  // argument, so options go through runSync() instead.
  runSync({});
}

/**
 * Re-scans the entire window, ignoring the time of the last run. Catches events
 * that were created outside the window and slid into it without being modified
 * since, which the incremental sync() would never see.
 */
function fullSync() {
  runSync({ ignoreLastRun: true });
}

/**
 * Dry run over a short window: lists what would be imported without writing
 * anything to the team calendar, and without touching the 'lastRun' property.
 * Run this manually from the editor to test the configuration.
 */
function testSync() {
  runSync({ daysAhead: 7, dryRun: true, ignoreLastRun: true });
}

/**
 * Performs the sync.
 * @param {Object} options Optional settings.
 * @param {number} options.daysAhead Look this many days ahead instead of
 *     MONTHS_IN_ADVANCE months.
 * @param {boolean} options.dryRun Log events instead of importing them, and
 *     leave 'lastRun' untouched.
 * @param {boolean} options.ignoreLastRun Scan the whole window rather than only
 *     events modified since the last run.
 * @param {boolean} options.strictMatch Overrides the STRICT_MATCH constant.
 */
function runSync(options) {
  // Defines the calendar event date range to search.
  const today = new Date();
  const maxDate = new Date();
  if (options.daysAhead) {
    maxDate.setDate(maxDate.getDate() + options.daysAhead);
  } else {
    maxDate.setMonth(maxDate.getMonth() + MONTHS_IN_ADVANCE);
  }
  console.log(
    "Window: %s to %s%s",
    formatDateAsRFC3339(today),
    formatDateAsRFC3339(maxDate),
    options.dryRun ? " (dry run)" : "",
  );

  // Determines the time the the script was last run.
  let lastRun = options.ignoreLastRun
    ? null
    : PropertiesService.getScriptProperties().getProperty("lastRun");
  lastRun = lastRun ? new Date(lastRun) : null;

  // Gets the list of people with write access to the team calendar.
  const users = getCalendarEditors(TEAM_CALENDAR_ID);
  console.log(`Found ${users.length} team members with write access`);

  // For each user, finds events having one or more of the keywords in the event
  // summary in the specified date range. Imports each of those to the team
  // calendar.
  const strict =
    options.strictMatch === undefined ? STRICT_MATCH : options.strictMatch;

  let count = 0;
  let skipped = 0;
  for (const email of users) {
    const username = email.split("@")[0];
    const events = findEvents(email, today, maxDate, lastRun);
    for (const event of events) {
      if (strict && !isStrictMatch(event)) {
        console.log(
          "Skipping (not a strict match): [%s] %s",
          username,
          event.summary,
        );
        skipped++;
        continue;
      }
      if (options.dryRun) {
        const summary = buildSummary(username, event);
        if (isAllDayEvent(event)) {
          convertToAllDay(event);
          console.log(
            "Would import: %s (all day, %s to %s exclusive)",
            summary,
            event.start.date,
            event.end.date,
          );
        } else {
          console.log(
            "Would import: %s (%s)",
            summary,
            event.start.dateTime,
          );
        }
      } else {
        importEvent(username, event);
      }
      count++;
    }
  }

  if (!options.dryRun) {
    PropertiesService.getScriptProperties().setProperty("lastRun", today);
  }
  console.log(
    `${options.dryRun ? "Would import" : "Imported"} ${count} events` +
    (strict ? `, skipped ${skipped} non-matching` : ""),
  );
}

/**
 * Builds the title for the imported event: '[username] Away' when
 * SANITIZE_EVENTS is on, otherwise the original title prefixed with the
 * username.
 * @param {string} username The team member the event belongs to.
 * @param {Calendar.Event} event The source event.
 * @return {string} The title to use on the team calendar.
 */
function buildSummary(username, event) {
  const title = SANITIZE_EVENTS ? SANITIZED_TITLE : event.summary;
  return `[${username}] ${title}`;
}

/**
 * Decides whether an event qualifies under STRICT_MATCH: all-day events are
 * always kept, while timed events are kept only if their title contains one of
 * KEYWORDS.
 * @param {Calendar.Event} event The event to test.
 * @return {boolean} True if the event should be imported.
 */
function isStrictMatch(event) {
  if (isAllDayEvent(event)) {
    return true;
  }
  const summary = (event.summary || "").toLowerCase();
  return KEYWORDS.some((keyword) => summary.includes(keyword));
}

/**
 * Rewrites an event that covers whole days as a date-only all-day event, in
 * place. Google's all-day end date is exclusive, so an event ending at midnight
 * (or 23:59) on the last day becomes an end date of the following day.
 * @param {Calendar.Event} event The event to rewrite.
 */
function convertToAllDay(event) {
  if (event.start.date) {
    // Already a date-only event.
    return;
  }
  const timeZone = event.start.timeZone || Session.getScriptTimeZone();
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);

  const startDate = Utilities.formatDate(start, timeZone, "yyyy-MM-dd");
  // Step back a second so an end of midnight counts as the previous day, then
  // add one day to get the exclusive end date.
  const lastDay = Utilities.formatDate(
    new Date(end.getTime() - 1000),
    timeZone,
    "yyyy-MM-dd",
  );
  const parts = lastDay.split("-");
  const exclusiveEnd = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
  );
  exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);

  event.start = { date: startDate };
  event.end = {
    date: Utilities.formatDate(exclusiveEnd, "UTC", "yyyy-MM-dd"),
  };
}

/**
 * Decides whether an event covers whole days. Ordinary all-day events use a
 * date-only 'date' field, but out-of-office events always carry a 'dateTime'
 * even when created as full-day, so those are detected by checking that they
 * start at midnight and run for at least a full day.
 * @param {Calendar.Event} event The event to test.
 * @return {boolean} True if the event covers one or more whole days.
 */
function isAllDayEvent(event) {
  if (!event.start || !event.end) {
    return false;
  }
  if (event.start.date) {
    return true;
  }
  if (!event.start.dateTime || !event.end.dateTime) {
    return false;
  }
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const timeZone = event.start.timeZone || Session.getScriptTimeZone();
  const startsAtMidnight =
    Utilities.formatDate(start, timeZone, "HH:mm") === "00:00";
  // Allow a little slack: some clients end the day at 23:59 instead of 00:00.
  const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  return startsAtMidnight && durationHours >= 23;
}

/**
 * Imports the given event from the user's calendar into the shared team
 * calendar.
 * @param {string} username The team member that is attending the event.
 * @param {Calendar.Event} event The event to import.
 */
function importEvent(username, event) {
  event.summary = buildSummary(username, event);
  if (SANITIZE_EVENTS) {
    // Personal calendars can hold details the team calendar should not expose.
    event.description = undefined;
    event.location = undefined;
  }
  // Full-day out-of-office events are stored with a 'dateTime', so they would
  // land on the team calendar as timed 00:00-23:59 blocks. Rewrite them as real
  // all-day events.
  if (isAllDayEvent(event)) {
    convertToAllDay(event);
  }
  event.organizer = {
    id: TEAM_CALENDAR_ID,
  };
  event.attendees = [];

  // If the event is not of type 'default', it can't be imported, so it needs
  // to be changed.
  if (event.eventType !== "default") {
    event.eventType = "default";
    event.outOfOfficeProperties = undefined;
    event.focusTimeProperties = undefined;
  }

  console.log("Importing: %s", event.summary);
  try {
    Calendar.Events.import(event, TEAM_CALENDAR_ID);
  } catch (e) {
    console.error(
      "Error attempting to import event: %s. Skipping.",
      e.toString(),
    );
  }
}

/**
 * In a given user's calendar, looks for occurrences of the given keyword
 * in events within the specified date range and returns any such events
 * found.
 * @param {string} email The email address of the user to retrieve events for.
 * @param {Date} start The starting date of the range to examine.
 * @param {Date} end The ending date of the range to examine.
 * @param {Date} optSince A date indicating the last time this script was run.
 * @return {Calendar.Event[]} An array of calendar events.
 */
function findEvents(email, start, end, optSince) {
  const params = {
    eventTypes: "outOfOffice",
    timeMin: formatDateAsRFC3339(start),
    timeMax: formatDateAsRFC3339(end),
    showDeleted: true,
  };
  if (optSince) {
    // This prevents the script from examining events that have not been
    // modified since the specified date (that is, the last time the
    // script was run).
    params.updatedMin = formatDateAsRFC3339(optSince);
  }
  let pageToken = null;
  let events = [];
  do {
    params.pageToken = pageToken;
    let response;
    try {
      response = Calendar.Events.list(email, params);
    } catch (e) {
      console.error(
        "Error retrieving events for %s: %s; skipping",
        email,
        e.toString(),
      );
      break;
    }
    events = events.concat(response.items);
    pageToken = response.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Returns an RFC3339 formated date String corresponding to the given
 * Date object.
 * @param {Date} date a Date.
 * @return {string} a formatted date string.
 */
function formatDateAsRFC3339(date) {
  return Utilities.formatDate(date, "UTC", "yyyy-MM-dd'T'HH:mm:ssZ");
}

/**
 * Diagnostic helper: dumps the raw start/end of every out-of-office event in
 * the next 30 days, with the verdict of the all-day and strict-match checks.
 * Run this manually to confirm the filters behave as expected.
 */
function inspectEvents() {
  const today = new Date();
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);

  for (const email of getCalendarEditors(TEAM_CALENDAR_ID)) {
    const events = findEvents(email, today, maxDate, null);
    console.log("%s: %s events", email, events.length);
    for (const event of events) {
      console.log(
        "  %s\n    start=%s end=%s tz=%s\n    allDay=%s strictMatch=%s",
        event.summary,
        JSON.stringify(event.start),
        JSON.stringify(event.end),
        event.start.timeZone || "(none)",
        isAllDayEvent(event),
        isStrictMatch(event),
      );
    }
  }
}

/**
 * Diagnostic helper: checks whether TEAM_CALENDAR_ID is reachable by the
 * account running the script, and with which access role. Run this manually
 * when acl.list returns 'Not Found'.
 */
function diagnoseCalendarAccess() {
  console.log("Running as: %s", Session.getEffectiveUser().getEmail());
  console.log("TEAM_CALENDAR_ID: %s", TEAM_CALENDAR_ID);

  let entry;
  try {
    entry = Calendar.CalendarList.get(TEAM_CALENDAR_ID);
  } catch (e) {
    console.error(
      "The calendar is not in this account's calendar list: %s",
      e.toString(),
    );
    console.log("Calendars this account can see:");
    let pageToken = null;
    do {
      const list = Calendar.CalendarList.list({ pageToken: pageToken });
      for (const cal of list.items) {
        console.log("  %s — %s (%s)", cal.summary, cal.id, cal.accessRole);
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
    return;
  }

  console.log("Found '%s' with accessRole '%s'", entry.summary, entry.accessRole);
  if (entry.accessRole !== "owner") {
    console.warn(
      "acl.list requires accessRole 'owner'; '%s' is not enough.",
      entry.accessRole,
    );
  }
}

/**
 * Diagnostic helper: logs every ACL entry of the team calendar, grouped by
 * role. Run this manually from the editor to check who administers the
 * calendar and which entries the sync will skip.
 */
function listCalendarAccess() {
  const byRole = {};
  let pageToken = null;
  do {
    const response = Calendar.Acl.list(TEAM_CALENDAR_ID, {
      pageToken: pageToken,
    });
    for (const rule of response.items) {
      const entry = `${rule.scope.value || "(everyone)"} [${rule.scope.type}]`;
      (byRole[rule.role] = byRole[rule.role] || []).push(entry);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  // 'owner' is "Make changes and manage sharing", that is, the admins.
  for (const role of Object.keys(byRole).sort()) {
    console.log("%s (%s):\n  %s", role, byRole[role].length, byRole[role].join("\n  "));
  }
}

/**
 * Gets the email addresses of the individual users that have write access
 * ("Make changes to events" or "Make changes and manage sharing") to the given
 * calendar. Group, domain and public ACL entries are ignored, as are entries
 * pointing at the team calendar itself.
 * @param {string} calendarId The ID of the calendar to read the ACL of.
 * @return {string[]} An array of unique email addresses.
 */
function getCalendarEditors(calendarId) {
  const emails = new Set();
  let pageToken = null;
  do {
    const response = Calendar.Acl.list(calendarId, { pageToken: pageToken });
    for (const rule of response.items) {
      if (!MEMBER_ROLES.includes(rule.role)) {
        continue;
      }
      if (rule.scope.type !== "user") {
        console.log(
          "Skipping non-user ACL entry: %s (%s)",
          rule.scope.value,
          rule.scope.type,
        );
        continue;
      }
      // The team calendar is usually listed as an owner of itself.
      if (rule.scope.value === calendarId) {
        continue;
      }
      emails.add(rule.scope.value);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return Array.from(emails);
}
