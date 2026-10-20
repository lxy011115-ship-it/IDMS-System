import {canonical} from '../server/imports.ts';
const names=['TimeZone','DateStyle','IntervalStyle','extra_float_digits','bytea_output','standard_conforming_strings'];
const fail=()=>{throw Object.assign(Error('FIELD_RESTORE_FACT_SESSION_INVALID'),{code:'FIELD_RESTORE_FACT_SESSION_INVALID'});};
export function fieldFactSession(raw){
 const keys=['format',...names];if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).length!==keys.length||keys.some(k=>!Object.hasOwn(raw,k))||raw.format!=='idms-field-fact-session-v1')fail();
 if(names.some(n=>typeof raw[n]!=='string')||!/^[-+A-Za-z0-9_/:.]{1,128}$/.test(raw.TimeZone)||!/^(ISO|SQL|Postgres|German), (MDY|DMY|YMD)$/.test(raw.DateStyle)||!['postgres','postgres_verbose','sql_standard','iso_8601'].includes(raw.IntervalStyle)||!/^(-1[0-5]|-[1-9]|[0-3])$/.test(raw.extra_float_digits)||!['hex','escape'].includes(raw.bytea_output)||!['on','off'].includes(raw.standard_conforming_strings))fail();
 return Object.freeze(JSON.parse(canonical(raw)));
}
export async function captureFieldFactSession(client){const raw={format:'idms-field-fact-session-v1'};for(const name of names)raw[name]=(await client.query('SELECT current_setting($1) AS value',[name])).rows[0].value;return fieldFactSession(raw);}
export async function applyFieldFactSession(client,raw){const value=fieldFactSession(raw);for(const name of names){const set=(await client.query('SELECT set_config($1,$2,false) AS value',[name,value[name]])).rows[0].value;if(set!==value[name])fail();}return value;}
