# Away calendar sync

A Google Apps Script that keeps one or more shared team calendars in sync with
the out-of-office events on each team member's personal calendar. It is derived
from Google's [vacation calendar
sample](https://developers.google.com/apps-script/samples/automations/vacation-calendar),
with a few substantial changes (see [Differences from the Google
sample](#differences-from-the-google-sample)).

## Repository layout

```
scripts/
  sync-team-calendar.js   the script itself
  config.dist.js          settings template, tracked
  config.js               your settings, gitignored
tests/
  sync-team-calendar.test.cjs
```

`scripts/` holds exactly the files that get uploaded to the Apps Script
project; everything else is local tooling.

## How it works

Each calendar listed in `TEAM_CALENDAR_IDS` is synced independently, and the
steps below run once per calendar.

1. The script reads the ACL of the team calendar and collects every individual
   user with write access (`writer` or `owner`). Those users are the team:
   there is no group membership lookup, so adding or removing someone from the
   sync is done by sharing or unsharing the team calendar. Group, domain and
   public ACL entries are ignored, as is the calendar's entry for itself.
2. For each of those users it lists the out-of-office events
   (`eventTypes: outOfOffice`) on their personal calendar, from today up to
   `MONTHS_IN_ADVANCE` months ahead.
3. Events that qualify (see [Matching rules](#matching-rules)) are imported
   into the team calendar as `[username] Away`, shown as **Free** so they do
   not affect anyone's availability, and with reminders disabled so nobody is
   notified about someone else's time off.
4. Events that no longer qualify — cancelled, renamed out of the keyword list —
   have their previously imported copy removed from the team calendar.

Some details worth knowing:

- **Multiple team calendars.** `TEAM_CALENDAR_IDS` can hold any number of
  calendars. Each has its own ACL, so each has its own membership; someone who
  is an editor on two of them has their time off copied to both. Checkpoints
  are keyed per calendar and per person, and a calendar that cannot be read is
  logged and reported at the end without blocking the others.
- **Per-user checkpoints.** Each personal calendar has its own "last run"
  timestamp stored in script properties (`lastRun:<team calendar>:<email>`).
  Incremental runs only look at events modified since that timestamp. If one
  calendar fails (revoked access, API error), its checkpoint is left untouched
  so the next run retries it, while the other calendars still advance.
- **No reminders, no invitations.** Copies are written with
  `reminders: { useDefault: false, overrides: [] }` and an empty attendee list.
  Without the explicit reminder override a copy would inherit the source
  event's reminders, and one arriving with `useDefault: true` would pick up the
  team calendar's default reminders and alert every subscriber.
- **Import tagging.** Every copy carries
  `extendedProperties.private.awaySource = "<email>/<source event id>"`, which
  is how the script recognises its own events later. Untagged copies from
  earlier versions are still matched by event ID or iCalUID plus an
  `[username] ` title prefix, so nothing else on the calendar is ever deleted.
- **All-day handling.** Full-day out-of-office events are returned by the API
  with a `dateTime`, not a `date`, so importing them verbatim would produce
  timed 00:00–23:59 blocks. The script detects whole-day ranges (including
  across DST transitions) and rewrites them as real all-day events.
- **Locking.** Runs take a script lock, so an hourly trigger firing while a
  full sync is still running will wait rather than double-import.

### Matching rules

| Event on personal calendar | `STRICT_MATCH = true` | `STRICT_MATCH = false` |
| --- | --- | --- |
| All-day out-of-office | imported | imported |
| Timed out-of-office, title contains a keyword | imported | imported |
| Timed out-of-office, title without a keyword | skipped | imported |
| Cancelled | removed from team calendar | removed from team calendar |

Only events of type "out of office" are considered at all; regular events are
never read, whatever their title.

## Entry points

These are the functions to run from the Apps Script editor's function picker.

| Function | What it does |
| --- | --- |
| `setup` | Creates the triggers (hourly `sync`, nightly `fullSync` at 03:00) and performs a first full sync. Fails if triggers already exist. |
| `sync` | Incremental sync: only events modified since each calendar's last run. This is what the hourly trigger calls. |
| `fullSync` | Re-scans the whole window, ignoring checkpoints. Catches events created outside the window that have since slid into it without being modified. |
| `testSync` | **Dry run** over the next 7 days: logs what would be imported and removed, writes nothing, and does not move any checkpoint. Run this first after configuring. |
| `inspectEvents` | Diagnostic: dumps the raw start/end of every out-of-office event in the next 30 days, with the verdict of the all-day and strict-match checks. |
| `diagnoseCalendarAccess` | Diagnostic: checks that every calendar in `TEAM_CALENDAR_IDS` is reachable by the account running the script and reports its access role. Use when ACL reads fail with "Not Found". |
| `listCalendarAccess` | Diagnostic: lists every ACL entry of each team calendar grouped by role, so you can see who will be synced and which entries are skipped. |

## Configuration

All settings live in `scripts/config.js`, which is **not tracked in git**.
Copy `scripts/config.dist.js` to `scripts/config.js` and edit the values
there.

| Setting | Default | Meaning |
| --- | --- | --- |
| `TEAM_CALENDAR_IDS` | — | List of the shared calendars events are copied to. Find each ID in the calendar's settings under *Integrate calendar* → *Calendar ID*. |
| `MEMBER_ROLES` | `["writer", "owner"]` | ACL roles that identify a team member whose calendar should be scanned. `writer` is "Make changes to events", `owner` is "Make changes and manage sharing". |
| `KEYWORDS` | `["vacation", "ooo", "pto", "wellness", "holiday", "on leave"]` | Lowercase title fragments that mark a *timed* event as time off. Only used when `STRICT_MATCH` is true. |
| `MONTHS_IN_ADVANCE` | `3` | How far ahead to look for events. |
| `STRICT_MATCH` | `true` | When true, timed events need a keyword in the title; all-day events always qualify. When false, every out-of-office event in the window is imported. |
| `SANITIZE_EVENTS` | `true` | When true, the original title, description and location are dropped and the copy is titled `[username] <SANITIZED_TITLE>`, keeping private details off the shared calendar. When false, the original title is kept, prefixed with `[username]`. |
| `SANITIZED_TITLE` | `"Away"` | Title used for imported events when `SANITIZE_EVENTS` is true. |

In Apps Script all files share a single global scope, so the constants defined
in `scripts/config.js` are visible to `scripts/sync-team-calendar.js` with no
import.

## Setup

1. **Create the team calendar** (or pick an existing one) in Google Calendar.
   Note its calendar ID from *Settings and sharing* → *Integrate calendar*.
   Repeat for each team calendar you want to feed.
2. **Share it with the team.** Give each person who should be synced *Make
   changes to events* or *Make changes and manage sharing*. The ACL is the
   membership list.
3. **Create the Apps Script project.** Either a standalone script at
   [script.google.com](https://script.google.com), or push this directory with
   [`clasp`](https://github.com/google/clasp).
4. **Configure.** `cp scripts/config.dist.js scripts/config.js`, set
   `TEAM_CALENDAR_IDS` and review the other settings.
5. **Add the files to the project.** Everything in `scripts/`, that is
   `config.js` and `sync-team-calendar.js`. Tests live in `tests/`, outside
   that directory, precisely because they should not be uploaded.
6. **Confirm the Calendar advanced service is enabled.** Check the *Services*
   panel in the editor's sidebar: `Calendar` should be listed. If you created
   the project by copying Google's vacation-calendar sample, this is already
   done and there is nothing to change. Only a project started from scratch
   needs it added — *Services* → **+** → *Google Calendar API*, added as
   `Calendar` — or, when pushing with `clasp`, declared in `appsscript.json`:

   ```json
   {
     "dependencies": {
       "enabledAdvancedServices": [
         { "userSymbol": "Calendar", "serviceId": "calendar", "version": "v3" }
       ]
     }
   }
   ```

   The script calls the advanced service (`Calendar.Events.import`,
   `Calendar.Acl.list`) rather than `CalendarApp`, and the `Calendar` symbol
   does not exist without it, so a project missing the service fails on the
   first run with `ReferenceError: Calendar is not defined`.
7. **Check access.** Run `diagnoseCalendarAccess`. The first time you run any
   function, Apps Script shows the OAuth consent screen; review the scopes and
   accept. Scopes are never declared by hand — they are inferred from the code,
   which is why the Calendar service has to be in place before this.
   Reading the ACL requires the running account to have the `owner` role on the
   team calendar, for each calendar listed; if the report shows a lesser role,
   fix the sharing before continuing. Then run `listCalendarAccess` to confirm the expected people are
   listed.
8. **Dry run.** Run `testSync` and read the execution log. It reports the window
   it scanned and, for the next 7 days, what it would import and remove. Nothing
   is written.
9. **Go live.** Run `setup`. This creates the hourly and nightly triggers and
   performs a first full sync. To change the schedule later, delete the triggers
   under *Triggers* in the editor and run `setup` again.

The account running the script must be able to read the team members' calendars
— in a Google Workspace domain this is normally the case for free/busy plus
out-of-office details; if a calendar is not readable, the sync logs an error for
that person and carries on.

## Tests

```
node tests/sync-team-calendar.test.cjs
```

The tests run `scripts/sync-team-calendar.js` in a `vm` context with stubbed
Apps Script services (`Calendar`, `PropertiesService`, `LockService`,
`Utilities`). They load `scripts/config.dist.js`, not `scripts/config.js`, so a
local configuration cannot change the outcome. No dependencies beyond Node.

## Differences from the Google sample

- Team membership comes from each team calendar's ACL, not from a Google Group.
- Any number of team calendars, synced independently from one project.
- Per-calendar checkpoints, so one failing calendar does not stall or skip the
  others.
- Imported copies are tagged, and copies are removed again when the source
  event is cancelled or stops matching.
- Full-day out-of-office events are rewritten as real all-day events.
- Optional sanitising of titles, descriptions and locations.
- Dry-run and diagnostic entry points, a script lock, and a unit test suite.

## License

Apache License 2.0, inherited from the Google sample this is based on.
