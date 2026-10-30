import {randomBytes} from 'node:crypto';

/** Explicit initialization only. An existing account's role or range is never repaired. */
export async function ensureSeedAccount({api,save,accounts,username,role,name,tenant,makePassword=()=> 'Idms9-'+randomBytes(20).toString('base64url')}){
 const query=()=>api(`idms/users?username=${encodeURIComponent(username)}&exact=true`),users=await query();
 if(users.length){const owned=accounts.find(a=>a.username===username&&a.tenant===tenant&&a.role===role),user=users[0];if(owned&&(user.attributes?.tenant_id?.[0]!==tenant||owned.userId&&owned.userId!==user.id))throw Error('Seeded account identity or tenant changed; existing authorization was preserved');
  if(owned?.initialization==='PENDING'){const mappings=await api(`idms/users/${user.id}/role-mappings/realm`);if(!mappings.some(r=>r.name===role))throw Error('Interrupted account initialization requires administrator review; no role or range was restored');owned.initialization='COMPLETE';await save();}
  return {created:false,authorizationChanged:false};
 }
 const temporaryPassword=makePassword();await api('idms/users','POST',{username,enabled:true,firstName:name,lastName:'IDMS',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:['*'],idms_lines:['*'],idms_devices:['*']},credentials:[{type:'password',value:temporaryPassword,temporary:true}],requiredActions:['UPDATE_PASSWORD']});
 const created=(await query())[0];if(!created?.id||created.attributes?.tenant_id?.[0]!==tenant)throw Error('New account creation is unconfirmed; no account authorization was attempted');
 const record={username,role,tenant,temporaryPassword,userId:created.id,initialization:'PENDING'};accounts.push(record);await save();const realmRole=await api('idms/roles/'+role);await api(`idms/users/${created.id}/role-mappings/realm`,'POST',[realmRole]);record.initialization='COMPLETE';await save();return {created:true,authorizationChanged:true};
}
