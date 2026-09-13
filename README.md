# Away calendar sync

Google Apps Script automations that copy out-of-office events onto shared
calendars, so a team can see who is away without anyone maintaining it by hand.
Two scripts share one code base and one configuration:

| Script | Direction | Access it needs |
| --- | --- | --- |
| `sync-team-calendar.js` | **Pull** the whole team's time off into the team calendars | Administrative (`owner`) on each team calendar, to read its ACL |
| `publish-my-time-off.js` | **Push** only *your* time off to shared calendars | Write access (`writer`) on each destination |

Use the first when you administer a calendar and want it to reflect everyone
who has write access to it. Use the second when you want your own time off to
appear on calendars you merely contribute to — it never reads anyone else's
calendar, so it needs no special access. They are independent: enable either,
or both. It is derived
from Google's [vacation calendar
sample](https://developers.google.com/apps-script/samples/automations/vacation-calendar),
with a few substantial changes (see [Differences from the Google
sample](#differences-from-the-google-sample)).

## Repository layout

```
scripts/
  common.js               helpers shared by both scripts
  sync-team-calendar.js   pull the team's time off into team calendars
  publish-my-time-off.js  push your own time off to shared calendars
  config.dist.js          settings template, tracked
  config.js               your settings, gitignored
tests/
  helpers.cjs             stubbed Apps Script services for both suites
  sync-team-calendar.test.cjs
  publish-my-time-off.test.cjs
```

`scripts/` holds exactly the files that get uploaded to the Apps Script
project; everything else is local tooling.

## How it works

### Pulling the team's time off (`sync-team-calendar.js`)

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

### Publishing your own time off (`publish-my-time-off.js`)

Each calendar listed in `PUBLISH_CALENDAR_IDS` receives your time off, and the
steps below run once per calendar.

1. The source is always the account running the script — whoever authorised it,
   as reported by `Session.getEffectiveUser()`. There is no ACL lookup and no
   other calendar is ever read, which is why write access to the destination is
   enough.
2. It lists your out-of-office events over the same window
   (`MONTHS_IN_ADVANCE`, or 7 days for the dry run).
3. Qualifying events are copied to each destination under exactly the same
   rules as the team sync: `STRICT_MATCH` decides what counts,
   `SANITIZE_EVENTS` strips private details, whole-day events are rewritten as
   all-day, and copies are shown as Free with no reminders and no attendees.
4. Copies are removed again when the source event is cancelled or stops
   matching, in every destination.

Listing the same calendar in both settings is harmless. Copies are matched by
source event, so the two scripts converge on a single copy rather than creating
two, and they keep separate checkpoints (`lastRun:…` and `lastPublish:…`) so
neither skips work the other has done.

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
- **Locking.** Runs take a script lock, so a trigger firing while another run
  is still going will wait rather than double-import. The lock is shared by
  both scripts, and the wait gives up after 30 seconds.

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

### `sync-team-calendar.js`

| Function | What it does |
| --- | --- |
| `setup` | Creates the triggers (daily `sync` between 08:00 and 09:00, weekly `fullSync` on Monday between 07:00 and 08:00) and performs a first full sync. Safe to re-run: it replaces its own triggers and leaves the publish script's alone. |
| `sync` | Incremental sync: only events modified since each calendar's last run. This is what the daily trigger calls. |
| `fullSync` | Re-scans the whole window, ignoring checkpoints. Catches events created outside the window that have since slid into it without being modified. |
| `testSync` | **Dry run** over the next 7 days: logs what would be imported and removed, writes nothing, and does not move any checkpoint. Run this first after configuring. |
| `inspectEvents` | Diagnostic: dumps the raw start/end of every out-of-office event in the next 30 days, with the verdict of the all-day and strict-match checks. |
| `diagnoseCalendarAccess` | Diagnostic: checks that every calendar in `TEAM_CALENDAR_IDS` is reachable by the account running the script and reports its access role. Use when ACL reads fail with "Not Found". |
| `listCalendarAccess` | Diagnostic: lists every ACL entry of each team calendar grouped by role, so you can see who will be synced and which entries are skipped. |

Both scripts use the same schedule: the incremental run happens daily between
08:00 and 09:00, and the full re-scan weekly on Monday between 07:00 and 08:00.
Apps Script only lets you pick the hour, not the minute, so these are windows
rather than exact times, in the script project's timezone.

### `publish-my-time-off.js`

| Function | What it does |
| --- | --- |
| `setupPublish` | Creates this script's triggers (daily `publishMyTimeOff` between 08:00 and 09:00, weekly `fullPublishMyTimeOff` on Monday between 07:00 and 08:00) and publishes once immediately. Safe to re-run: it replaces its own triggers and leaves the team sync's alone. |
| `publishMyTimeOff` | Incremental publish: only your events modified since each destination's last run. |
| `fullPublishMyTimeOff` | Re-scans the whole window, ignoring checkpoints. |
| `testPublishMyTimeOff` | **Dry run** over the next 7 days: logs what would be copied to each destination and writes nothing. |
| `diagnosePublishAccess` | Diagnostic: checks that every destination is reachable and writable by the account running the script. |

## Configuration

All settings live in `scripts/config.js`, which is **not tracked in git**.
Copy `scripts/config.dist.js` to `scripts/config.js` and edit the values
there.

| Setting | Default | Meaning |
| --- | --- | --- |
| `TEAM_CALENDAR_IDS` | — | List of the shared calendars events are copied to. Find each ID in the calendar's settings under *Integrate calendar* → *Calendar ID*. |
| `PUBLISH_CALENDAR_IDS` | `[]` | List of calendars `publish-my-time-off.js` copies *your own* time off to. Empty disables that script. Only write access is needed, unlike `TEAM_CALENDAR_IDS`. |
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

Steps 1–2 apply to `sync-team-calendar.js`; if you only want to publish your
own time off, skip them and note the IDs of the calendars you want to publish to
instead.

1. **Create the team calendar** (or pick an existing one) in Google Calendar.
   Note its calendar ID from *Settings and sharing* → *Integrate calendar*.
   Repeat for each team calendar you want to feed.
2. **Share it with the team.** Give each person who should be synced *Make
   changes to events* or *Make changes and manage sharing*. The ACL is the
   membership list.
3. **Create the Apps Script project.** Either a standalone script at
   [script.google.com](https://script.google.com), or push this directory with
   [`clasp`](https://github.com/google/clasp).
4. **Configure.** `cp scripts/config.dist.js scripts/config.js`, then set
   `TEAM_CALENDAR_IDS` and/or `PUBLISH_CALENDAR_IDS` — whichever directions you
   want — and review the other settings. Either list can stay empty.
5. **Add the files to the project.** Everything in `scripts/`: `config.js`,
   `common.js`, and whichever of `sync-team-calendar.js` and
   `publish-my-time-off.js` you are using. Tests live in `tests/`, outside that
   directory, precisely because they should not be uploaded.
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
7. **Check access.** The first time you run any function, Apps Script shows
   the OAuth consent screen; review the scopes and accept. Scopes are never
   declared by hand — they are inferred from the code, which is why the
   Calendar service has to be in place before this.

   For the team sync, run `diagnoseCalendarAccess`: reading the ACL requires
   the running account to have the `owner` role on each team calendar, so if
   the report shows a lesser role, fix the sharing before continuing. Then
   `listCalendarAccess` confirms the expected people are listed. For
   publishing, run `diagnosePublishAccess`, which flags any destination that is
   unreachable or not writable.
8. **Dry run.** Run `testSync` and/or `testPublishMyTimeOff` and read the
   execution log. Each reports the window it scanned and, for the next 7 days,
   what it would import and remove. Nothing is written.
9. **Go live.** Run `setup` for the team sync and/or `setupPublish` for
   publishing. Each creates its own daily and weekly triggers and performs a
   first full run; each only ever touches its own triggers, so enabling both is
   fine. To change a schedule later, edit the setup function and run it again —
   it replaces its own triggers, so there is nothing to clean up by hand.

For the team sync, the account running the script must be able to read the team
members' calendars — in a Google Workspace domain this is normally the case for
free/busy plus out-of-office details; if a calendar is not readable, the sync
logs an error for that person and carries on. Publishing reads only your own
calendar, so it has no such requirement.

## Tests

```
node tests/sync-team-calendar.test.cjs
node tests/publish-my-time-off.test.cjs
```

Each suite runs its script, plus `common.js`, in a `vm` context with the Apps
Script services stubbed out (`Calendar`, `PropertiesService`, `LockService`,
`ScriptApp`, `Session`, `Utilities`) by `tests/helpers.cjs`. They load
`scripts/config.dist.js`, not `scripts/config.js`, so a local configuration
cannot change the outcome. No dependencies beyond Node. Both suites run in CI
on every push to `main` and on every pull request.

## Differences from the Google sample

- Team membership comes from each team calendar's ACL, not from a Google Group.
- Any number of team calendars, synced independently from one project.
- A second script that publishes only your own time off to calendars you do not
  administer.
- Per-calendar checkpoints, so one failing calendar does not stall or skip the
  others.
- Imported copies are tagged, and copies are removed again when the source
  event is cancelled or stops matching.
- Full-day out-of-office events are rewritten as real all-day events.
- Optional sanitising of titles, descriptions and locations.
- Dry-run and diagnostic entry points, a script lock, and a unit test suite.

## License

Apache License 2.0, inherited from the Google sample this is based on.
