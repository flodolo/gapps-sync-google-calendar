const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'google-calendar.js'), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
function context() {
  const state = {writes:0, removed:[], imports:[], released:0, properties:{}};
  const c = {
    console:{log(){}, error(){}},
    LockService:{getScriptLock:()=>({waitLock(){}, releaseLock(){state.released++;}})},
    PropertiesService:{getScriptProperties:()=>({getProperty:(key)=>state.properties[key] || null,setProperty(key,value){state.writes++;state.properties[key]=value;}})},
    Utilities:{formatDate(date, timeZone, pattern) {
      if (pattern.includes("yyyy-MM-dd'T'")) return date.toISOString();
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
      return pattern==='yyyy-MM-dd' ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.hour}:${parts.minute}:${parts.second}`;
    }},
    Calendar:{Events:{list:()=>({items:[]}),get(){throw Error('Not Found');},remove(cal,id){state.removed.push(id);},import(event){state.imports.push(event);}}},
  };
  vm.createContext(c); vm.runInContext(source,c);
  c.getCalendarEditors=()=>['alice@example.com'];
  return {c,state};
}
function timed(start,end,zone) {return {id:'source',summary:'Appointment',start:{dateTime:start,timeZone:zone},end:{dateTime:end,timeZone:zone}};}
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
 c.Calendar.Events.list=()=>({items:[{id:'copy',summary:'[alice] Away'}]});
 c.runSync();assert.deepEqual(state.removed,['copy']);assert.equal(state.writes,1);
});
test('renamed event removes legacy copy by UID',()=>{
 const {c,state}=context();const e=timed('2026-09-12T09:00:00Z','2026-09-12T12:00:00Z');e.iCalUID='uid';c.findEvents=()=>[e];
 c.Calendar.Events.list=(cal,params)=>({items:params.iCalUID?[{id:'legacy',summary:'[alice] PTO'}]:[]});
 c.runSync();assert.deepEqual(state.removed,['legacy']);
});
test('dry run does not delete, import, or advance timestamp',()=>{
 const {c,state}=context();c.findEvents=()=>[{id:'source',status:'cancelled'}];c.Calendar.Events.list=()=>({items:[{id:'copy'}]});
 c.runSync({dryRun:true});assert.equal(state.writes,0);assert.equal(state.removed.length,0);assert.equal(state.imports.length,0);
});
test('fetch, import, and delete failures preserve timestamp and release lock',()=>{
 for (const kind of ['fetch','import','delete']) {
 const {c,state}=context();
 if(kind==='fetch') c.Calendar.Events.list=()=>{throw Error('503');};
 else if(kind==='import') {c.findEvents=()=>[{id:'source',summary:'PTO',start:{date:'2026-09-12'},end:{date:'2026-09-13'}}];c.Calendar.Events.import=()=>{throw Error('503');};}
 else {c.findEvents=()=>[{id:'source',status:'cancelled'}];c.Calendar.Events.list=()=>({items:[{id:'copy'}]});c.Calendar.Events.remove=()=>{throw Error('503');};}
 c.runSync();assert.equal(state.writes,0);assert.equal(state.released,1);
 }
});
test('empty pages do not produce undefined events',()=>{const {c}=context();assert.equal(c.findEvents('alice',new Date(),new Date(),null).length,0);});
test('import tags copy and does not mutate original',()=>{
 const {c,state}=context(),e={id:'source',summary:'PTO',eventType:'outOfOffice',start:{date:'2026-09-12'},end:{date:'2026-09-13'}};
 c.importEvent('alice',e,'alice@example.com');assert.equal(e.summary,'PTO');assert.equal(state.imports[0].summary,'[alice] Away');assert.equal(state.imports[0].transparency,'transparent');assert.equal(state.imports[0].extendedProperties.private.awaySource,'alice@example.com/source');
});
test('inaccessible calendar does not block later users, and recovery retries',()=>{
 const {c,state}=context();const calls=[];let broken=true;
 const aliceKey='lastRun:your-calendar-id@group.calendar.google.com:alice@example.com';
 const bobKey='lastRun:your-calendar-id@group.calendar.google.com:bob@example.com';
 state.properties[aliceKey]='2026-09-01T00:00:00.000Z';
 c.getCalendarEditors=()=>['alice@example.com','bob@example.com'];
 c.Calendar.Events.list=(email,params)=>{
  calls.push({email,since:params.updatedMin});
  if(email==='alice@example.com' && broken) throw Error('Not Found');
  return {items:[]};
 };
 c.runSync();assert.equal(state.properties[aliceKey],'2026-09-01T00:00:00.000Z');assert.ok(state.properties[bobKey]);
 const bobLast=state.properties[bobKey];broken=false;c.runSync();
 assert.equal(calls[2].since,'2026-09-01T00:00:00.000Z');assert.equal(calls[3].since,bobLast);
 assert.notEqual(state.properties[aliceKey],'2026-09-01T00:00:00.000Z');
});
test('second-page failure leaves calendar checkpoint unchanged',()=>{
 const {c,state}=context();let calls=0;
 c.Calendar.Events.list=()=>{if(++calls===2)throw Error('503');return {items:[],nextPageToken:'next'};};
 c.runSync();assert.equal(calls,2);assert.equal(state.writes,0);
});
test('full sync ignores stored checkpoints',()=>{
 const {c,state}=context();let since='unset';
 c.Calendar.Events.list=(email,params)=>{since=params.updatedMin;return {items:[]};};
 c.fullSync();assert.equal(since,undefined);assert.equal(state.writes,1);
});
test('native RFC3339 formatting preserves UTC',()=>{
 const {c}=context();assert.equal(c.formatDateAsRFC3339(new Date('2026-09-12T00:00:00+02:00')),'2026-09-11T22:00:00.000Z');
});
console.log(`${passed} tests passed`);
