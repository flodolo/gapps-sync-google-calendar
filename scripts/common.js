// Helpers shared by the sync scripts in this project:
//   sync-team-calendar.js   pulls the team's time off into the team calendars
//   publish-my-time-off.js  pushes your own time off to shared calendars
//
// Everything here takes the calendar and the person it works on as arguments,
// so both scripts reuse it unchanged. In Apps Script all files share one global
// scope, so these functions need no import.

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
 * Normalizes a calendar setting into entries to iterate over.
 *
 * The settings are written as name-to-ID objects so the log can name each
 * calendar. An array of bare IDs is still accepted, so a config.js written
 * before names existed keeps working, with the ID standing in as the name.
 * @param {Object|string[]} setting TEAM_CALENDARS or PUBLISH_CALENDARS.
 * @return {{name: string, id: string}[]} One entry per configured calendar.
 */
function calendarEntries(setting) {
  if (!setting) return [];
  if (Array.isArray(setting)) return setting.map((id) => ({ name: id, id }));
  return Object.keys(setting).map((name) => ({ name, id: setting[name] }));
}

/** The IDs of a calendar setting, ignoring the names. */
function calendarIds(setting) {
  return calendarEntries(setting).map((entry) => entry.id);
}

/**
 * How a calendar is named in the log: the configured name, with the ID kept
 * alongside it when they differ, so the log stays greppable by either.
 */
function calendarLabel(calendar) {
  return calendar.name === calendar.id
    ? calendar.id
    : `${calendar.name} (${calendar.id})`;
}

/**
 * Removes any existing triggers for the given handler functions, so a setup
 * function can be re-run to apply a new schedule. Only the handlers named here
 * are touched, which is what lets the two scripts be scheduled in the same
 * project without disturbing each other.
 * @param {string[]} handlers Names of the handler functions to clear.
 * @return {number} How many triggers were removed.
 */
function clearTriggers(handlers) {
  let removed = 0;
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (handlers.includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      console.log("Removed existing trigger for %s", trigger.getHandlerFunction());
      removed++;
    }
  }
  return removed;
}

/**
 * Computes the window to scan, and logs it.
 * @param {Object} options The runSync()/runPublish() options.
 * @return {{today: Date, maxDate: Date}} Start and end of the window.
 */
function syncWindow(options) {
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
  return { today, maxDate, timeZone: scriptTimeZone() };
}

/**
 * Resolves STRICT_MATCH against a per-run override.
 * @param {Object} options The runSync()/runPublish() options.
 * @return {boolean} Whether strict matching applies to this run.
 */
function strictMatchFor(options) {
  return options.strictMatch === undefined ? STRICT_MATCH : options.strictMatch;
}

/**
 * Builds a memoized loader for a destination calendar's existing copies. One
 * loader per destination calendar, shared by every person synced into it, so
 * the calendar is paginated at most once per run. Imports are added to the
 * index so a later cancellation can find a series created in the same run.
 * @param {string} calendarId The destination calendar.
 * @return {function(): Object} Returns the index, loading it on first call.
 */
function importedEventsLoader(calendarId) {
  // No date bounds on the lookup: a cancelled or rescheduled source can refer
  // to a copy outside the scanned window.
  let importedEvents;
  const pending = [];
  const load = () => {
    if (!importedEvents) {
      importedEvents = listImportedEvents(calendarId);
      for (const copy of pending) indexImportedEvent(importedEvents, copy);
    }
    return importedEvents;
  };
  load.remember = (copy) => {
    if (importedEvents) indexImportedEvent(importedEvents, copy);
    else pending.push(copy);
  };
  return load;
}

/**
 * A compact date range for the log: "2026-09-15" for a single all-day event,
 * "2026-09-15..2026-09-17" for a longer one, "2026-09-15 09:00-17:00" for a
 * timed one. All-day ends are reported inclusively, unlike the exclusive end
 * date the API uses, because the log is read by people.
 * @param {Calendar.Event} event Source event or imported copy.
 * @return {string} The range, or "date unknown" for a cancellation stub that
 *     carries no start at all.
 */
