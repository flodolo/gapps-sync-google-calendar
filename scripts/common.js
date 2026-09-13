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
  return { today, maxDate };
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
 * the calendar is paginated at most once per run and only when an exclusion
 * actually needs reconciling.
 * @param {string} calendarId The destination calendar.
 * @return {function(): Object} Returns the index, loading it on first call.
 */
function importedEventsLoader(calendarId) {
  // No date bounds on the lookup: a cancelled or rescheduled source can refer
  // to a copy outside the scanned window.
  let importedEvents;
  return () => {
    if (!importedEvents) importedEvents = listImportedEvents(calendarId);
    return importedEvents;
  };
}

/** Sync one member's calendar; any failure leaves its checkpoint unchanged. */
function syncUserEvents(calendarId, email, events, strict, dryRun, getImportedEvents) {
  const username = email.split("@")[0];
  let count = 0;
  let skipped = 0;
  for (const event of events) {
    if (event.status === "cancelled" || (strict && !isStrictMatch(event))) {
      console.log(
        "Excluded or cancelled: [%s] %s (%s; %s)",
        username, event.summary || "(no title)", event.id,
        event.status === "cancelled" ? "cancelled" : "not a strict match",
      );
      removeImportedEvent(calendarId, email, username, event, dryRun, getImportedEvents());
      skipped++;
      continue;
    }
    if (dryRun) {
      const copy = JSON.parse(JSON.stringify(event));
      if (isAllDayEvent(copy)) convertToAllDay(copy);
      console.log(
        "Would import as Free: %s (%s to %s%s)",
        buildSummary(username, copy),
        copy.start.date || copy.start.dateTime,
        copy.end.date || copy.end.dateTime,
        copy.start.date ? ", all day; end exclusive" : "",
      );
    } else {
      importEvent(calendarId, username, event, email);
    }
    count++;
  }
  return { count, skipped };
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
  const add = (map, key, event) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  };
  let pageToken;
  do {
    const response = Calendar.Events.list(calendarId, {
      pageToken, maxResults: 2500, showDeleted: false,
    });
    for (const copy of response.items || []) {
      if (copy.status === "cancelled") continue;
      const source = copy.extendedProperties && copy.extendedProperties.private;
      add(index.bySource, source && source.awaySource, copy);
      add(index.byId, copy.id, copy);
      add(index.byUID, copy.iCalUID, copy);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return index;
}

/** Remove only copies identifiable as this script's imports. */
function removeImportedEvent(calendarId, email, username, event, dryRun, index) {
  let candidates = index.bySource.get(`${email}/${event.id}`) || [];
  // Legacy copies have no source tag. Retain the ID/UID and title checks,
  // without making requests for each excluded source event.
  const isLegacyCopy = (copy) =>
    !(copy.extendedProperties && copy.extendedProperties.private &&
      copy.extendedProperties.private.awaySource) &&
    (copy.summary || "").startsWith(`[${username}] `);
  if (!candidates.length) {
    candidates = (index.byId.get(event.id) || []).filter(isLegacyCopy);
  }
  if (!candidates.length && event.iCalUID && !event.recurringEventId) {
    candidates = (index.byUID.get(event.iCalUID) || []).filter(
      (copy) => !copy.recurringEventId && isLegacyCopy(copy),
    );
  }
  for (const copy of candidates) {
    if (copy.status === "cancelled") continue;
    if (dryRun) {
      console.log("Would remove: %s (%s)", copy.summary, copy.id);
    } else {
      Calendar.Events.remove(calendarId, copy.id);
      copy.status = "cancelled";
      console.log("Removed: %s (%s)", copy.summary, copy.id);
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

  console.log("Importing: %s", event.summary);
  // Let failures reach the per-user handler so this calendar is retried.
  Calendar.Events.import(event, calendarId);
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
