const rejected=()=>Object.assign(Error('FIELD_CI_TAP_SUMMARY_REJECTED'),{code:'FIELD_CI_TAP_SUMMARY_REJECTED'});
/** Scalar retention only; unexpected bounded counters remain unaccepted diagnostics. */
export function retainFieldCiTapSummaryV1(text,expectedTests){
 if(typeof text!=='string'||Buffer.byteLength(text)>8*1024**2||!Number.isSafeInteger(expectedTests)||expectedTests<1||expectedTests>1024)throw rejected();
 const counters={};
 for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
  const rows=text.split('\n').filter(line=>line.startsWith('# '+key+' '));
  if(rows.length!==1||!new RegExp('^# '+key+' [0-9]{1,7}\\s*$').test(rows[0]))throw rejected();
  const value=Number(rows[0].slice(key.length+3).trim());
  if(!Number.isSafeInteger(value)||value<0||value>1000000)throw rejected();
  counters[key]=value;
 }
 return {format:'FIELD_CI_UNVERIFIED_TAP_COUNTERS_V1',expectedTests,counters,exactExpectedPass:counters.tests===expectedTests&&counters.pass===expectedTests&&['fail','cancelled','skipped','todo'].every(key=>counters[key]===0),boundedScalarRetentionOnly:true,authorizationGranted:false,rawTapRetained:false,fullGoalComplete:false};
}
