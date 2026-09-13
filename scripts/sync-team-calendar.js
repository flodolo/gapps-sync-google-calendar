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


// Pulls the whole team's time off into the shared team calendars: the members
// are whoever has write access to each team calendar, so running this needs
// administrative access to those calendars. To push only your own time off to
// calendars you do not administer, see publish-my-time-off.js.
//
// Configuration lives in config.js (copy config.dist.js to create it). In Apps
// Script all files share one global scope, so TEAM_CALENDAR_IDS, MEMBER_ROLES,
// KEYWORDS, MONTHS_IN_ADVANCE, STRICT_MATCH, SANITIZE_EVENTS and
// SANITIZED_TITLE are defined there, and the shared helpers live in common.js.

/**
 * Sets up the script to run automatically: an hourly incremental sync, plus a
 * nightly full sync that re-scans the whole window.
 */
function setup() {
  // Only this script's own triggers are considered, so it can coexist with
  // publish-my-time-off.js in the same project.
  const handlers = ["sync", "fullSync"];
  const existing = ScriptApp.getProjectTriggers().filter((trigger) =>
    handlers.includes(trigger.getHandlerFunction()),
  );
  if (existing.length > 0) {
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
 * anything to the team calendar, and without updating any calendar checkpoints.
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
 *     leave calendar checkpoints untouched.
 * @param {boolean} options.ignoreLastRun Scan the whole window rather than only
 *     events modified since the last run.
 * @param {boolean} options.strictMatch Overrides the STRICT_MATCH constant.
 */
function runSync(options = {}) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    performSync(options);
  } finally {
    lock.releaseLock();
  }
}

function performSync(options) {
  const { today, maxDate } = syncWindow(options);

  // Each calendar advances independently. Missing checkpoints trigger a full
  // scan, including the first run after upgrading from the global lastRun.
  const properties = PropertiesService.getScriptProperties();

  const strict = strictMatchFor(options);

  // Each team calendar is synced independently: it has its own member list
  // (its ACL), its own imported copies and its own per-user checkpoints. One
  // unreachable team calendar must not stop the others, so failures are
  // collected and reported once at the end.
  let count = 0;
  let skipped = 0;
  let failed = 0;
  const problems = [];
  for (const calendarId of TEAM_CALENDAR_IDS) {
    console.log("Team calendar: %s", calendarId);
    try {
      const result = syncTeamCalendar(
        calendarId, today, maxDate, strict, options, properties,
      );
      count += result.count;
      skipped += result.skipped;
      failed += result.failed;
    } catch (error) {
      problems.push(`team calendar ${calendarId} failed: ${String(error)}`);
      console.error(
        "Team calendar %s failed: %s; will retry next run",
        calendarId, String(error),
      );
    }
  }

  console.log(
    `${options.dryRun ? "Would import" : "Imported"} ${count} events from completed calendars` +
      `, excluded or cancelled ${skipped}, failed calendars ${failed}`,
  );
  if (failed) {
    problems.push(`${failed} calendar(s) failed; see log above`);
  }
  if (problems.length) {
    throw new Error(problems.join("\n"));
  }
}

/**
 * Syncs one team calendar: reads its ACL for the member list, then imports each
 * member's qualifying events into it.
 * @param {string} calendarId The team calendar to import into.
 * @param {Date} today Start of the window.
 * @param {Date} maxDate End of the window.
 * @param {boolean} strict Whether STRICT_MATCH filtering applies.
 * @param {Object} options The runSync() options.
 * @param {Properties} properties The script properties store.
 * @return {{count: number, skipped: number, failed: number}} Per-calendar tally.
 */
