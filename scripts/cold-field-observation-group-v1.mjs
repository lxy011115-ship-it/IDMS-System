/** Internal scheduling only: preserves every observation, rejects on any failure, drains all started work. */
export async function allColdFieldObservationsV1(operations){
 if(!Array.isArray(operations)||operations.length<1||operations.length>3||operations.some(value=>typeof value!=='function'))throw Object.assign(Error('COLD_FIELD_OBSERVATION_GROUP'),{code:'COLD_FIELD_OBSERVATION_GROUP'});
 const results=await Promise.allSettled(operations.map(operation=>Promise.resolve().then(operation)));
 const rejected=results.find(value=>value.status==='rejected');if(rejected)throw rejected.reason;
 return results.map(value=>value.value);
}
