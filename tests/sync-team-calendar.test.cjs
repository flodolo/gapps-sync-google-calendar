const assert = require('node:assert/strict');
const {context: makeContext, timed, runner} = require('./helpers.cjs');

const {test, done} = runner();
const context = () => makeContext(['sync-team-calendar.js']);
test('partial final day remains timed and fails strict matching',()=>{
 const {c}=context(),e=timed('2026-09-12T00:00:00Z','2026-09-13T12:00:00Z');
 assert.equal(c.isAllDayEvent(e),false);assert.equal(c.isStrictMatch(e),false);
});
test('explicit offset works without script timezone',()=>{
 const {c}=context(),e=timed('2026-09-12T00:00:00+02:00','2026-09-13T00:00:00+02:00');
 assert.equal(c.isAllDayEvent(e),true);c.convertToAllDay(e);assert.equal(e.start.date,'2026-09-12');assert.equal(e.end.date,'2026-09-13');
});
test('DST short and long days and 23:59 ending',()=>{
 const {c}=context();
 for (const [start,end,expected] of [
 ['2026-03-29T00:00:00+01:00','2026-03-30T00:00:00+02:00','2026-03-30'],
 ['2026-03-29T00:00:00+01:00','2026-03-29T23:59:00+02:00','2026-03-30'],
 ['2026-10-25T00:00:00+02:00','2026-10-26T00:00:00+01:00','2026-10-26']]) {
 const e=timed(start,end,'Europe/Berlin');assert.equal(c.isAllDayEvent(e),true);c.convertToAllDay(e);assert.equal(e.end.date,expected);
 }
});
test('ID-only cancellation removes tagged copy before filtering',()=>{
 const {c,state}=context();c.findEvents=()=>[{id:'source',status:'cancelled'}];
 c.Calendar.Events.list=()=>({items:[{id:'copy',summary:'[alice] Away',extendedProperties:{private:{awaySource:'alice@example.com/source'}}}]});
 c.runSync();assert.deepEqual(state.removed,['copy']);assert.equal(state.writes,1);
});
test('renamed event removes legacy copy by UID',()=>{
 const {c,state}=context();const e=timed('2026-09-12T09:00:00Z','2026-09-12T12:00:00Z');e.iCalUID='uid';c.findEvents=()=>[e];
 c.Calendar.Events.list=(cal,params)=>({items:[{id:'legacy',iCalUID:'uid',summary:'[alice] PTO'}]});
 c.runSync();assert.deepEqual(state.removed,['legacy']);
});
test('dry run does not delete, import, or advance timestamp',()=>{
 const {c,state}=context();c.findEvents=()=>[{id:'source',status:'cancelled'}];c.Calendar.Events.list=()=>({items:[{id:'copy',extendedProperties:{private:{awaySource:'alice@example.com/source'}}}]});
 c.runSync({dryRun:true});assert.equal(state.writes,0);assert.equal(state.removed.length,0);assert.equal(state.imports.length,0);
});
test('fetch, import, and delete failures preserve timestamp and release lock',()=>{
 for (const kind of ['fetch','import','delete']) {
 const {c,state}=context();
 if(kind==='fetch') c.Calendar.Events.list=()=>{throw Error('503');};
 else if(kind==='import') {c.findEvents=()=>[{id:'source',summary:'PTO',start:{date:'2026-09-12'},end:{date:'2026-09-13'}}];c.Calendar.Events.import=()=>{throw Error('503');};}
 else {c.findEvents=()=>[{id:'source',status:'cancelled'}];c.Calendar.Events.list=()=>({items:[{id:'copy',extendedProperties:{private:{awaySource:'alice@example.com/source'}}}]});c.Calendar.Events.remove=()=>{throw Error('503');};}
 assert.throws(()=>c.runSync(),/1 calendar\(s\) failed/);assert.equal(state.writes,0);assert.equal(state.released,1);
 }
});
test('empty pages do not produce undefined events',()=>{const {c}=context();assert.equal(c.findEvents('alice',new Date(),new Date(),null).length,0);});
test('import tags copy and does not mutate original',()=>{
 const {c,state,config}=context(),e={id:'source',summary:'PTO',eventType:'outOfOffice',start:{date:'2026-09-12'},end:{date:'2026-09-13'}};
 c.importEvent(config.TEAM_CALENDAR_IDS[0],'alice',e,'alice@example.com');assert.equal(e.summary,'PTO');assert.equal(state.imports[0].summary,'[alice] Away');assert.equal(state.imports[0].transparency,'transparent');assert.equal(state.imports[0].extendedProperties.private.awaySource,'alice@example.com/source');
});
test('imported copies carry no reminders, whatever the source had',()=>{
 const {c,state,config}=context();
 for (const reminders of [undefined,{useDefault:true},{useDefault:false,overrides:[{method:'popup',minutes:30}]}]) {
  const e={id:'source',summary:'PTO',start:{date:'2026-09-12'},end:{date:'2026-09-13'}};
  if(reminders)e.reminders=reminders;
  c.importEvent(config.TEAM_CALENDAR_IDS[0],'alice',e,'alice@example.com');
 }
 for (const copy of state.imports) {
  assert.equal(copy.reminders.useDefault,false);
  assert.equal(copy.reminders.overrides.length,0);
 }
 assert.equal(state.imports.length,3);
});
test('inaccessible calendar does not block later users, and recovery retries',()=>{
 const {c,state,config}=context();const calls=[];let broken=true;
 const aliceKey=`lastRun:${config.TEAM_CALENDAR_IDS[0]}:alice@example.com`;
 const bobKey=`lastRun:${config.TEAM_CALENDAR_IDS[0]}:bob@example.com`;
 state.properties[aliceKey]='2026-09-01T00:00:00.000Z';
 c.getCalendarEditors=()=>['alice@example.com','bob@example.com'];
 c.Calendar.Events.list=(email,params)=>{
  calls.push({email,since:params.updatedMin});
  if(email==='alice@example.com' && broken) throw Error('Not Found');
  return {items:[]};
 };
 assert.throws(()=>c.runSync(),/1 calendar\(s\) failed/);assert.equal(state.properties[aliceKey],'2026-09-01T00:00:00.000Z');assert.ok(state.properties[bobKey]);
 const bobLast=state.properties[bobKey];broken=false;c.runSync();
 assert.equal(calls[2].since,'2026-09-01T00:00:00.000Z');assert.equal(calls[3].since,bobLast);
 assert.notEqual(state.properties[aliceKey],'2026-09-01T00:00:00.000Z');
});
test('second-page failure leaves calendar checkpoint unchanged',()=>{
 const {c,state}=context();let calls=0;
 c.Calendar.Events.list=()=>{if(++calls===2)throw Error('503');return {items:[],nextPageToken:'next'};};
 assert.throws(()=>c.runSync(),/1 calendar\(s\) failed/);assert.equal(calls,2);assert.equal(state.writes,0);
});
test('full sync ignores stored checkpoints',()=>{
 const {c,state}=context();let since='unset';
 c.Calendar.Events.list=(email,params)=>{since=params.updatedMin;return {items:[]};};
 c.fullSync();assert.equal(since,undefined);assert.equal(state.writes,1);
});
test('native RFC3339 formatting preserves UTC',()=>{
 const {c}=context();assert.equal(c.formatDateAsRFC3339(new Date('2026-09-12T00:00:00+02:00')),'2026-09-11T22:00:00.000Z');
});
test('many exclusions across users share one paginated lookup and log reasons',()=>{
 const {c,state}=context();let lists=0;
 c.getCalendarEditors=()=>['alice@example.com','bob@example.com'];
 c.findEvents=()=>Array.from({length:100},(_,i)=>({...timed('2026-09-12T09:00:00Z','2026-09-12T11:00:00Z'),id:`source${i}`}));
 c.Calendar.Events.get=()=>assert.fail('No per-event get expected');
 c.Calendar.Events.list=(calendar,params)=>{
  lists++;assert.equal(params.timeMin,undefined);assert.equal(params.timeMax,undefined);
  return params.pageToken ? {items:[{id:'copy',summary:'[alice] Away',extendedProperties:{private:{awaySource:'alice@example.com/source0'}}}]} : {items:[],nextPageToken:'next'};
 };
 c.runSync();assert.equal(lists,2);assert.deepEqual(state.removed,['copy']);
 assert.equal(state.logs.filter(line=>line.startsWith('Excluded or cancelled:')).length,200);
 assert.ok(state.logs.some(line=>line.startsWith('Removed:')));
});
test('runs without exclusions never load destination calendar',()=>{
 const {c}=context();c.findEvents=()=>[];c.Calendar.Events.list=()=>assert.fail('Unexpected destination lookup');c.runSync();
});
test('cleanup removes only legacy and departed-user state for this team',()=>{
 const {c,state,config}=context();const prefix=`lastRun:${config.TEAM_CALENDAR_IDS[0]}:`;
 Object.assign(state.properties,{lastRun:'old',[prefix+'departed@example.com']:'old',[prefix+'alice@example.com']:'2026-09-01T00:00:00Z','lastRun:other-team:user':'keep',setting:'keep'});
 c.runSync();assert.equal(state.properties.lastRun,undefined);assert.equal(state.properties[prefix+'departed@example.com'],undefined);
 assert.ok(state.properties[prefix+'alice@example.com']);assert.equal(state.properties['lastRun:other-team:user'],'keep');assert.equal(state.properties.setting,'keep');
});
test('dry run and failed ACL read leave obsolete properties untouched',()=>{
 for(const failACL of [false,true]) {
 const {c,state}=context();state.properties.lastRun='old';
 if(failACL){c.getCalendarEditors=()=>{throw Error('ACL unavailable');};assert.throws(()=>c.runSync(),/ACL unavailable/);}
 else c.runSync({dryRun:true});
 assert.equal(state.properties.lastRun,'old');assert.equal(state.writes,0);
 }
});
test('tagged copies for another source are not removed by legacy fallback',()=>{
 const {c,state}=context();c.findEvents=()=>[{id:'source',status:'cancelled'}];
 c.Calendar.Events.list=()=>({items:[{id:'source',summary:'[alice] Away',extendedProperties:{private:{awaySource:'other@example.com/source'}}}]});
 c.runSync();assert.equal(state.removed.length,0);
});
test('each team calendar syncs independently with its own members and checkpoints',()=>{
 const {c,state,config,run}=context();
 run('TEAM_CALENDAR_IDS.push("second@group.calendar.google.com")');
 const [first,second]=config.TEAM_CALENDAR_IDS;
 c.getCalendarEditors=(calendarId)=>calendarId===first?['alice@example.com']:['bob@example.com'];
 c.findEvents=(email)=>[{id:`src-${email}`,summary:'PTO',start:{date:'2026-09-12'},end:{date:'2026-09-13'}}];
 c.runSync();
 assert.deepEqual(state.imports.map(e=>e.organizer.id),[first,second]);
 assert.deepEqual(state.imports.map(e=>e.summary),['[alice] Away','[bob] Away']);
 assert.ok(state.properties[`lastRun:${first}:alice@example.com`]);
 assert.ok(state.properties[`lastRun:${second}:bob@example.com`]);
 assert.equal(state.properties[`lastRun:${first}:bob@example.com`],undefined);
});
test('one unreachable team calendar does not stop the others',()=>{
 const {c,state,config,run}=context();
 run('TEAM_CALENDAR_IDS.push("second@group.calendar.google.com")');
 const [first,second]=config.TEAM_CALENDAR_IDS;
 c.getCalendarEditors=(calendarId)=>{if(calendarId===first)throw Error('ACL unavailable');return ['bob@example.com'];};
 c.findEvents=()=>[];
 assert.throws(()=>c.runSync(),/ACL unavailable/);
 assert.ok(state.properties[`lastRun:${second}:bob@example.com`]);
 assert.equal(state.released,1);
});
test('a failing member on one calendar leaves the other calendar advancing',()=>{
 const {c,state,config,run}=context();
 run('TEAM_CALENDAR_IDS.push("second@group.calendar.google.com")');
 const [first,second]=config.TEAM_CALENDAR_IDS;
 c.getCalendarEditors=()=>['alice@example.com'];
 let calls=0;
 c.findEvents=()=>{if(++calls===1)throw Error('503');return [];};
 assert.throws(()=>c.runSync(),/1 calendar\(s\) failed/);
 assert.equal(state.properties[`lastRun:${first}:alice@example.com`],undefined);
 assert.ok(state.properties[`lastRun:${second}:alice@example.com`]);
});
test('setup registers its own triggers and tolerates the publish ones',()=>{
 const {c,state}=context();
 c.findEvents=()=>[];
 state.triggers.push('publishMyTimeOff');   // publish-my-time-off.js is scheduled
 c.setup();
 assert.deepEqual(state.triggers,['publishMyTimeOff','sync','fullSync']);
 assert.throws(()=>c.setup(),/already setup/);
});
done();
