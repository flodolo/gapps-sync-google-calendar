const assert = require('node:assert/strict');
const {context: makeContext, timed, runner} = require('./helpers.cjs');

const {test, done} = runner();
// PUBLISH_CALENDAR_IDS is empty in the reference config, so each test pushes
// the destinations it needs. The array is a lexical const, so it is mutated
// from inside the context rather than reassigned.
const context = () => makeContext(['publish-my-time-off.js'], ['PUBLISH_CALENDAR_IDS','TEAM_CALENDAR_IDS']);
const withDestinations = (...ids) => {
  const ctx = context();
  ctx.run(`PUBLISH_CALENDAR_IDS.push(${ids.map((id)=>JSON.stringify(id)).join(',')})`);
  return ctx;
};
const allDay = (id='mine') => ({id,summary:'PTO',start:{date:'2026-09-12'},end:{date:'2026-09-13'}});

test('empty destination list writes nothing and does not fail',()=>{
 const {c,state}=context();
 c.findEvents=()=>assert.fail('No source lookup expected');
 c.runPublish();
 assert.equal(state.imports.length,0);assert.equal(state.writes,0);assert.equal(state.released,1);
 assert.ok(state.logs.some((line)=>line.includes('nothing to publish')));
});

test('copies my own events to every destination',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com','b@group.calendar.google.com');
 const seen=[];
 c.findEvents=(email)=>{seen.push(email);return [allDay()];};
 c.runPublish();
 // The source is always the account running the script, never an ACL member.
 assert.deepEqual(seen,['me@example.com','me@example.com']);
 assert.deepEqual(state.imports.map((e)=>e.organizer.id),
  ['a@group.calendar.google.com','b@group.calendar.google.com']);
});

test('copies are sanitized, free, reminder-free and unattended',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[{...allDay(),summary:'Dentist, Milan',description:'private',location:'Via Roma'}];
 c.runPublish();
 const copy=state.imports[0];
 assert.equal(copy.summary,'[me] Away');
 assert.equal(copy.description,undefined);assert.equal(copy.location,undefined);
 assert.equal(copy.transparency,'transparent');
 assert.equal(copy.reminders.useDefault,false);
 assert.equal(copy.reminders.overrides.length,0);
 assert.equal(copy.attendees.length,0);
 assert.equal(copy.extendedProperties.private.awaySource,'me@example.com/mine');
});

test('strict matching applies, and all-day events are rewritten as such',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[
  timed('2026-09-14T09:00:00Z','2026-09-14T10:00:00Z'),           // no keyword
  {...timed('2026-09-15T00:00:00Z','2026-09-16T00:00:00Z'),id:'whole',summary:'Appointment'},
 ];
 c.runPublish();
 assert.equal(state.imports.length,1);
 assert.equal(state.imports[0].start.date,'2026-09-15');
 assert.equal(state.imports[0].end.date,'2026-09-16');
});

test('cancelled source removes the copy from each destination',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com','b@group.calendar.google.com');
 c.findEvents=()=>[{id:'mine',status:'cancelled'}];
 c.Calendar.Events.list=(cal)=>({items:[{id:`copy-${cal}`,summary:'[me] Away',
  extendedProperties:{private:{awaySource:'me@example.com/mine'}}}]});
 c.runPublish();
 assert.deepEqual(state.removed,['copy-a@group.calendar.google.com','copy-b@group.calendar.google.com']);
});

test('checkpoints are per destination and distinct from the team sync keys',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com','b@group.calendar.google.com');
 c.findEvents=()=>[];
 c.runPublish();
 assert.ok(state.properties['lastPublish:a@group.calendar.google.com:me@example.com']);
 assert.ok(state.properties['lastPublish:b@group.calendar.google.com:me@example.com']);
 // A shared key would let the two scripts skip each other's work.
 assert.equal(state.properties['lastRun:a@group.calendar.google.com:me@example.com'],undefined);
});

test('incremental runs pass each destination its own checkpoint',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com','b@group.calendar.google.com');
 state.properties['lastPublish:a@group.calendar.google.com:me@example.com']='2026-09-01T00:00:00.000Z';
 const since=[];
 c.Calendar.Events.list=(cal,params)=>{since.push(params.updatedMin);return {items:[]};};
 c.runPublish();
 assert.deepEqual(since,['2026-09-01T00:00:00.000Z',undefined]);
});

test('full publish ignores checkpoints',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 state.properties['lastPublish:a@group.calendar.google.com:me@example.com']='2026-09-01T00:00:00.000Z';
 let since='unset';
 c.Calendar.Events.list=(cal,params)=>{since=params.updatedMin;return {items:[]};};
 c.fullPublishMyTimeOff();
 assert.equal(since,undefined);
});

test('dry run writes nothing and leaves checkpoints alone',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[allDay()];
 c.testPublishMyTimeOff();
 assert.equal(state.imports.length,0);assert.equal(state.writes,0);
 assert.ok(state.logs.some((line)=>line.includes('(dry run)')));
 assert.ok(state.logs.some((line)=>line.startsWith('Would import as Free')));
});

test('one failing destination does not stop the others, and it retries',()=>{
 const {c,state}=withDestinations('bad@group.calendar.google.com','b@group.calendar.google.com');
 let broken=true;
 c.findEvents=(email,start,end,since)=>[allDay()];
 c.Calendar.Events.import=(event,cal)=>{
  if(cal==='bad@group.calendar.google.com' && broken) throw Error('403');
  state.imports.push(event);
 };
 assert.throws(()=>c.runPublish(),/1 destination calendar\(s\) failed/);
 assert.equal(state.imports.length,1);
 assert.equal(state.properties['lastPublish:bad@group.calendar.google.com:me@example.com'],undefined);
 assert.ok(state.properties['lastPublish:b@group.calendar.google.com:me@example.com']);
 assert.equal(state.released,1);
 broken=false;c.runPublish();
 assert.ok(state.properties['lastPublish:bad@group.calendar.google.com:me@example.com']);
});

test('a destination is paginated at most once per run',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 let lists=0;
 c.findEvents=()=>[{id:'one',status:'cancelled'},{id:'two',status:'cancelled'}];
 c.Calendar.Events.list=()=>{lists++;return {items:[]};};
 c.runPublish();
 assert.equal(lists,1);
});

test('setupPublish registers its own triggers and coexists with the team sync',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[];
 state.triggers.push('sync','fullSync');   // the team sync is already scheduled
 c.setupPublish();
 assert.deepEqual(state.triggers,['sync','fullSync','publishMyTimeOff','fullPublishMyTimeOff']);
 assert.deepEqual(state.deletedTriggers,[]);
});
test('re-running setupPublish replaces its own triggers and keeps the team ones',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[];
 state.triggers.push('sync','fullSync');
 c.setupPublish();
 c.setupPublish();
 assert.deepEqual(state.deletedTriggers,['publishMyTimeOff','fullPublishMyTimeOff']);
 assert.deepEqual(state.triggers,['sync','fullSync','publishMyTimeOff','fullPublishMyTimeOff']);
});
test('setupPublish schedules a daily publish at 08:00 and a full one on Monday at 07:00',()=>{
 const {c,state}=withDestinations('a@group.calendar.google.com');
 c.findEvents=()=>[];
 c.setupPublish();
 assert.deepEqual(state.triggerSpecs,[
  {handler:'publishMyTimeOff',schedule:['everyDays:1','atHour:8']},
  {handler:'fullPublishMyTimeOff',schedule:['onWeekDay:MONDAY','atHour:7']},
 ]);
});

done();
