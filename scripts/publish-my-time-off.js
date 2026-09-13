// Pushes your own time off to shared calendars: the events come from the
// calendar of whoever runs the script, and go to every calendar listed in
// PUBLISH_CALENDAR_IDS. Unlike sync-team-calendar.js this needs no
// administrative access to the destinations, only permission to make changes
// to events, so it suits calendars you contribute to but do not own.
//
// Copies follow exactly the same rules as the team sync: STRICT_MATCH decides
// which events qualify, SANITIZE_EVENTS strips private details, copies show as
// Free, carry no reminders and no attendees, and are removed again when the
// source event is cancelled or stops matching. The shared helpers live in
// common.js.

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


/**
 * Sets up this script to run automatically, and can be re-run at any time to
 * apply a new schedule: its own triggers are replaced, while any trigger
 * belonging to sync-team-calendar.js is left alone.
 *
 * The schedule is a daily incremental publish
 * between 08:00 and 09:00, plus a weekly full publish on Monday between 07:00
 * and 08:00 that re-scans the whole window. Apps Script picks a moment inside
 * the hour it is given, so these are windows rather than exact times. Only this
 * script's own triggers are considered, so it can coexist with
 * sync-team-calendar.js.
 */
function setupPublish() {
  clearTriggers(["publishMyTimeOff", "fullPublishMyTimeOff"]);
  ScriptApp.newTrigger("publishMyTimeOff").timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger("fullPublishMyTimeOff")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  // Runs the first publish immediately.
  fullPublishMyTimeOff();
}

/**
 * Copies your qualifying out-of-office events to every calendar in
 * PUBLISH_CALENDAR_IDS, looking only at events modified since the last run.
 */
function publishMyTimeOff() {
  // Note: no parameters. Time-based triggers pass an event object as the first
  // argument, so options go through runPublish() instead.
  runPublish({});
}

/**
 * Re-scans the entire window, ignoring the time of the last run. Catches events
 * that were created outside the window and slid into it without being modified
 * since, which the incremental publishMyTimeOff() would never see.
 */
function fullPublishMyTimeOff() {
  runPublish({ ignoreLastRun: true });
}

/**
 * Dry run over a short window: lists what would be copied to each destination
 * without writing anything, and without updating any checkpoints. Run this
 * manually from the editor to test the configuration.
 */
function testPublishMyTimeOff() {
  runPublish({ daysAhead: 7, dryRun: true, ignoreLastRun: true });
}

/**
 * Performs the publish.
 * @param {Object} options Optional settings.
 * @param {number} options.daysAhead Look this many days ahead instead of
 *     MONTHS_IN_ADVANCE months.
 * @param {boolean} options.dryRun Log events instead of copying them, and leave
 *     checkpoints untouched.
 * @param {boolean} options.ignoreLastRun Scan the whole window rather than only
 *     events modified since the last run.
 * @param {boolean} options.strictMatch Overrides the STRICT_MATCH constant.
 */
function runPublish(options = {}) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    performPublish(options);
  } finally {
    lock.releaseLock();
  }
}

function performPublish(options) {
  if (!PUBLISH_CALENDAR_IDS.length) {
    console.log("PUBLISH_CALENDAR_IDS is empty; nothing to publish.");
    return;
  }

  const { today, maxDate } = syncWindow(options);
  const strict = strictMatchFor(options);
  const properties = PropertiesService.getScriptProperties();
  const email = Session.getEffectiveUser().getEmail();
  console.log("Publishing the time off of %s", email);

  // Each destination advances independently, under a key of its own so that a
  // calendar listed in both PUBLISH_CALENDAR_IDS and TEAM_CALENDAR_IDS does not
  // share a checkpoint with the team sync.
  let count = 0;
  let skipped = 0;
  let failed = 0;
  for (const calendarId of PUBLISH_CALENDAR_IDS) {
    const checkpoint = `lastPublish:${calendarId}:${email}`;
    try {
      const lastRun = options.ignoreLastRun
        ? null
        : properties.getProperty(checkpoint);
      // Fetched per destination: each one has its own checkpoint, so the set of
      // events that still needs copying differs between them.
      const events = findEvents(
        email, today, maxDate, lastRun ? new Date(lastRun) : null,
      );
      const result = syncUserEvents(
        calendarId, email, events, strict, options.dryRun,
        importedEventsLoader(calendarId),
      );
      count += result.count;
      skipped += result.skipped;
      if (!options.dryRun) {
        properties.setProperty(checkpoint, today.toISOString());
      }
    } catch (error) {
      failed++;
      console.error(
        "Publishing to %s failed: %s; will retry next run",
        calendarId, String(error),
      );
    }
  }

  console.log(
    `${options.dryRun ? "Would publish" : "Published"} ${count} events` +
      `, excluded or cancelled ${skipped}, failed calendars ${failed}`,
  );
  if (failed) {
    throw new Error(`${failed} destination calendar(s) failed; see log above`);
  }
}

/**
 * Diagnostic helper: checks that every calendar in PUBLISH_CALENDAR_IDS is
 * reachable by the account running the script and writable by it. Run this
 * manually when publishing fails.
 */
function diagnosePublishAccess() {
  console.log("Running as: %s", Session.getEffectiveUser().getEmail());
  if (!PUBLISH_CALENDAR_IDS.length) {
    console.warn("PUBLISH_CALENDAR_IDS is empty.");
    return;
  }
  for (const calendarId of PUBLISH_CALENDAR_IDS) {
    let entry;
    try {
      entry = Calendar.CalendarList.get(calendarId);
    } catch (e) {
      console.error(
        "%s is not in this account's calendar list: %s",
        calendarId, e.toString(),
      );
      continue;
    }
    const writable = entry.accessRole === "writer" || entry.accessRole === "owner";
    console.log(
      "%s: '%s' with accessRole '%s'%s",
      calendarId, entry.summary, entry.accessRole,
      writable ? "" : " — NOT writable, publishing will fail",
    );
  }
}
