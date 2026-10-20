// Independent UTC fixture: the rule is a 24h weekly shift, replaced on the
// stop dates. Its mathematical oracle is exactly three explicit intervals.
export function weeklyCoverageCalendar(f){
 const from=f.now-12000000,to=f.now,stopFrom=f.now-6000000,stopTo=f.now-4980000,iso=t=>new Date(t).toISOString(),clock=m=>m===1440?'24:00':String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),exceptions=[];
 for(let day=Math.floor(stopFrom/86400000)*86400000;day<stopTo;day+=86400000){const a=Math.max(0,(stopFrom-day)/60000),b=Math.min(1440,(stopTo-day)/60000),shifts=[];if(a>0)shifts.push({start:'00:00',end:clock(a),endDayOffset:0,reason:'停产前运行'});if(b<1440)shifts.push({start:clock(b),end:'24:00',endDayOffset:0,reason:'停产后运行'});exceptions.push({date:iso(day).slice(0,10),reason:'独立批准计划停产',shifts});}
 const recurrence={version:1,outsideShifts:'STOP',outsideReason:'明确非班次停产',ambiguousTime:'REJECT',nonexistentTime:'REJECT',weekly:[{id:'daily',isoWeekdays:[1,2,3,4,5,6,7],start:'00:00',end:'24:00',endDayOffset:0,reason:'明确连续生产'}],exceptions};
 const authoring={deviceCode:'QUALITY-A',timeZone:'UTC',from:iso(from),to:iso(to),recurrence};
 const oracle={deviceCode:'QUALITY-A',timeZone:'UTC',from:iso(from),to:iso(to),periods:[{from:iso(from),to:iso(stopFrom),state:'RUN',reason:'独立oracle运行一'},{from:iso(stopFrom),to:iso(stopTo),state:'STOP',reason:'独立oracle停产'},{from:iso(stopTo),to:iso(to),state:'RUN',reason:'独立oracle运行二'}]};return {authoring,oracle};
}
