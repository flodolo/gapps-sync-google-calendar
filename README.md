# Away calendar sync

Google Apps Script automations that copy out-of-office events onto shared
calendars, so a team can see who is away without maintaining it by hand.
Derived from Google's [vacation calendar
sample](https://developers.google.com/apps-script/samples/automations/vacation-calendar).

Two scripts share one code base and one configuration:

| Script | Direction | Access it needs |
| --- | --- | --- |
| `sync-team-calendar.js` | **Pull** the whole team's time off into the team calendars | `owner` on each team calendar, to read its ACL |
| `publish-my-time-off.js` | **Push** only *your* time off to shared calendars | `writer` on each destination |

Use the first when you administer a calendar and want it to reflect everyone
with write access to it. Use the second for calendars you only contribute to —
it reads nobody's calendar but your own. Enable either, or both.

## Repository layout

```
scripts/
  common.js               helpers shared by both scripts
  sync-team-calendar.js   pull the team's time off into team calendars
  publish-my-time-off.js  push your own time off to shared calendars
  config.dist.js          settings template, tracked
  config.js               your settings, gitignored
tests/
  helpers.cjs             stubbed Apps Script services for all suites
  *.test.cjs
```

`scripts/` holds exactly the files uploaded to the Apps Script project;
everything else is local tooling.

## How it works

**`sync-team-calendar.js`** runs once per calendar in `TEAM_CALENDARS`:

1. Reads the calendar's ACL and collects every individual user with write
   access. That is the team — there is no group lookup, so you add and remove
   people by sharing and unsharing the calendar. Group, domain and public ACL
   entries are ignored, as is the calendar's entry for itself.
2. Lists each member's out-of-office events (`eventTypes: outOfOffice`) from
   today to `MONTHS_IN_ADVANCE` months ahead.
3. Imports the ones that qualify (see [Matching rules](#matching-rules)) as
   `[username] Away`.
4. Removes a previously imported copy when its source is cancelled, stops
   matching, or is rescheduled out of the window.
5. When a member loses write access, removes their future copies before
   discarding their checkpoint.

**`publish-my-time-off.js`** runs once per calendar in `PUBLISH_CALENDARS`, and
the source is always the account running it (`Session.getEffectiveUser()`).
Steps 2–4 above apply unchanged; there is no ACL lookup, which is why write
access to the destination is enough.

Listing the same calendar in both settings is harmless: copies are matched by
source event, so the two scripts converge on one copy, and they keep separate
checkpoints (`lastRun:…` and `lastPublish:…`).

### Matching rules

| Event on personal calendar | `STRICT_MATCH = true` | `STRICT_MATCH = false` |
| --- | --- | --- |
| All-day out-of-office | imported | imported |
| Timed, title contains a keyword | imported | imported |
| Timed, title without a keyword | skipped | imported |
| Cancelled | copy removed | copy removed |

Only events of type "out of office" are read at all; regular events are never
touched, whatever their title.

### Behavior notes

- **Copies are inert.** Shown as **Free**, with
  `reminders: { useDefault: false, overrides: [] }` and no attendees, so nobody
  is notified about someone else's time off. Without the explicit reminder
  override a copy inherits the source's reminders, and one with
  `useDefault: true` picks up the team calendar's defaults and alerts every
  subscriber.
- **Checkpoints are per calendar and per person**
  (`lastRun:<calendar id>:<email>`), and incremental runs only look at events
  modified since. A calendar or person that fails keeps its checkpoint, so the
  next run retries it while everything else advances.
- **History is preserved.** An event outside the window whose copy still
  matches it is left alone — that copy is an accurate record. Only a copy
  stranded at a position the source has abandoned is removed. A moved
  occurrence is judged against its original start, since its copy belongs to
  the imported series.
- **Recurring events.** Cancelling one occurrence removes only that occurrence,
  including in series rewritten as all-day. Cleanup checks occurrences rather
  than the series' original start date.
- **Departed members.** Their checkpoint is dropped only after their copies are
  successfully removed, and never while `PUBLISH_CALENDARS` shows they still
  publish to that calendar. If the ACL returns *no* individual users, nothing
  is cleaned up: a calendar switched to group sharing looks identical to the
  whole team leaving.
- **Import tagging.** Every copy carries
  `extendedProperties.private.awaySource = "<email>/<source event id>"`, which
  is how the script recognizes its own events. Untagged copies from earlier
  versions are matched by event ID or iCalUID plus an `[username] ` prefix, so
  nothing else on the calendar is ever deleted.
- **All-day handling.** Full-day out-of-office events come back from the API
  with a `dateTime`, so importing them verbatim would produce timed 00:00–23:59
  blocks. Whole-day ranges are detected (including across DST) and rewritten as
  real all-day events. Date-only comparisons use the destination calendar's
  time zone, or the script project's if the API reports none.
- **Locking.** Runs take a script lock shared by both scripts and wait up to 30
  seconds, so a trigger firing mid-run waits rather than double-importing.

## Entry points

Functions to run from the editor's function picker.

| `sync-team-calendar.js` | What it does |
| --- | --- |
| `setup` | Creates this script's triggers and runs a first full sync. Safe to re-run: replaces its own triggers, leaves the other script's alone. |
| `sync` | Incremental sync. What the daily trigger calls. |
| `fullSync` | Re-scans the whole window, ignoring checkpoints. Catches events that slid into the window without being modified. |
| `testSync` | **Dry run** over 7 days: logs what would change, writes nothing. Run this first. |
| `inspectEvents` | Diagnostic: raw start/end of every out-of-office event in the next 30 days, with the all-day and strict-match verdicts. |
| `diagnoseCalendarAccess` | Diagnostic: whether each team calendar is reachable, and with which role. Use when ACL reads fail with "Not Found". |
| `listCalendarAccess` | Diagnostic: every ACL entry per calendar, grouped by role. |

| `publish-my-time-off.js` | What it does |
| --- | --- |
| `setupPublish` | As `setup`, for this script's own triggers. |
| `publishMyTimeOff` | Incremental publish. |
| `fullPublishMyTimeOff` | Re-scans the whole window, ignoring checkpoints. |
| `testPublishMyTimeOff` | **Dry run** over 7 days. |
| `diagnosePublishAccess` | Diagnostic: whether each destination is reachable and writable. |

Both scripts run incrementally every day between 08:00 and 09:00, with a full
re-scan on Monday between 07:00 and 08:00. Apps Script only lets you pick the
hour, so these are windows, in the script project's time zone.

## Configuration

All settings live in `scripts/config.js`, which is **not tracked in git**. Copy
`scripts/config.dist.js` to `scripts/config.js` and edit it there. In Apps
Script every file shares one global scope, so the constants need no import.

| Setting | Default | Meaning |
| --- | --- | --- |
| `TEAM_CALENDARS` | `{}` | Calendars the team's time off is pulled into, as display name → calendar ID. Empty disables the team sync. |
| `PUBLISH_CALENDARS` | `{}` | Calendars your own time off is pushed to, same form. Empty disables that script. |
| `MEMBER_ROLES` | `["writer", "owner"]` | ACL roles that identify a team member whose calendar should be scanned. |
| `KEYWORDS` | `["vacation", "ooo", "pto", …]` | Lowercase title fragments marking a *timed* event as time off. Only used when `STRICT_MATCH` is true. |
| `MONTHS_IN_ADVANCE` | `3` | How far ahead to look. |
| `STRICT_MATCH` | `true` | When true, timed events need a keyword; all-day events always qualify. When false, every out-of-office event qualifies. |
| `SANITIZE_EVENTS` | `true` | When true, drops the original title, description and location, titling the copy `[username] <SANITIZED_TITLE>`. When false, keeps the original title with a `[username]` prefix. |
| `SANITIZED_TITLE` | `"Away"` | Title used when `SANITIZE_EVENTS` is true. |

Both calendar settings map a display name to a calendar ID, found in the
calendar's settings under *Integrate calendar* → *Calendar ID*:

```js
const TEAM_CALENDARS = {
  "Localization": "abc123@group.calendar.google.com",
  "Add-ons": "def456@group.calendar.google.com",
};
```

Names only make the log readable — runs report `Team calendar: Localization
(abc123@…)` instead of a bare ID. Checkpoints key on the ID, so renaming costs
nothing. A plain array of IDs is still accepted, so a `config.js` predating the
names keeps working.

## Setup

Steps 1–2 are only for the team sync; to publish your own time off, just note
the IDs of the calendars you want to publish to.

1. **Create or pick the team calendar.** Note its ID from *Settings and
   sharing* → *Integrate calendar*. Repeat per calendar.
2. **Share it with the team.** Give everyone who should be synced *Make changes
   to events* or *Make changes and manage sharing*. The ACL is the membership
   list.
3. **Create the Apps Script project**, either at
   [script.google.com](https://script.google.com) or by pushing this directory
   with [`clasp`](https://github.com/google/clasp).
4. **Configure.** `cp scripts/config.dist.js scripts/config.js`, then set
   `TEAM_CALENDARS` and/or `PUBLISH_CALENDARS`. Either can stay empty.
5. **Add the files to the project**: `config.js`, `common.js`, and whichever
   scripts you are using. Tests stay out of `scripts/` because they must not be
   uploaded.
6. **Confirm the Calendar advanced service is enabled.** The *Services* panel
   should list `Calendar`; it already will if you copied Google's sample. A
   project started from scratch needs it added there as *Google Calendar API*,
   or declared in `appsscript.json` when using `clasp`:

   ```json
   {
     "dependencies": {
       "enabledAdvancedServices": [
         { "userSymbol": "Calendar", "serviceId": "calendar", "version": "v3" }
       ]
     }
   }
   ```

   The scripts use the advanced service rather than `CalendarApp`, and the
   `Calendar` symbol does not exist without it, so a project missing it fails
   on the first run with `ReferenceError: Calendar is not defined`.
7. **Check access.** The first run shows the OAuth consent screen; scopes are
   inferred from the code, which is why step 6 comes first. Then run
   `diagnoseCalendarAccess` (the team sync needs `owner` on each team calendar
   to read its ACL) and `listCalendarAccess`, or `diagnosePublishAccess` for
   publishing.
8. **Dry run.** `testSync` and/or `testPublishMyTimeOff`, then read the log.
   Nothing is written.
9. **Go live.** `setup` and/or `setupPublish`. Each creates its own triggers and
   runs once. To change a schedule, edit the setup function and run it again.

The team sync also needs to be able to read members' calendars, which a Google
Workspace domain normally allows for free/busy and out-of-office details; an
unreadable calendar is logged and skipped. Publishing reads only your own.

## Tests

```
node tests/sync-team-calendar.test.cjs
node tests/publish-my-time-off.test.cjs
node tests/reconciliation.test.cjs
```

Each suite runs its scripts plus `common.js` in a `vm` context with the Apps
Script services stubbed by `tests/helpers.cjs`, against `config.dist.js` rather
than your `config.js`, on a fixed clock so date-window assertions are stable.
No dependencies beyond Node. All suites run in CI on every push to `main` and
every pull request.

## Differences from the Google sample

- Membership comes from each calendar's ACL, not a Google Group, and any number
  of calendars sync independently.
- A second script publishes only your own time off to calendars you do not
  administer.
- Copies are tagged, kept in step with their source, and removed when it is
  cancelled or stops matching; per-calendar checkpoints keep one failure from
  stalling the rest.
- Full-day events are rewritten as real all-day events, titles and details can
  be sanitized, and there are dry-run and diagnostic entry points, a script
  lock, and tests.

## License

Apache License 2.0, inherited from the Google sample this is based on.
