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
// Script all files share one global scope, so TEAM_CALENDARS, MEMBER_ROLES,
// KEYWORDS, MONTHS_IN_ADVANCE, STRICT_MATCH, SANITIZE_EVENTS and
// SANITIZED_TITLE are defined there, and the shared helpers live in common.js.

/**
 * Sets up the script to run automatically, and can be re-run at any time to
 * apply a new schedule: its own triggers are replaced, while any trigger
 * belonging to publish-my-time-off.js is left alone.
 *
 * The schedule is a daily incremental sync between
 * 08:00 and 09:00, plus a weekly full sync on Monday between 07:00 and 08:00
 * that re-scans the whole window. Apps Script picks a moment inside the hour
 * it is given, so these are windows rather than exact times.
 */
function setup() {
  clearTriggers(["sync", "fullSync"]);
  ScriptApp.newTrigger("sync").timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger("fullSync")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
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
  const { today, maxDate, timeZone } = syncWindow(options);

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
  for (const calendar of calendarEntries(TEAM_CALENDARS)) {
    console.log("Team calendar: %s", calendarLabel(calendar));
    try {
      const result = syncTeamCalendar(
        calendar, today, maxDate, strict, options, properties, timeZone,
      );
      count += result.count;
      skipped += result.skipped;
      failed += result.failed;
    } catch (error) {
      problems.push(
        `team calendar ${calendarLabel(calendar)} failed: ${String(error)}`,
      );
      console.error(
        "Team calendar %s failed: %s; will retry next run",
        calendarLabel(calendar), String(error),
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
 * @param {{name: string, id: string}} calendar The team calendar to import
 *     into. Checkpoints use its ID, so renaming it keeps them valid.
 * @param {Date} today Start of the window.
 * @param {Date} maxDate End of the window.
 * @param {boolean} strict Whether STRICT_MATCH filtering applies.
 * @param {Object} options The runSync() options.
 * @param {Properties} properties The script properties store.
 * @return {{count: number, skipped: number, failed: number}} Per-calendar tally.
 */
function syncTeamCalendar(calendar, today, maxDate, strict, options, properties, timeZone) {
  const calendarId = calendar.id;
  // Gets the list of people with write access to the team calendar.
  const users = getCalendarEditors(calendarId);
  console.log(
    "Found %s team members with write access to %s",
    users.length, calendar.name,
  );

  const prefix = `lastRun:${calendarId}:`;
  // One loader for this calendar, shared by all of its members.
  const getImportedEvents = importedEventsLoader(calendarId);

  // For each user, finds events having one or more of the keywords in the event
  // summary in the specified date range. Imports each of those to the team
  // calendar.
  let count = 0;
  let skipped = 0;
  let failed = 0;
  const activeKeys = new Set(users.map((email) => `${prefix}${email}`));
  const departed = Object.keys(properties.getProperties()).filter(
    (key) => key.startsWith(prefix) && !activeKeys.has(key),
  );
  if (!options.dryRun && properties.getProperty("lastRun")) {
    properties.deleteProperty("lastRun");
  }
  // An ACL that returns nobody is indistinguishable from the whole team having
  // left, and acting on it would strip every member's copies from the calendar
  // in one unattended run. Sharing switched to a group, or a narrowed
  // MEMBER_ROLES, both look exactly like that, so refuse instead.
  if (departed.length && !users.length) {
    console.warn(
      "Skipping cleanup of %s checkpoint(s): the ACL returned no individual " +
        "users, which is more likely a sharing change than a mass departure.",
      departed.length,
    );
  } else {
    for (const key of departed) {
      const email = key.slice(prefix.length);
      try {
        // Publishing can independently keep this person's copies on this
        // calendar, in which case they are not stale and must survive.
        const publishingHere = typeof PUBLISH_CALENDARS !== "undefined" &&
          calendarIds(PUBLISH_CALENDARS).includes(calendarId) &&
          properties.getProperty(`lastPublish:${calendarId}:${email}`);
        if (publishingHere) {
          // The key is the only thing that would ever trigger this cleanup, so
          // it is kept rather than dropped: if publishing to this calendar
          // stops later, the copies are still reclaimable.
          console.log(
            "Keeping %s: that account still publishes to this calendar", key,
          );
          continue;
        }
        const index = getImportedEvents();
        for (const [source, copies] of index.bySource) {
          if (!source.startsWith(`${email}/`)) continue;
          for (const copy of copies) {
            if (copyOverlapsWindow(calendarId, copy, today, null, index.timeZone)) {
              removeCopy(calendarId, copy, options.dryRun);
            }
          }
        }
        // Keep this key until cleanup succeeds, so a failed removal is retried.
        if (!options.dryRun) properties.deleteProperty(key);
      } catch (error) {
        failed++;
        console.error("Cleanup failed for %s: %s; will retry next run", email, String(error));
      }
    }
  }
  for (const email of users) {
    const checkpoint = `${prefix}${email}`;
    try {
      const lastRun = options.ignoreLastRun
        ? null
        : properties.getProperty(checkpoint);
      const events = findEvents(
        email, today, maxDate, lastRun ? new Date(lastRun) : null,
      );
      if (!lastRun) {
        reconcileMissingEvents(calendarId, email, events, { today, maxDate },
          options.dryRun, getImportedEvents());
      }
      const result = syncUserEvents(
        calendarId, email, events, strict, options.dryRun, getImportedEvents,
        { today, maxDate, timeZone, incremental: Boolean(lastRun) },
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

  for (const calendar of calendarEntries(TEAM_CALENDARS)) {
    console.log("Team calendar: %s", calendarLabel(calendar));
    for (const email of getCalendarEditors(calendar.id)) {
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
 * Diagnostic helper: checks whether every calendar in TEAM_CALENDARS is
 * reachable by the account running the script, and with which access role. Run
 * this manually when acl.list returns 'Not Found'.
 */
function diagnoseCalendarAccess() {
  console.log("Running as: %s", Session.getEffectiveUser().getEmail());

  let unreachable = false;
  for (const calendar of calendarEntries(TEAM_CALENDARS)) {
    let entry;
    try {
      entry = Calendar.CalendarList.get(calendar.id);
    } catch (e) {
      unreachable = true;
      console.error(
        "%s is not in this account's calendar list: %s",
        calendarLabel(calendar), e.toString(),
      );
      continue;
    }
    console.log(
      "%s: found '%s' with accessRole '%s'",
      calendarLabel(calendar), entry.summary, entry.accessRole,
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
  for (const calendar of calendarEntries(TEAM_CALENDARS)) {
    console.log("Team calendar: %s", calendarLabel(calendar));
    const byRole = {};
    let pageToken = null;
    do {
      const response = Calendar.Acl.list(calendar.id, {
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
