WITH base AS (__BASE_CATALOG__)
SELECT jsonb_build_object('baseManifest',(SELECT manifest FROM base),
 'schema',(SELECT jsonb_build_array(oid::text,nspowner::text,nspacl::text) FROM pg_namespace WHERE nspname='idms_workflow_reservation_v1'),
 'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid::text,'name',c.relname,'owner',c.relowner::text,'acl',c.relacl::text,'kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attcollation::text,a.attnotnull,a.attisdropped,a.attidentity,a.attgenerated,(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(x.oid::text,x.conname,pg_get_constraintdef(x.oid,true),x.convalidated) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.oid::text,t.tgname,t.tgenabled,t.tgfoid::text,pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
  'rules',(SELECT jsonb_agg(jsonb_build_array(r.oid::text,r.rulename,r.ev_enabled,pg_get_ruledef(r.oid,true)) ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indexrelid::text,i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid) FROM pg_index i WHERE i.indrelid=c.oid),
  'policies',(SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='idms_workflow_reservation_v1' AND c.relkind='r'),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::text,p.proname,p.proowner::text,p.proacl::text,p.prosecdef,p.provolatile,p.proconfig,pg_get_functiondef(p.oid)) ORDER BY p.proname)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='idms_workflow_reservation_v1')
)::text AS manifest