function eventDates(event) {
  if (!event || !event.start || !event.end) return "date unknown";
  const repeats = event.recurrence ? ", repeats" : "";
  if (event.start.date) {
    const last = new Date(`${event.end.date}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    const until = last.toISOString().slice(0, 10);
    return (until <= event.start.date
      ? event.start.date
      : `${event.start.date}..${until}`) + repeats;
  }
  const zone = event.start.timeZone;
  const from = eventLocalParts(event.start, zone);
  const to = eventLocalParts(event.end, zone);
  if (!from.date) return event.start.dateTime + repeats;
  const hm = (time) => time.slice(0, 5);
  return (from.date === to.date
    ? `${from.date} ${hm(from.time)}-${hm(to.time)}`
    : `${from.date} ${hm(from.time)} to ${to.date} ${hm(to.time)}`) + repeats;
}

/** Sync one member's calendar; any failure leaves its checkpoint unchanged. */
function syncUserEvents(calendarId, email, events, strict, dryRun, getImportedEvents, window) {
  const username = email.split("@")[0];
  let count = 0;
  let skipped = 0;
  // API result order is unspecified. Create series before processing exceptions.
  const ordered = [...events].sort((a, b) =>
    Number(Boolean(a.recurringEventId)) - Number(Boolean(b.recurringEventId)));
  for (const event of ordered) {
    const cancelled = event.status === "cancelled";
    // Incremental scans carry no date bounds, so events from outside the window
    // come back too. Such an event is not imported, but whether its existing
    // copy should go depends on why it is outside: a copy that still agrees
    // with the source is a faithful record of time off that merely happens to
    // be in the past, and a full sync would keep it. Only a copy left behind at
    // a position the source has since abandoned is stale.
    const outside = !cancelled && window && window.incremental &&
      !sourceEventInWindow(email, event, window);
    if (outside && !hasStaleCopy(
      calendarId, email, username, event, getImportedEvents(), window,
    )) {
      console.log(
        "Outside the scan window, copy left in place: [%s] %s on %s (%s)",
        username, event.summary || "(no title)", eventDates(event), event.id,
      );
      skipped++;
      continue;
    }
    if (cancelled || outside || (strict && !isStrictMatch(event))) {
      console.log(
        "Excluded or cancelled: [%s] %s on %s (%s; %s)",
        username, event.summary || "(no title)", eventDates(event), event.id,
        cancelled ? "cancelled" :
          outside ? "rescheduled out of the scan window" : "not a strict match",
      );
      removeImportedEvent(calendarId, email, username, event, dryRun, getImportedEvents());
      skipped++;
      continue;
    }
    if (dryRun) {
      const copy = JSON.parse(JSON.stringify(event));
      if (isAllDayEvent(copy)) convertToAllDay(copy);
      console.log(
        "Would import as Free: %s on %s",
        buildSummary(username, copy), eventDates(copy),
      );
      // Recorded like a real import, so a cancellation later in the same dry
      // run can still find this series and report the occurrence it would
      // remove. 'pending' marks it as not actually present on the calendar.
      getImportedEvents.remember({
        id: `pending:${event.id}`,
        iCalUID: event.iCalUID,
        summary: buildSummary(username, copy),
        recurrence: copy.recurrence,
        start: copy.start,
        end: copy.end,
        pending: true,
        extendedProperties: { private: { awaySource: `${email}/${event.id}` } },
      });
    } else {
      getImportedEvents.remember(importEvent(calendarId, username, event, email));
    }
    count++;
  }
  return { count, skipped };
}

/**
 * Whether a source event belongs in the scan window.
 *
 * The lower edge is pulled back a day rather than using the exact moment the
 * run started, so an event that ended a few hours ago is still treated as
 * current: re-importing it is a harmless no-op, whereas treating it as outside
 * puts its copy through the staleness test needlessly.
 */
function sourceEventInWindow(email, event, window) {
  const from = new Date(window.today.getTime() - 24 * 60 * 60 * 1000);
  if (event.recurrence) {
    // The first occurrence may be years old; ask about occurrences instead.
    return hasOccurrences(email, event.id, from, window.maxDate);
  }
  return eventOverlapsWindow(event, from, window.maxDate, window.timeZone);
}

/**
 * The project's own time zone, used for date-only comparisons when the calendar
 * involved did not report one. Better than assuming UTC, which is a day out for
 * anyone far enough east or west.
 */
function scriptTimeZone() {
  try {
    return Session.getScriptTimeZone() || "UTC";
  } catch (error) {
    return "UTC";
  }
}

function hasOccurrences(calendarId, eventId, start, end) {
  let pageToken;
  do {
    const params = {timeMin: formatDateAsRFC3339(start),
      maxResults: 1, showDeleted: false, pageToken};
    if (end) params.timeMax = formatDateAsRFC3339(end);
    const response = Calendar.Events.instances(calendarId, eventId, params);
    if ((response.items || []).some((item) => item.status !== "cancelled")) return true;
    pageToken = response.nextPageToken;
  } while (pageToken);
  return false;
}

/** Date-only boundaries use the given zone, falling back to the project's. */
function eventOverlapsWindow(event, start, end, timeZone) {
  timeZone = timeZone || scriptTimeZone();
  if (!event.start || !event.end) return false;
  if (event.start.date) {
    return event.end.date > Utilities.formatDate(start, timeZone, "yyyy-MM-dd") &&
      (!end || event.start.date <= Utilities.formatDate(end, timeZone, "yyyy-MM-dd"));
  }
  return new Date(event.end.dateTime) > start &&
    (!end || new Date(event.start.dateTime) < end);
}

function copyOverlapsWindow(calendarId, copy, start, end, timeZone) {
  if (copy.status === "cancelled") return false;
  return copy.recurrence ? hasOccurrences(calendarId, copy.id, start, end) :
    eventOverlapsWindow(copy, start, end, timeZone);
}

/** A full source snapshot can repair copies missed by earlier incremental runs. */
function reconcileMissingEvents(calendarId, email, events, window, dryRun, index) {
  const present = new Set(events.map((event) => `${email}/${event.id}`));
  for (const [source, copies] of index.bySource) {
    if (!source.startsWith(`${email}/`) || present.has(source)) continue;
    for (const copy of copies) {
      if (copyOverlapsWindow(calendarId, copy, window.today, window.maxDate, index.timeZone)) {
        removeCopy(calendarId, copy, dryRun);
      }
    }
  }
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
  const start = eventLocalParts(event.start, event.start.timeZone);
  const end = eventLocalParts(event.end, event.start.timeZone);
  let endDate = end.date;
  if (end.time.startsWith("23:59:")) {
    const next = new Date(`${end.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    endDate = next.toISOString().slice(0, 10);
  }
  event.start = { date: start.date };
  event.end = { date: endDate };
}

/**
 * Decides whether an event covers whole days. Ordinary all-day events use a
 * date-only 'date' field, but out-of-office events always carry a 'dateTime'
 * even when created as full-day, so those are detected by checking that they
 * start at midnight and end at midnight (or 23:59).
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
  const start = eventLocalParts(event.start, event.start.timeZone);
  const end = eventLocalParts(event.end, event.start.timeZone);
  return start.time === "00:00:00" &&
    ((end.time === "00:00:00" && end.date > start.date) ||
      (end.time.startsWith("23:59:") && end.date >= start.date));
}

/** Returns local date/time using the event zone or its explicit UTC offset. */
function eventLocalParts(boundary, timeZone) {
  if (timeZone || boundary.timeZone) {
    const date = new Date(boundary.dateTime);
    const zone = timeZone || boundary.timeZone;
    return {
      date: Utilities.formatDate(date, zone, "yyyy-MM-dd"),
      time: Utilities.formatDate(date, zone, "HH:mm:ss"),
    };
  }
  const match = boundary.dateTime.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    return { date: "", time: "" };
  }
  return { date: match[1], time: match[2] };
}

/** Read the given team calendar once and index copies for local matching. */
function listImportedEvents(calendarId) {
  const index = { bySource: new Map(), byId: new Map(), byUID: new Map() };
  let pageToken;
  do {
    const response = Calendar.Events.list(calendarId, {
      pageToken, maxResults: 2500, showDeleted: false,
    });
    if (response.timeZone) index.timeZone = response.timeZone;
    for (const copy of response.items || []) {
      if (copy.status === "cancelled") continue;
      indexImportedEvent(index, copy);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return index;
}

function indexImportedEvent(index, copy) {
  const add = (map, key) => {
    if (!key) return;
    const copies = map.get(key) || [];
    const position = copies.findIndex((item) => item.id === copy.id);
    if (position === -1) copies.push(copy);
    else copies[position] = copy;
    map.set(key, copies);
  };
  const properties = copy.extendedProperties && copy.extendedProperties.private;
  add(index.bySource, properties && properties.awaySource);
  add(index.byId, copy.id);
  add(index.byUID, copy.iCalUID);
}

function removeCopy(calendarId, copy, dryRun) {
  if (copy.status === "cancelled") return;
  if (dryRun) {
    console.log(
      "Would remove: %s on %s (%s)",
      copy.summary, eventDates(copy),
      copy.pending ? "would be created in this run" : copy.id,
    );
    // Marked here too, so a copy reached by two different paths in one dry run
    // is only reported once.
    copy.status = "cancelled";
  } else {
    Calendar.Events.remove(calendarId, copy.id);
    copy.status = "cancelled";
    console.log("Removed: %s on %s (%s)", copy.summary, eventDates(copy), copy.id);
  }
}

/**
 * The copies of one source event that this script is entitled to delete.
 * @return {Calendar.Event[]} Matching copies, tagged ones preferred.
 */
function importedCopiesFor(email, username, event, index) {
  const tagged = index.bySource.get(`${email}/${event.id}`) || [];
  if (tagged.length) return tagged;
  // Legacy copies have no source tag. Retain the ID/UID and title checks,
  // without making requests for each excluded source event.
  const isLegacyCopy = (copy) =>
    !(copy.extendedProperties && copy.extendedProperties.private &&
      copy.extendedProperties.private.awaySource) &&
    (copy.summary || "").startsWith(`[${username}] `);
  const byId = (index.byId.get(event.id) || []).filter(isLegacyCopy);
  if (byId.length) return byId;
  if (event.iCalUID && !event.recurringEventId) {
    return (index.byUID.get(event.iCalUID) || []).filter(
      (copy) => !copy.recurringEventId && isLegacyCopy(copy),
    );
  }
  return [];
}

/**
 * Where an import of this event would sit on the destination, accounting for
 * the whole-day rewrite that import applies.
 */
function expectedCopyTimes(event) {
  const copy = JSON.parse(JSON.stringify(event));
  if (isAllDayEvent(copy)) convertToAllDay(copy);
  return { start: copy.start, end: copy.end };
}

function boundaryKey(boundary) {
  if (!boundary) return "";
  if (boundary.date) return boundary.date;
  return boundary.dateTime ? new Date(boundary.dateTime).toISOString() : "";
}

/**
 * Whether an existing copy still sits where the source event now says it
 * should. A copy that matches is a faithful record, even if it falls outside
 * the scan window; one that does not is a leftover of an earlier position.
 */
function copyMatchesSource(copy, expected) {
  return boundaryKey(copy.start) === boundaryKey(expected.start) &&
    boundaryKey(copy.end) === boundaryKey(expected.end);
}

/**
 * Whether two event boundaries denote the same point, tolerating one being
 * date-only and the other timed.
 */
function sameBoundary(a, b, timeZone) {
  if (!a || !b) return false;
  if (a.date && b.date) return a.date === b.date;
  if (a.dateTime && b.dateTime) {
    return new Date(a.dateTime).getTime() === new Date(b.dateTime).getTime();
  }
  const dated = a.date ? a : b;
  const timed = a.date ? b : a;
  if (!timed.dateTime) return false;
  return dated.date === eventLocalParts(timed, timed.timeZone || timeZone).date;
}

/**
 * True when a copy exists that no longer agrees with the source event. Only
 * asked about sources already known to fall outside the scan window.
 */
function hasStaleCopy(calendarId, email, username, event, index, window) {
  if (event.recurringEventId && event.originalStartTime) {
    // The copy of a single occurrence belongs to the imported series, so it
    // carries the master's tag and its own destination id: the lookup below
    // cannot see it. It is stale exactly when the occurrence has moved away
    // from the slot the copy still occupies, which is also the one case
    // removeImportedEvent() can resolve through the master's instances.
    return !sameBoundary(
      event.start, event.originalStartTime, window && window.timeZone,
    );
  }
  const expected = expectedCopyTimes(event);
  return importedCopiesFor(email, username, event, index).some((copy) => {
    if (copy.status === "cancelled") return false;
    // A copied series generates occurrences of its own from its own recurrence
    // rule. If any of them land in the window that the source no longer
    // covers, the copy is showing time off that is not happening.
    if (copy.recurrence && !copy.pending) {
      return copyOverlapsWindow(
        calendarId, copy, window.today, window.maxDate, index.timeZone,
      );
    }
    return !copyMatchesSource(copy, expected);
  });
}

/** Remove only copies identifiable as this script's imports. */
function removeImportedEvent(calendarId, email, username, event, dryRun, index) {
  const candidates = importedCopiesFor(email, username, event, index);
  const isLegacyCopy = (copy) =>
    !(copy.extendedProperties && copy.extendedProperties.private &&
      copy.extendedProperties.private.awaySource) &&
    (copy.summary || "").startsWith(`[${username}] `);
  for (const copy of candidates) removeCopy(calendarId, copy, dryRun);

  if (event.recurringEventId && event.originalStartTime) {
    const masters = index.bySource.get(`${email}/${event.recurringEventId}`) ||
      (index.byId.get(event.recurringEventId) || []).filter(isLegacyCopy);
    for (const master of masters) {
      if (master.status === "cancelled" || !master.recurrence) continue;
      // A whole-day OOO series was converted from timed to date-only on import.
      const original = event.originalStartTime;
      const originalStart = master.start.date
        ? original.date || eventLocalParts(original, original.timeZone).date
        : original.dateTime;
      if (!originalStart) {
        // Throwing here would leave the checkpoint unadvanced, so the same
        // malformed exception would come back and fail the member on every
        // later run. One unreconciled occurrence is the smaller problem.
        console.warn(
          "Cannot place occurrence %s of %s: unusable originalStartTime %s",
          event.id, master.id, JSON.stringify(original),
        );
        continue;
      }
      if (master.pending) {
        // The series itself would only be created by this same dry run, so
        // there is nothing to enumerate on the calendar.
        console.log(
          "Would remove the %s occurrence of %s", originalStart, master.summary,
        );
        continue;
      }
      let pageToken;
      do {
        const response = Calendar.Events.instances(calendarId, master.id, {
          originalStart, showDeleted: false, pageToken,
        });
        for (const instance of response.items || []) removeCopy(calendarId, instance, dryRun);
        pageToken = response.nextPageToken;
      } while (pageToken);
    }
  }
}

/**
 * Imports the given event from the user's calendar into the shared team
 * calendar.
 * @param {string} calendarId The team calendar to import into.
 * @param {string} username The team member that is attending the event.
 * @param {Calendar.Event} event The event to import.
 * @param {string} email The team member's email address.
 */
function importEvent(calendarId, username, event, email) {
  event = JSON.parse(JSON.stringify(event));
  event.extendedProperties = { private: { awaySource: `${email}/${event.id}` } };
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
    id: calendarId,
  };
  event.attendees = [];
  event.transparency = "transparent"; // Show as Free on the team calendar.
  // Someone else's time off should never raise a notification. Without this the
  // copy keeps the source event's reminders, and a copy arriving with
  // 'useDefault: true' picks up the team calendar's own default reminders,
  // which would alert everyone subscribed to it. An empty override list with
  // the default disabled means no reminders at all.
  event.reminders = { useDefault: false, overrides: [] };

  // If the event is not of type 'default', it can't be imported, so it needs
  // to be changed.
  if (event.eventType !== "default") {
    event.eventType = "default";
    event.outOfOfficeProperties = undefined;
    event.focusTimeProperties = undefined;
  }

  console.log("Importing: %s on %s", event.summary, eventDates(event));
  // Let failures reach the per-user handler so this calendar is retried.
  return Calendar.Events.import(event, calendarId);
}

/**
 * Lists out-of-office events. Full scans use the date range; incremental scans
 * fetch all changes, including events moved out of that range. Matching and
 * window filtering happen in syncUserEvents(), where old copies can be removed.
 * @param {string} email The email address of the user to retrieve events for.
 * @param {Date} start The starting date of the range to examine.
 * @param {Date} end The ending date of the range to examine.
 * @param {Date} optSince A date indicating the last time this script was run.
 * @return {Calendar.Event[]} An array of calendar events.
 */
function findEvents(email, start, end, optSince) {
  const params = {
    eventTypes: "outOfOffice",
    showDeleted: true,
  };
  if (optSince) {
    // Combining updatedMin with date bounds would hide rescheduled events.
    params.updatedMin = formatDateAsRFC3339(optSince);
  } else {
    params.timeMin = formatDateAsRFC3339(start);
    params.timeMax = formatDateAsRFC3339(end);
  }
  let pageToken = null;
  let events = [];
  do {
    params.pageToken = pageToken;
    const response = Calendar.Events.list(email, params);
    events = events.concat(response.items || []);
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
  return date.toISOString();
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
