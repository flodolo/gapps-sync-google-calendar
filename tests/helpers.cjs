// Shared harness for the test suites: builds a vm context with the Apps Script
// services the scripts use stubbed out, and records what they did.
//
// Suites always load config.dist.js rather than config.js, so a local
// configuration cannot change their outcome.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const util = require('node:util');

function load(files) {
  return ['config.dist.js', 'common.js', ...files]
    .map((file) => fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8'))
    .join('\n');
}

/**
 * @param {string[]} files Script files to load on top of the config and common.
 * @param {string[]} configKeys Config constants to expose to the test. They are
 *     lexical declarations, so they are not properties of the context object
 *     and have to be read from inside it.
 */
function context(files, configKeys = ['TEAM_CALENDAR_IDS']) {
  const state = {writes:0, removed:[], imports:[], released:0, properties:{}, logs:[], triggers:[]};
  const c = {
    console:{log(...args){state.logs.push(util.format(...args));}, error(){}, warn(){}},
    LockService:{getScriptLock:()=>({waitLock(){}, releaseLock(){state.released++;}})},
    PropertiesService:{getScriptProperties:()=>({getProperties:()=>({...state.properties}),deleteProperty(key){delete state.properties[key];},getProperty:(key)=>state.properties[key] || null,setProperty(key,value){state.writes++;state.properties[key]=value;}})},
    Session:{getEffectiveUser:()=>({getEmail:()=>'me@example.com'})},
    ScriptApp:{
      getProjectTriggers:()=>state.triggers.map((h)=>({getHandlerFunction:()=>h})),
      newTrigger(handler){
        const builder={timeBased:()=>builder,everyHours:()=>builder,everyDays:()=>builder,atHour:()=>builder,create(){state.triggers.push(handler);}};
        return builder;
      },
    },
    Utilities:{formatDate(date, timeZone, pattern) {
      if (pattern.includes("yyyy-MM-dd'T'")) return date.toISOString();
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
      return pattern==='yyyy-MM-dd' ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.hour}:${parts.minute}:${parts.second}`;
    }},
    Calendar:{
      Events:{list:()=>({items:[]}),get(){throw Error('Not Found');},remove(cal,id){state.removed.push(id);},import(event,cal){state.imports.push(event);}},
      CalendarList:{get:()=>({summary:'Shared',accessRole:'writer'}),list:()=>({items:[]})},
      Acl:{list:()=>({items:[]})},
    },
  };
  vm.createContext(c);
  vm.runInContext(load(files), c);
  c.getCalendarEditors=()=>['alice@example.com'];
  const config = vm.runInContext(`({${configKeys.join(',')}})`, c);
  return {c, state, config, run:(code)=>vm.runInContext(code, c)};
}

/** A timed event, the shape returned by the Calendar API for OOO events. */
function timed(start,end,zone) {
  return {id:'source',summary:'Appointment',start:{dateTime:start,timeZone:zone},end:{dateTime:end,timeZone:zone}};
}

/** Minimal runner: throws on the first failure, so CI fails loudly. */
function runner() {
  let passed = 0;
  return {
    test(name, fn) { fn(); passed++; console.log('PASS', name); },
    done() { console.log(`${passed} tests passed`); },
  };
}

module.exports = {context, timed, runner};
