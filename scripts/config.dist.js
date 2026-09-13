// Configuration for the away-calendar sync.
//
// Copy this file to config.js and adjust the values. config.js is excluded
// from git, so local settings never end up in the repository.
//
// In Apps Script every file shares one global scope, so these constants are
// visible to sync-team-calendar.js without any import.

// IDs of the team calendars events are copied to. Find each one in the
// calendar's settings page, under "Integrate calendar" > "Calendar ID".
//
// Each calendar is synced independently: its own ACL decides whose personal
// calendar is scanned for it, and it keeps its own per-user checkpoints. A
// person who is an editor on two of these calendars has their time off copied
// to both. One unreachable calendar is reported but does not stop the others.
const TEAM_CALENDAR_IDS = [
  "your-calendar-id@group.calendar.google.com",
];

// Calendar ACL roles that identify a team member: their personal calendar is
// scanned for out-of-office events. 'writer' is "Make changes to events",
// 'owner' is "Make changes and manage sharing".
const MEMBER_ROLES = ["writer", "owner"];

// Title fragments (lowercase) that mark a timed event as time off. Only used
// when STRICT_MATCH is true.
const KEYWORDS = ["vacation", "ooo", "pto", "wellness", "holiday", "on leave"];

// How far ahead to look for events, in months.
const MONTHS_IN_ADVANCE = 3;

// When true, timed out-of-office events are imported only if their title
// contains one of KEYWORDS; all-day events are always imported. When false,
// every out-of-office event in the window is imported.
const STRICT_MATCH = true;

// When true, the original event title, description and location are discarded
// and the imported event is titled '[username] Away'. Keeps private details
// from personal calendars off the shared team calendar.
const SANITIZE_EVENTS = true;

// Title used for imported events when SANITIZE_EVENTS is true.
const SANITIZED_TITLE = "Away";
