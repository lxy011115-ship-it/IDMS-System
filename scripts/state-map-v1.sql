-- Installed ONLY by state-map-schema-v1.mjs in a new owned QA database.
-- Identifier/literal substitutions are validated/quoted by that installer.
CREATE SCHEMA state_map_v1 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
SET search_path = pg_catalog, state_map_v1, pg_temp;
CREATE SEQUENCE state_map_v1._ddl_epoch;
CREATE TABLE state_map_v1._meta(singleton boolean PRIMARY KEY CHECK(singleton), tenant text NOT NULL,
 format text NOT NULL, owner_oid oid NOT NULL, app_oid oid NOT NULL, reader_oid oid NOT NULL, epoch bigint NOT NULL);
CREATE TABLE state_map_v1._ctx(pid integer PRIMARY KEY, tx bigint NOT NULL);
CREATE TABLE state_map_v1._empty(depth smallint PRIMARY KEY CHECK(depth BETWEEN 0 AND 256), h bytea NOT NULL CHECK(octet_length(h)=32));
CREATE TABLE state_map_v1.kv_values(value_hash bytea PRIMARY KEY CHECK(octet_length(value_hash)=32), value_text text NOT NULL CHECK(octet_length(value_text)<=1048576));
CREATE TABLE state_map_v1.nodes(id bytea PRIMARY KEY CHECK(octet_length(id)=32), kind smallint NOT NULL CHECK(kind IN(0,1)),
 depth smallint NOT NULL CHECK(depth BETWEEN 0 AND 256), prefix bytea NOT NULL CHECK(octet_length(prefix)=32),
 item_count bigint NOT NULL CHECK(item_count>0), state_hash bytea NOT NULL CHECK(octet_length(state_hash)=32),
 left_id bytea REFERENCES state_map_v1.nodes(id), right_id bytea REFERENCES state_map_v1.nodes(id), value_hash bytea REFERENCES state_map_v1.kv_values(value_hash));
CREATE TABLE state_map_v1.head(singleton boolean PRIMARY KEY CHECK(singleton), revision bigint NOT NULL CHECK(revision>=0), root_id bytea REFERENCES state_map_v1.nodes(id),
 root_hash bytea NOT NULL CHECK(octet_length(root_hash)=32), item_count bigint NOT NULL CHECK(item_count>=0), receipt_hash bytea NOT NULL CHECK(octet_length(receipt_hash)=32));
CREATE TABLE state_map_v1.receipts(command_id uuid PRIMARY KEY, request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 before_revision bigint NOT NULL, before_root bytea NOT NULL, before_receipt_hash bytea NOT NULL,
 revision bigint UNIQUE NOT NULL, root_id bytea REFERENCES state_map_v1.nodes(id), root_hash bytea NOT NULL,
 item_count bigint NOT NULL, receipt_hash bytea NOT NULL CHECK(octet_length(receipt_hash)=32));