function syncTeamCalendar(calendarId, today, maxDate, strict, options, properties) {
  // Gets the list of people with write access to the team calendar.
  const users = getCalendarEditors(calendarId);
  console.log(`Found ${users.length} team members with write access`);

  const prefix = `lastRun:${calendarId}:`;
  if (!options.dryRun) {
    // Only this calendar's own keys are considered, so the checkpoints of the
    // other team calendars are left alone.
    const activeKeys = new Set(users.map((email) => `${prefix}${email}`));
    for (const key of Object.keys(properties.getProperties())) {
      if (key === "lastRun" || (key.startsWith(prefix) && !activeKeys.has(key))) {
        properties.deleteProperty(key);
      }
    }
  }

  // One loader for this calendar, shared by all of its members.
  const getImportedEvents = importedEventsLoader(calendarId);

  // For each user, finds events having one or more of the keywords in the event
  // summary in the specified date range. Imports each of those to the team
  // calendar.
  let count = 0;
  let skipped = 0;
  let failed = 0;
  for (const email of users) {
    const checkpoint = `${prefix}${email}`;
    try {
      const lastRun = options.ignoreLastRun
        ? null
        : properties.getProperty(checkpoint);
      const events = findEvents(
        email, today, maxDate, lastRun ? new Date(lastRun) : null,
      );
      const result = syncUserEvents(
        calendarId, email, events, strict, options.dryRun, getImportedEvents,
      );
      count += result.count;
      skipped += result.skipped;
      if (!options.dryRun) {
        properties.setProperty(checkpoint, today.toISOString());
      }
    } catch (error) {
      failed++;
      console.error("Sync failed for %s: %s; will retry next run", email, String(error));
    }
  }
  return { count, skipped, failed };
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

  for (const calendarId of TEAM_CALENDAR_IDS) {
    console.log("Team calendar: %s", calendarId);
    for (const email of getCalendarEditors(calendarId)) {
      const events = findEvents(email, today, maxDate, null);
      console.log("  %s: %s events", email, events.length);
      for (const event of events) {
        console.log(
          "    %s\n      start=%s end=%s tz=%s\n      allDay=%s strictMatch=%s",
          event.summary,
          JSON.stringify(event.start),
          JSON.stringify(event.end),
          (event.start && event.start.timeZone) || "(none)",
          isAllDayEvent(event),
          isStrictMatch(event),
        );
      }
    }
  }
}

/**
 * Diagnostic helper: checks whether every calendar in TEAM_CALENDAR_IDS is
 * reachable by the account running the script, and with which access role. Run
 * this manually when acl.list returns 'Not Found'.
 */
function diagnoseCalendarAccess() {
  console.log("Running as: %s", Session.getEffectiveUser().getEmail());

  let unreachable = false;
  for (const calendarId of TEAM_CALENDAR_IDS) {
    let entry;
    try {
      entry = Calendar.CalendarList.get(calendarId);
    } catch (e) {
      unreachable = true;
      console.error(
        "%s is not in this account's calendar list: %s",
        calendarId, e.toString(),
      );
      continue;
    }
    console.log(
      "%s: found '%s' with accessRole '%s'",
      calendarId, entry.summary, entry.accessRole,
    );
    if (entry.accessRole !== "owner") {
      console.warn(
        "acl.list requires accessRole 'owner'; '%s' is not enough.",
        entry.accessRole,
      );
    }
  }

  if (unreachable) {
    console.log("Calendars this account can see:");
    let pageToken = null;
    do {
      const list = Calendar.CalendarList.list({ pageToken: pageToken });
      for (const cal of list.items) {
        console.log("  %s — %s (%s)", cal.summary, cal.id, cal.accessRole);
      }
      pageToken = list.nextPageToken;
    } while (pageToken);
  }
}

/**
 * Diagnostic helper: logs every ACL entry of each team calendar, grouped by
 * role. Run this manually from the editor to check who administers the
 * calendars and which entries the sync will skip.
 */
function listCalendarAccess() {
  for (const calendarId of TEAM_CALENDAR_IDS) {
    console.log("Team calendar: %s", calendarId);
    const byRole = {};
    let pageToken = null;
    do {
      const response = Calendar.Acl.list(calendarId, {
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
      console.log("  %s (%s):\n    %s", role, byRole[role].length, byRole[role].join("\n    "));
    }
  }
}
