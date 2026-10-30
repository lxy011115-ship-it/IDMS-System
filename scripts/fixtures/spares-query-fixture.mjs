/** Query-only synthetic public projections. This is not a full business proof or
 * a production migration. Use solely inside an owned disposable QA database. */
export async function installSpareQueryFixture(owner,tenant,appUser){
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 await owner.query(`CREATE TABLE public.business_state(tenant_id text PRIMARY KEY,revision bigint NOT NULL);
 CREATE TABLE public.business_devices(tenant_id text,id text,body jsonb);
 CREATE TABLE public.business_work_orders(tenant_id text,id text,body jsonb);
 CREATE TABLE public.managed_import_rows(tenant_id text,ordinal bigint,batch_id uuid,source_row integer,data_type text,source_system text,source_record_id text,snapshot_digest text,body jsonb);
 CREATE TABLE public.managed_record_revisions(tenant_id text,root_ordinal bigint,revision integer,batch_id uuid,source_row integer,snapshot_digest text,body jsonb,previous_batch_id uuid);
 GRANT SELECT ON public.business_state,public.business_devices,public.business_work_orders,public.managed_import_rows,public.managed_record_revisions TO ${quote(appUser)};`);
 await owner.query('GRANT UPDATE ON public.business_state TO '+quote(appUser));
 await owner.query('INSERT INTO public.business_state VALUES($1,1)',[tenant]);
 await owner.query("INSERT INTO public.managed_import_rows VALUES($1,1,'00000000-0000-0000-0000-000000000001',2,'DEVICE','synthetic','QA-PUMP','synthetic',$2)",[tenant,{device_code:'QA-PUMP',device_name:'合成增长测试泵',site_code:'F1',line_code:'L1'}]);
 await owner.query('INSERT INTO public.business_work_orders VALUES($1,$2,$3)',[tenant,'QA-ORDER',{id:'QA-ORDER',tenantId:tenant,deviceCode:'QA-PUMP',assignee:'clerk',state:'IN_PROGRESS'}]);
}