CREATE FUNCTION state_map_v1._frame(v text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT int4send(octet_length(convert_to(v,'UTF8'))) || convert_to(v,'UTF8')
$$;
CREATE FUNCTION state_map_v1._bit(k bytea,d integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT (get_byte(k,d/8) >> (7-d%8)) & 1
$$;
CREATE FUNCTION state_map_v1._prefix(k bytea,d integer) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE b bytea:=k; i integer; n integer;
BEGIN
 IF octet_length(k)<>32 OR d<0 OR d>256 THEN RAISE EXCEPTION 'STATE_MAP_INVALID'; END IF;
 FOR i IN 0..31 LOOP n:=d-i*8; IF n<=0 THEN b:=set_byte(b,i,0); ELSIF n<8 THEN b:=set_byte(b,i,get_byte(b,i)&(255<<(8-n))); END IF; END LOOP;
 RETURN b;
END $$;
CREATE FUNCTION state_map_v1._lcp(a bytea,b bytea) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN FOR i IN 0..255 LOOP IF state_map_v1._bit(a,i)<>state_map_v1._bit(b,i) THEN RETURN i; END IF; END LOOP; RETURN 256; END $$;
CREATE FUNCTION state_map_v1._merge(l bytea,lc bigint,r bytea,rc bigint) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT sha256(decode('01','hex') || int8send(lc) || l || int8send(rc) || r)
$$;
DO $$ DECLARE h bytea:=sha256(decode('02','hex')); BEGIN
 INSERT INTO state_map_v1._empty VALUES(256,h);
 FOR d IN REVERSE 255..0 LOOP h:=state_map_v1._merge(h,0,h,0); INSERT INTO state_map_v1._empty VALUES(d,h); END LOOP;
END $$;
CREATE FUNCTION state_map_v1._extend(h bytea,n bigint,p bytea,d integer,target integer) RETURNS bytea LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE out bytea:=h; e bytea;
BEGIN
 IF target<0 OR d>256 OR target>d THEN RAISE EXCEPTION 'STATE_MAP_INVALID'; END IF;
 IF d>target THEN FOR i IN REVERSE d-1..target LOOP
 SELECT x.h INTO STRICT e FROM state_map_v1._empty x WHERE x.depth=i+1;
 IF state_map_v1._bit(p,i)=0 THEN out:=state_map_v1._merge(out,n,e,0); ELSE out:=state_map_v1._merge(e,0,out,n); END IF;
 END LOOP; END IF; RETURN out;
END $$;
CREATE FUNCTION state_map_v1._id(n state_map_v1.nodes) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT sha256(decode('05','hex') || set_byte(decode('00','hex'),0,n.kind) || int2send(n.depth) || n.prefix || int8send(n.item_count) || n.state_hash ||
 coalesce(n.left_id,decode(repeat('00',32),'hex')) || coalesce(n.right_id,decode(repeat('00',32),'hex')) || coalesce(n.value_hash,decode(repeat('00',32),'hex')))
$$;
CREATE FUNCTION state_map_v1._load(k bytea) RETURNS state_map_v1.nodes LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE n state_map_v1.nodes;
BEGIN
 PERFORM set_config('idms_smt.node_reads',(coalesce(nullif(current_setting('idms_smt.node_reads',true),''),'0')::bigint+1)::text,true);
 SELECT * INTO STRICT n FROM state_map_v1.nodes WHERE id=k;
 IF n.id<>state_map_v1._id(n) OR n.prefix<>state_map_v1._prefix(n.prefix,n.depth) OR
 (n.kind=0 AND (n.depth<>256 OR n.item_count<>1 OR n.left_id IS NOT NULL OR n.right_id IS NOT NULL OR n.value_hash IS NULL OR n.state_hash<>sha256(decode('00','hex')||n.prefix||n.value_hash))) OR
 (n.kind=1 AND (n.depth>=256 OR n.item_count<2 OR n.left_id IS NULL OR n.right_id IS NULL OR n.value_hash IS NOT NULL))
 THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY'; END IF; RETURN n;
END $$;
CREATE FUNCTION state_map_v1._branch(d integer,l bytea,r bytea,save boolean) RETURNS state_map_v1.nodes LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE a state_map_v1.nodes; b state_map_v1.nodes; n state_map_v1.nodes; old state_map_v1.nodes;
BEGIN
 a:=state_map_v1._load(l); b:=state_map_v1._load(r);
 IF d<0 OR d>=256 OR a.depth<=d OR b.depth<=d OR state_map_v1._lcp(a.prefix,b.prefix)<>d OR state_map_v1._bit(a.prefix,d)<>0 OR state_map_v1._bit(b.prefix,d)<>1 THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY'; END IF;
 n.kind:=1;n.depth:=d;n.prefix:=state_map_v1._prefix(a.prefix,d);n.item_count:=a.item_count+b.item_count;
 n.state_hash:=state_map_v1._merge(state_map_v1._extend(a.state_hash,a.item_count,a.prefix,a.depth,d+1),a.item_count,state_map_v1._extend(b.state_hash,b.item_count,b.prefix,b.depth,d+1),b.item_count);
 n.left_id:=l;n.right_id:=r;n.value_hash:=NULL;n.id:=state_map_v1._id(n);
 IF save THEN
 INSERT INTO state_map_v1.nodes SELECT n.* ON CONFLICT DO NOTHING;
 old:=state_map_v1._load(n.id); IF old IS DISTINCT FROM n THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY'; END IF;
 END IF; RETURN n;
END $$;
CREATE FUNCTION state_map_v1._checked(k bytea) RETURNS state_map_v1.nodes LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE n state_map_v1.nodes; b state_map_v1.nodes;
BEGIN n:=state_map_v1._load(k);IF n.kind=1 THEN b:=state_map_v1._branch(n.depth,n.left_id,n.right_id,false);IF n IS DISTINCT FROM b THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY'; END IF; END IF; RETURN n; END $$;
CREATE FUNCTION state_map_v1._leaf(k bytea,v bytea) RETURNS bytea LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE n state_map_v1.nodes;old state_map_v1.nodes;
BEGIN n.kind:=0;n.depth:=256;n.prefix:=k;n.item_count:=1;n.state_hash:=sha256(decode('00','hex')||k||v);n.value_hash:=v;n.id:=state_map_v1._id(n);
 INSERT INTO state_map_v1.nodes SELECT n.* ON CONFLICT DO NOTHING;old:=state_map_v1._load(n.id);IF old IS DISTINCT FROM n THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY'; END IF; RETURN n.id; END $$;
CREATE FUNCTION state_map_v1._lookup(root bytea,k bytea) RETURNS bytea LANGUAGE plpgsql VOLATILE AS $$
DECLARE n state_map_v1.nodes;cur bytea:=root;
BEGIN WHILE cur IS NOT NULL LOOP
 n:=state_map_v1._checked(cur);IF state_map_v1._prefix(k,n.depth)<>n.prefix THEN RETURN NULL; END IF;
 IF n.kind=0 THEN RETURN n.value_hash;END IF;IF state_map_v1._bit(k,n.depth)=0 THEN cur:=n.left_id;ELSE cur:=n.right_id;END IF;
 END LOOP;RETURN NULL;END $$;
CREATE FUNCTION state_map_v1._put(root bytea,k bytea,v bytea) RETURNS bytea LANGUAGE plpgsql VOLATILE AS $$
DECLARE n state_map_v1.nodes;b state_map_v1.nodes;d integer;l bytea;r bytea;fresh bytea;
BEGIN
 IF root IS NULL THEN IF v IS NULL THEN RETURN NULL;END IF;RETURN state_map_v1._leaf(k,v);END IF;
 n:=state_map_v1._checked(root);d:=state_map_v1._lcp(k,n.prefix);
 IF d<n.depth THEN
 IF v IS NULL THEN RETURN root;END IF;fresh:=state_map_v1._leaf(k,v);
 IF state_map_v1._bit(k,d)=0 THEN b:=state_map_v1._branch(d,fresh,root,true);ELSE b:=state_map_v1._branch(d,root,fresh,true);END IF;RETURN b.id;
 END IF;
 IF n.kind=0 THEN IF v IS NULL THEN RETURN NULL;END IF;IF n.value_hash=v THEN RETURN root;END IF;RETURN state_map_v1._leaf(k,v);END IF;
 l:=n.left_id;r:=n.right_id;IF state_map_v1._bit(k,n.depth)=0 THEN l:=state_map_v1._put(l,k,v);ELSE r:=state_map_v1._put(r,k,v);END IF;
 IF l IS NULL THEN RETURN r;END IF;IF r IS NULL THEN RETURN l;END IF;
 IF l=n.left_id AND r=n.right_id THEN RETURN root;END IF;b:=state_map_v1._branch(n.depth,l,r,true);RETURN b.id;
END $$;

INSERT INTO state_map_v1._meta VALUES(true,__TENANT__,'COMPRESSED_SMT_COUNTED_V1',__OWNER_LITERAL__::regrole::oid,__APP_LITERAL__::regrole::oid,__READER_LITERAL__::regrole::oid,0);
INSERT INTO state_map_v1.head SELECT true,0,NULL,h,0,decode(repeat('00',32),'hex') FROM state_map_v1._empty WHERE depth=0;
CREATE FUNCTION state_map_v1._write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR TG_TABLE_NAME IN('_meta','_empty') OR
 (TG_TABLE_NAME IN('nodes','kv_values','receipts') AND TG_OP<>'INSERT') OR
 NOT EXISTS(SELECT 1 FROM state_map_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current())
 THEN RAISE EXCEPTION 'STATE_MAP_DIRECT_WRITE_FORBIDDEN';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN FOR t IN SELECT unnest(ARRAY['_meta','_empty','nodes','kv_values','head','receipts']) LOOP
 EXECUTE format('CREATE TRIGGER state_map_write_guard BEFORE INSERT OR UPDATE OR DELETE ON state_map_v1.%I FOR EACH ROW EXECUTE FUNCTION state_map_v1._write_guard()',t);
 EXECUTE format('ALTER TABLE state_map_v1.%I ENABLE ALWAYS TRIGGER state_map_write_guard',t);
 EXECUTE format('CREATE TRIGGER state_map_truncate_guard BEFORE TRUNCATE ON state_map_v1.%I FOR EACH STATEMENT EXECUTE FUNCTION state_map_v1._write_guard()',t);
 EXECUTE format('ALTER TABLE state_map_v1.%I ENABLE ALWAYS TRIGGER state_map_truncate_guard',t);
 END LOOP;END $$;
CREATE FUNCTION state_map_v1._assert_current(wanted text,writing boolean) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE m state_map_v1._meta;e bigint;r record;h state_map_v1.head;n state_map_v1.nodes;tip state_map_v1.receipts;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(1229213011,1);
 LOCK TABLE state_map_v1._meta,state_map_v1._ctx,state_map_v1._empty,state_map_v1.nodes,state_map_v1.kv_values,state_map_v1.head,state_map_v1.receipts IN ACCESS SHARE MODE;
 SELECT * INTO STRICT m FROM state_map_v1._meta;
 IF wanted IS DISTINCT FROM m.tenant OR m.format<>'COMPRESSED_SMT_COUNTED_V1' OR
 (session_user::regrole::oid<>m.app_oid AND (writing OR session_user::regrole::oid<>m.reader_oid)) OR current_user::regrole::oid<>m.owner_oid
 THEN RAISE EXCEPTION 'STATE_MAP_AUTHORITY'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE oid IN(m.owner_oid,m.app_oid,m.reader_oid) LOOP
 IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR (r.oid=m.owner_oid AND r.rolcanlogin) OR (r.oid<>m.owner_oid AND NOT r.rolcanlogin) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
 THEN RAISE EXCEPTION 'STATE_MAP_AUTHORITY';END IF;END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE oid IN(m.owner_oid,m.app_oid,m.reader_oid))<>3 OR
 has_schema_privilege(m.app_oid,'state_map_v1','CREATE') OR has_schema_privilege(m.reader_oid,'state_map_v1','CREATE') OR
 EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='state_map_v1'::regnamespace AND c.relkind='r' AND (has_table_privilege(m.app_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege(m.reader_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR
 EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='state_map_v1'::regnamespace AND p.proname LIKE '\_%' ESCAPE '\' AND (has_function_privilege(m.app_oid,p.oid,'EXECUTE') OR has_function_privilege(m.reader_oid,p.oid,'EXECUTE'))) OR
 (SELECT count(*) FROM pg_event_trigger WHERE evtname IN('state_map_ddl_start_v1','state_map_ddl_end_v1','state_map_sql_drop_v1') AND evtenabled='A')<>3 OR
 (SELECT count(*) FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='state_map_v1'::regnamespace) AND tgname IN('state_map_write_guard','state_map_truncate_guard') AND tgenabled='A')<>12
 THEN RAISE EXCEPTION 'STATE_MAP_AUTHORITY';END IF;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO e FROM state_map_v1._ddl_epoch;
 IF e<>m.epoch THEN RAISE EXCEPTION 'STATE_MAP_SCHEMA_EPOCH'; END IF;
 SELECT * INTO STRICT h FROM state_map_v1.head;
 IF h.revision=0 THEN
 IF h.root_id IS NOT NULL OR h.item_count<>0 OR h.receipt_hash<>decode(repeat('00',32),'hex') THEN RAISE EXCEPTION 'STATE_MAP_RECEIPT_INTEGRITY';END IF;
 ELSE SELECT * INTO STRICT tip FROM state_map_v1.receipts WHERE revision=h.revision;
 IF tip.root_id IS DISTINCT FROM h.root_id OR tip.root_hash<>h.root_hash OR tip.item_count<>h.item_count OR tip.receipt_hash<>h.receipt_hash OR tip.revision<>tip.before_revision+1 OR tip.receipt_hash<>state_map_v1._receipt_hash(m.tenant,tip)
 THEN RAISE EXCEPTION 'STATE_MAP_RECEIPT_INTEGRITY';END IF;END IF;
 IF h.root_id IS NULL THEN IF h.item_count<>0 OR h.root_hash<>(SELECT x.h FROM state_map_v1._empty x WHERE depth=0) THEN RAISE EXCEPTION 'STATE_MAP_ROOT_INTEGRITY';END IF;
 ELSE n:=state_map_v1._checked(h.root_id);IF h.item_count<>n.item_count OR h.root_hash<>state_map_v1._extend(n.state_hash,n.item_count,n.prefix,n.depth,0) THEN RAISE EXCEPTION 'STATE_MAP_ROOT_INTEGRITY';END IF;END IF;
END $$;
CREATE FUNCTION state_map_v1._receipt_json(r state_map_v1.receipts,replayed boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('tenantId',(SELECT tenant FROM state_map_v1._meta),'commandId',r.command_id::text,'requestHash',encode(r.request_hash,'hex'),
 'beforeRevision',r.before_revision::text,'beforeRoot',encode(r.before_root,'hex'),'beforeReceiptHash',encode(r.before_receipt_hash,'hex'),
 'revision',r.revision::text,'rootId',encode(r.root_id,'hex'),'rootHash',encode(r.root_hash,'hex'),'count',r.item_count::text,'receiptHash',encode(r.receipt_hash,'hex'),'replayed',replayed)
$$;
CREATE FUNCTION state_map_v1._receipt_hash(tenant text,r state_map_v1.receipts) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT sha256(decode('08','hex')||state_map_v1._frame(tenant)||uuid_send(r.command_id)||r.request_hash||int8send(r.before_revision)||r.before_root||r.before_receipt_hash||int8send(r.revision)||coalesce(r.root_id,decode(repeat('00',32),'hex'))||r.root_hash||int8send(r.item_count))
$$;
CREATE FUNCTION state_map_v1.read_head_v1(tenant text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE h state_map_v1.head;BEGIN PERFORM state_map_v1._assert_current(tenant,false);SELECT * INTO STRICT h FROM state_map_v1.head;
 RETURN jsonb_build_object('revision',h.revision::text,'rootId',encode(h.root_id,'hex'),'rootHash',encode(h.root_hash,'hex'),'count',h.item_count::text,'receiptHash',encode(h.receipt_hash,'hex'));END $$;
CREATE FUNCTION state_map_v1.read_receipt_v1(tenant text,command uuid,request bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE r state_map_v1.receipts;BEGIN PERFORM state_map_v1._assert_current(tenant,false);SELECT * INTO r FROM state_map_v1.receipts WHERE command_id=command;IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.request_hash<>request THEN RAISE EXCEPTION 'STATE_MAP_COMMAND_CONFLICT';END IF;IF r.receipt_hash<>state_map_v1._receipt_hash(tenant,r) THEN RAISE EXCEPTION 'STATE_MAP_RECEIPT_INTEGRITY';END IF;RETURN state_map_v1._receipt_json(r,true);END $$;
CREATE FUNCTION state_map_v1._node_json(n state_map_v1.nodes) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('id',encode(n.id,'hex'),'kind',n.kind,'depth',n.depth,'prefix',encode(n.prefix,'hex'),'count',n.item_count::text,'hash',encode(n.state_hash,'hex'),'left',encode(n.left_id,'hex'),'right',encode(n.right_id,'hex'),'valueHash',encode(n.value_hash,'hex'))
$$;
CREATE FUNCTION state_map_v1._validate_json(v jsonb,depth integer) RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb;cells bigint:=1;number numeric;
BEGIN
 IF depth>128 THEN RAISE EXCEPTION 'STATE_MAP_VALUE_LIMIT';END IF;
 IF jsonb_typeof(v)='number' THEN
 number:=(v#>>'{}')::numeric;
 -- Underflow is representable as JS zero; large values must still be finite doubles.
 IF abs(number)>=1 THEN PERFORM number::double precision;END IF;
 ELSIF jsonb_typeof(v)='object' THEN
 FOR item IN SELECT value FROM jsonb_each(v) LOOP cells:=cells+state_map_v1._validate_json(item,depth+1);IF cells>500000 THEN RAISE EXCEPTION 'STATE_MAP_VALUE_LIMIT';END IF;END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
 FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP cells:=cells+state_map_v1._validate_json(item,depth+1);IF cells>500000 THEN RAISE EXCEPTION 'STATE_MAP_VALUE_LIMIT';END IF;END LOOP;
 END IF;RETURN cells;
END $$;
CREATE FUNCTION state_map_v1.read_proof_v1(tenant text,key_hash bytea,root bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE n state_map_v1.nodes;a state_map_v1.nodes;b state_map_v1.nodes;out jsonb:='[]';rh bytea;cnt bigint:=0;v text;vh bytea;steps integer:=0;
BEGIN
 PERFORM state_map_v1._assert_current(tenant,false);IF octet_length(key_hash)<>32 THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 IF root IS NULL THEN SELECT h INTO rh FROM state_map_v1._empty WHERE depth=0;
 ELSE n:=state_map_v1._checked(root);rh:=state_map_v1._extend(n.state_hash,n.item_count,n.prefix,n.depth,0);cnt:=n.item_count;out:=out||jsonb_build_array(state_map_v1._node_json(n));
 LOOP steps:=steps+1;IF steps>257 THEN RAISE EXCEPTION 'STATE_MAP_NODE_INTEGRITY';END IF;
 IF state_map_v1._prefix(key_hash,n.depth)<>n.prefix THEN EXIT;END IF;
 IF n.kind=0 THEN vh:=n.value_hash;SELECT value_text INTO STRICT v FROM state_map_v1.kv_values WHERE value_hash=vh;IF sha256(decode('03','hex')||convert_to(v,'UTF8'))<>vh THEN RAISE EXCEPTION 'STATE_MAP_VALUE_INTEGRITY';END IF;EXIT;END IF;
 a:=state_map_v1._load(n.left_id);b:=state_map_v1._load(n.right_id);out:=out||jsonb_build_array(state_map_v1._node_json(a),state_map_v1._node_json(b));
 IF state_map_v1._bit(key_hash,n.depth)=0 THEN n:=state_map_v1._checked(n.left_id);ELSE n:=state_map_v1._checked(n.right_id);END IF;
 END LOOP;END IF;
 RETURN jsonb_build_object('format','COMPRESSED_SMT_COUNTED_V1','keyHash',encode(key_hash,'hex'),'root',jsonb_build_object('rootId',encode(root,'hex'),'rootHash',encode(rh,'hex'),'count',cnt::text),'nodes',out,'valueText',v);
END $$;

CREATE FUNCTION state_map_v1.apply_delta_v1(tenant text,command uuid,expected_revision bigint,expected_root bytea,ops jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE h state_map_v1.head;r state_map_v1.receipts;old state_map_v1.receipts;n state_map_v1.nodes;o jsonb;ns text;k text;vt text;key_hash bytea;expected bytea;actual bytea;v_hash bytea;root bytea;request bytea;wire bytea;bytes bigint:=0;seen text[]:=ARRAY[]::text[];pair text;out jsonb;
BEGIN
 PERFORM state_map_v1._assert_current(tenant,true);
 IF command IS NULL OR expected_revision IS NULL OR expected_revision<0 OR expected_root IS NULL OR octet_length(expected_root)<>32 OR ops IS NULL OR jsonb_typeof(ops)<>'array' OR jsonb_array_length(ops)<1 OR jsonb_array_length(ops)>64 THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 PERFORM set_config('idms_smt.node_reads','0',true);
 wire:=decode('07','hex')||state_map_v1._frame(tenant)||uuid_send(command)||int8send(expected_revision)||expected_root||int4send(jsonb_array_length(ops));
 FOR o IN SELECT * FROM jsonb_array_elements(ops) LOOP
 IF jsonb_typeof(o)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>4 OR NOT(o ?& ARRAY['namespace','key','expected','valueText']) OR jsonb_typeof(o->'namespace')<>'string' OR jsonb_typeof(o->'key')<>'string' OR jsonb_typeof(o->'expected') NOT IN('null','string') OR jsonb_typeof(o->'valueText') NOT IN('null','string') THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 ns:=o->>'namespace';k:=o->>'key';vt:=o->>'valueText';
 IF ns !~ '^[a-z][a-z0-9_]{0,63}$' OR octet_length(k)<1 OR octet_length(k)>512 OR (o->>'expected' IS NOT NULL AND o->>'expected' !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 pair:=ns||':'||k;IF pair=ANY(seen) THEN RAISE EXCEPTION 'STATE_MAP_DUPLICATE_KEY';END IF;seen:=array_append(seen,pair);
 wire:=wire||state_map_v1._frame(ns)||state_map_v1._frame(k)||CASE WHEN o->>'expected' IS NULL THEN decode('00','hex') ELSE decode('01','hex')||decode(o->>'expected','hex') END;
 IF vt IS NULL THEN wire:=wire||decode('00','hex');ELSE
 bytes:=bytes+octet_length(vt);IF octet_length(vt)>1048576 OR bytes>8388608 THEN RAISE EXCEPTION 'STATE_MAP_VALUE_LIMIT';END IF;
 IF NOT(vt IS JSON WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'STATE_MAP_INVALID_JSON';END IF;PERFORM state_map_v1._validate_json(vt::jsonb,0);
 wire:=wire||decode('01','hex')||state_map_v1._frame(vt);END IF;
 END LOOP;
 request:=sha256(wire);
 SELECT * INTO STRICT h FROM state_map_v1.head FOR UPDATE;
 SELECT * INTO old FROM state_map_v1.receipts WHERE command_id=command;
 IF FOUND THEN IF old.request_hash<>request THEN RAISE EXCEPTION 'STATE_MAP_COMMAND_CONFLICT';END IF;IF old.receipt_hash<>state_map_v1._receipt_hash(tenant,old) THEN RAISE EXCEPTION 'STATE_MAP_RECEIPT_INTEGRITY';END IF;
 PERFORM state_map_v1._assert_current(tenant,true);RETURN state_map_v1._receipt_json(old,true);END IF;
 IF h.revision<>expected_revision OR h.root_hash<>expected_root THEN RAISE EXCEPTION 'STATE_MAP_CAS_CONFLICT';END IF;
 INSERT INTO state_map_v1._ctx VALUES(pg_backend_pid(),txid_current());root:=h.root_id;
 FOR o IN SELECT * FROM jsonb_array_elements(ops) LOOP
 ns:=o->>'namespace';k:=o->>'key';vt:=o->>'valueText';expected:=decode(o->>'expected','hex');
 key_hash:=sha256(decode('04','hex')||state_map_v1._frame(tenant)||state_map_v1._frame(ns)||state_map_v1._frame(k));actual:=state_map_v1._lookup(root,key_hash);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'STATE_MAP_KEY_CONFLICT';END IF;
 IF ns IN('audit','receipt','blob') AND actual IS NOT NULL THEN RAISE EXCEPTION 'STATE_MAP_IMMUTABLE_KEY';END IF;
 v_hash:=NULL;IF vt IS NOT NULL THEN v_hash:=sha256(decode('03','hex')||convert_to(vt,'UTF8'));
 INSERT INTO state_map_v1.kv_values VALUES(v_hash,vt) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM state_map_v1.kv_values x WHERE x.value_hash=v_hash AND x.value_text=vt) THEN RAISE EXCEPTION 'STATE_MAP_VALUE_INTEGRITY';END IF;END IF;
 root:=state_map_v1._put(root,key_hash,v_hash);
 END LOOP;
 r.command_id:=command;r.request_hash:=request;r.before_revision:=h.revision;r.before_root:=h.root_hash;r.before_receipt_hash:=h.receipt_hash;r.revision:=h.revision+1;r.root_id:=root;
 IF root IS NULL THEN r.item_count:=0;SELECT x.h INTO r.root_hash FROM state_map_v1._empty x WHERE depth=0;ELSE n:=state_map_v1._checked(root);r.item_count:=n.item_count;r.root_hash:=state_map_v1._extend(n.state_hash,n.item_count,n.prefix,n.depth,0);END IF;
 r.receipt_hash:=state_map_v1._receipt_hash(tenant,r);INSERT INTO state_map_v1.receipts SELECT r.*;
 UPDATE state_map_v1.head SET revision=r.revision,root_id=r.root_id,root_hash=r.root_hash,item_count=r.item_count,receipt_hash=r.receipt_hash;
 PERFORM state_map_v1._assert_current(tenant,true);DELETE FROM state_map_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
 out:=state_map_v1._receipt_json(r,false);RETURN out||jsonb_build_object('diagnostics',jsonb_build_object('nodeReads',current_setting('idms_smt.node_reads')::bigint));
END $$;

REVOKE ALL ON SCHEMA state_map_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA state_map_v1 FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA state_map_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA state_map_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA state_map_v1 TO __APP__,__READER__;
GRANT SELECT ON state_map_v1.nodes,state_map_v1.kv_values,state_map_v1.head,state_map_v1.receipts TO __APP__,__READER__;
GRANT EXECUTE ON FUNCTION state_map_v1.read_head_v1(text),state_map_v1.read_receipt_v1(text,uuid,bytea),state_map_v1.read_proof_v1(text,bytea,bytea) TO __APP__,__READER__;
GRANT EXECUTE ON FUNCTION state_map_v1.apply_delta_v1(text,uuid,bigint,bytea,jsonb) TO __APP__;
RESET ROLE;

CREATE FUNCTION state_map_v1._ddl_start() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
BEGIN PERFORM pg_advisory_xact_lock(1229213011,1);END $$;
CREATE FUNCTION state_map_v1._ddl_end() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE schema_name='state_map_v1') THEN PERFORM nextval('state_map_v1._ddl_epoch'::regclass);END IF;END $$;
CREATE FUNCTION state_map_v1._sql_drop() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_dropped_objects() WHERE schema_name='state_map_v1') THEN PERFORM nextval('state_map_v1._ddl_epoch'::regclass);END IF;END $$;
ALTER FUNCTION state_map_v1._ddl_start() OWNER TO __OWNER__;
ALTER FUNCTION state_map_v1._ddl_end() OWNER TO __OWNER__;
ALTER FUNCTION state_map_v1._sql_drop() OWNER TO __OWNER__;
REVOKE ALL ON FUNCTION state_map_v1._ddl_start(),state_map_v1._ddl_end(),state_map_v1._sql_drop() FROM PUBLIC;
CREATE EVENT TRIGGER state_map_ddl_start_v1 ON ddl_command_start EXECUTE FUNCTION state_map_v1._ddl_start();
CREATE EVENT TRIGGER state_map_ddl_end_v1 ON ddl_command_end EXECUTE FUNCTION state_map_v1._ddl_end();
CREATE EVENT TRIGGER state_map_sql_drop_v1 ON sql_drop EXECUTE FUNCTION state_map_v1._sql_drop();
ALTER EVENT TRIGGER state_map_ddl_start_v1 ENABLE ALWAYS;
ALTER EVENT TRIGGER state_map_ddl_end_v1 ENABLE ALWAYS;
ALTER EVENT TRIGGER state_map_sql_drop_v1 ENABLE ALWAYS;
