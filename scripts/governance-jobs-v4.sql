-- Installed only in a fresh owned deployment, after state-map implementation 3.
CREATE SCHEMA governance_jobs_v4 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
SET search_path=pg_catalog,governance_jobs_v4,pg_temp;
CREATE SEQUENCE governance_jobs_v4._ddl_epoch;
CREATE TABLE governance_jobs_v4._meta(singleton boolean PRIMARY KEY CHECK(singleton),tenant text NOT NULL,
 owner_oid oid NOT NULL,worker_oid oid NOT NULL,ingress_oid oid NOT NULL,deployment text NOT NULL,epoch bigint NOT NULL);
CREATE TABLE governance_jobs_v4._ctx(pid integer PRIMARY KEY,tx bigint NOT NULL);
CREATE TABLE governance_jobs_v4.jobs(
 id uuid PRIMARY KEY,ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,tenant text NOT NULL,actor_id text NOT NULL,command_id uuid NOT NULL,
 action text NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),business_key text NOT NULL CHECK(business_key~'^[a-f0-9]{64}$'),
 sealed_command jsonb NOT NULL CHECK(jsonb_typeof(sealed_command)='object' AND octet_length(sealed_command::text)<=25165824),
 sealed_grant jsonb NOT NULL CHECK(jsonb_typeof(sealed_grant)='object' AND octet_length(sealed_grant::text)<=65536),
 grant_revision bigint NOT NULL CHECK(grant_revision>0),grant_until timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('ACCEPTED','RUNNING','WAITING_AUTH','RETRY','FAILED','COMMITTED','CANCELLED')),
 cancel_requested boolean NOT NULL DEFAULT false,worker_id uuid,claim_token uuid,fence bigint NOT NULL DEFAULT 0,
 lease_until timestamptz,next_attempt timestamptz NOT NULL DEFAULT clock_timestamp(),auth_deadline timestamptz,
 attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result jsonb,error_code text,publication_id uuid,
 CONSTRAINT governance_job_identity UNIQUE(tenant,actor_id,command_id));
INSERT INTO governance_jobs_v4._meta VALUES(true,__TENANT__,__OWNER_LITERAL__::regrole::oid,__WORKER_LITERAL__::regrole::oid,__INGRESS_LITERAL__::regrole::oid,__DEPLOYMENT__,0);
CREATE FUNCTION governance_jobs_v4._write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR TG_TABLE_NAME='_meta' OR
 NOT EXISTS(SELECT 1 FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current())
 THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_DIRECT_WRITE';END IF;
 IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.ordinal,OLD.tenant,OLD.actor_id,OLD.command_id,OLD.action,OLD.request_hash,OLD.business_key,OLD.sealed_command,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.id,NEW.ordinal,NEW.tenant,NEW.actor_id,NEW.command_id,NEW.action,NEW.request_hash,NEW.business_key,NEW.sealed_command,NEW.created_at)
 THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_IMMUTABLE';END IF;
 IF TG_OP='UPDATE' AND OLD.status IN('COMMITTED','FAILED','CANCELLED') THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_TERMINAL';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOR t IN SELECT unnest(ARRAY['_meta','jobs']) LOOP
 EXECUTE format('CREATE TRIGGER governance_queue_write_guard BEFORE INSERT OR UPDATE OR DELETE ON governance_jobs_v4.%I FOR EACH ROW EXECUTE FUNCTION governance_jobs_v4._write_guard()',t);
 EXECUTE format('ALTER TABLE governance_jobs_v4.%I ENABLE ALWAYS TRIGGER governance_queue_write_guard',t);
 EXECUTE format('CREATE TRIGGER governance_queue_truncate_guard BEFORE TRUNCATE ON governance_jobs_v4.%I FOR EACH STATEMENT EXECUTE FUNCTION governance_jobs_v4._write_guard()',t);
 EXECUTE format('ALTER TABLE governance_jobs_v4.%I ENABLE ALWAYS TRIGGER governance_queue_truncate_guard',t);
 END LOOP;END $$;
CREATE FUNCTION governance_jobs_v4._assert(tenant text,worker boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m governance_jobs_v4._meta;e bigint;r record;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(1229213011,2);
 LOCK TABLE governance_jobs_v4._meta,governance_jobs_v4._ctx,governance_jobs_v4.jobs IN ACCESS SHARE MODE;
 SELECT * INTO STRICT m FROM governance_jobs_v4._meta;
 IF tenant IS DISTINCT FROM m.tenant OR current_user::regrole::oid<>m.owner_oid OR
 (session_user::regrole::oid<>m.worker_oid AND (worker OR session_user::regrole::oid<>m.ingress_oid)) THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_AUTHORITY';END IF;
 FOR r IN SELECT * FROM pg_roles WHERE oid IN(m.owner_oid,m.worker_oid,m.ingress_oid) LOOP
 IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolcanlogin<>(r.oid<>m.owner_oid) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_AUTHORITY';END IF;END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE oid IN(m.owner_oid,m.worker_oid,m.ingress_oid))<>3 OR
 EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='governance_jobs_v4'::regnamespace AND c.relkind='r' AND (has_table_privilege(m.worker_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege(m.ingress_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR
 has_schema_privilege(m.worker_oid,'governance_jobs_v4','CREATE') OR has_schema_privilege(m.ingress_oid,'governance_jobs_v4','CREATE') OR
 EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='governance_jobs_v4'::regnamespace AND p.proname LIKE '\_%' ESCAPE '\' AND (has_function_privilege(m.worker_oid,p.oid,'EXECUTE') OR has_function_privilege(m.ingress_oid,p.oid,'EXECUTE'))) OR
 (SELECT count(*) FROM pg_trigger WHERE tgrelid IN('governance_jobs_v4._meta'::regclass,'governance_jobs_v4.jobs'::regclass) AND tgname IN('governance_queue_write_guard','governance_queue_truncate_guard') AND tgenabled='A')<>4 OR
 (SELECT count(*) FROM pg_event_trigger WHERE evtname IN('governance_queue_ddl_start_v4','governance_queue_ddl_end_v4','governance_queue_sql_drop_v4') AND evtenabled='A')<>3
 THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_AUTHORITY';END IF;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO e FROM governance_jobs_v4._ddl_epoch;
 IF e<>m.epoch THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_SCHEMA_EPOCH';END IF;
END $$;
CREATE FUNCTION governance_jobs_v4._business_key(tenant text,actor text,command uuid) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('['||to_json(tenant)::text||','||to_json(actor)::text||',"USER",'||to_json(command::text)::text||']','UTF8')),'hex')
$$;
CREATE FUNCTION governance_jobs_v4._public(j governance_jobs_v4.jobs) RETURNS jsonb LANGUAGE sql STABLE STRICT AS $$
 SELECT jsonb_build_object('id',j.id::text,'tenantId',j.tenant,'actorId',j.actor_id,'commandId',j.command_id::text,'action',j.action,'requestHash',j.request_hash,'businessKey',j.business_key,
 'sealedCommand',j.sealed_command,'grantRevision',j.grant_revision::text,'status',j.status,'leaseLive',j.lease_until>clock_timestamp(),'cancelRequested',j.cancel_requested,
 'attempts',j.attempts,'result',j.result,'errorCode',j.error_code,'publicationId',j.publication_id::text,'createdAt',j.created_at,'updatedAt',j.updated_at)
$$;
CREATE FUNCTION governance_jobs_v4.enqueue_v4(tenant text,actor text,wanted uuid,command uuid,action text,request text,sealed_command jsonb,sealed_grant jsonb,grant_until timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;
BEGIN
 PERFORM governance_jobs_v4._assert(tenant,false);
 IF wanted IS NULL OR command IS NULL OR actor IS NULL OR octet_length(actor)<1 OR octet_length(actor)>512 OR request !~ '^[a-f0-9]{64}$' OR action NOT IN('TEMPLATE_CREATE','TEMPLATE_EDIT','TEMPLATE_SUBMIT','TEMPLATE_APPROVE','IMPORT_CREATE','IMPORT_APPROVE') OR grant_until IS NULL OR grant_until<=clock_timestamp() OR sealed_command IS NULL OR sealed_grant IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_INPUT';END IF;
 INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 INSERT INTO governance_jobs_v4.jobs(id,tenant,actor_id,command_id,action,request_hash,business_key,sealed_command,sealed_grant,grant_revision,grant_until,status)
 VALUES(wanted,tenant,actor,command,action,request,governance_jobs_v4._business_key(tenant,actor,command),sealed_command,sealed_grant,1,grant_until,'ACCEPTED') ON CONFLICT ON CONSTRAINT governance_job_identity DO NOTHING;
 SELECT * INTO STRICT j FROM governance_jobs_v4.jobs q WHERE q.tenant=enqueue_v4.tenant AND q.actor_id=actor AND q.command_id=command;
 IF j.request_hash<>request OR j.action<>action THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_COMMAND_CONFLICT';END IF;
 DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN governance_jobs_v4._public(j);
END $$;
CREATE FUNCTION governance_jobs_v4.read_v4(tenant text,actor text,wanted uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN PERFORM governance_jobs_v4._assert(tenant,false);SELECT * INTO j FROM governance_jobs_v4.jobs q WHERE q.id=wanted AND q.tenant=read_v4.tenant AND q.actor_id=actor;IF NOT FOUND THEN RETURN NULL;END IF;RETURN governance_jobs_v4._public(j);END $$;
CREATE FUNCTION governance_jobs_v4.find_v4(tenant text,actor text,command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN PERFORM governance_jobs_v4._assert(tenant,false);SELECT * INTO j FROM governance_jobs_v4.jobs q WHERE q.command_id=command AND q.tenant=find_v4.tenant AND q.actor_id=actor;IF NOT FOUND THEN RETURN NULL;END IF;RETURN governance_jobs_v4._public(j);END $$;
CREATE FUNCTION governance_jobs_v4.authorize_v4(tenant text,actor text,wanted uuid,expected_grant bigint,sealed jsonb,until_time timestamptz,cancel boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;
BEGIN
 PERFORM governance_jobs_v4._assert(tenant,false);SELECT * INTO STRICT j FROM governance_jobs_v4.jobs q WHERE q.id=wanted AND q.tenant=authorize_v4.tenant AND q.actor_id=actor FOR UPDATE;
 IF j.status IN('COMMITTED','FAILED','CANCELLED') THEN RETURN governance_jobs_v4._public(j);END IF;
 IF j.grant_revision<>expected_grant OR sealed IS NULL OR until_time IS NULL OR until_time<=clock_timestamp() THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_GRANT_CONFLICT';END IF;
 INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE governance_jobs_v4.jobs SET sealed_grant=sealed,grant_revision=j.grant_revision+1,grant_until=until_time,cancel_requested=cancel_requested OR cancel,status='ACCEPTED',worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,fence=fence+1,next_attempt=clock_timestamp(),updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;
 DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN governance_jobs_v4._public(j);
END $$;
CREATE FUNCTION governance_jobs_v4.claim_v4(tenant text,owner uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;
BEGIN
 PERFORM governance_jobs_v4._assert(tenant,true);IF owner IS NULL OR token IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_INPUT';END IF;
 PERFORM 1 FROM governance_jobs_v4._meta FOR UPDATE;
 SELECT * INTO j FROM governance_jobs_v4.jobs q WHERE q.status NOT IN('COMMITTED','FAILED','CANCELLED') ORDER BY q.ordinal LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR j.status='WAITING_AUTH' OR j.next_attempt>clock_timestamp() OR j.status='RUNNING' AND j.lease_until>clock_timestamp() THEN RETURN NULL;END IF;
 INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE governance_jobs_v4.jobs SET status='RUNNING',worker_id=owner,claim_token=token,fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
 RETURN governance_jobs_v4._public(j)||jsonb_build_object('sealedGrant',j.sealed_grant,'grantUntil',j.grant_until,'owner',j.worker_id::text,'token',j.claim_token::text,'fence',j.fence::text,'leaseUntil',j.lease_until);
END $$;
CREATE FUNCTION governance_jobs_v4._claim(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS governance_jobs_v4.jobs LANGUAGE plpgsql AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN PERFORM governance_jobs_v4._assert(tenant,true);SELECT * INTO STRICT j FROM governance_jobs_v4.jobs WHERE id=wanted FOR UPDATE;
 IF j.tenant<>tenant OR j.status<>'RUNNING' OR j.worker_id IS DISTINCT FROM owner OR j.claim_token IS DISTINCT FROM token OR j.fence<>fence OR j.grant_revision<>grant_revision OR j.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_LEASE_LOST';END IF;RETURN j;END $$;
CREATE FUNCTION governance_jobs_v4.renew_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE governance_jobs_v4.jobs SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=wanted;DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;END $$;
CREATE FUNCTION governance_jobs_v4.lock_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);IF deadline IS NULL OR deadline<=clock_timestamp() OR j.grant_until<=clock_timestamp() THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_AUTH_EXPIRED';END IF;INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE governance_jobs_v4.jobs SET auth_deadline=deadline WHERE id=wanted;DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN governance_jobs_v4._public(j);END $$;
CREATE FUNCTION governance_jobs_v4.prepare_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,command uuid,revision bigint,root bytea,operations jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM governance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF j.cancel_requested THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_CANCEL_PENDING';END IF;
 RETURN state_map_v1.apply_delta_v1(tenant,command,revision,root,operations);
END $$;
CREATE FUNCTION governance_jobs_v4.defer_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,waiting_auth boolean,code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);IF code !~ '^[A-Z0-9_]{1,80}$' THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_INPUT';END IF;INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE governance_jobs_v4.jobs SET status=CASE WHEN waiting_auth THEN 'WAITING_AUTH' ELSE 'RETRY' END,error_code=code,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,next_attempt=clock_timestamp()+interval '1 second',updated_at=clock_timestamp() WHERE id=wanted;DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;END $$;
CREATE FUNCTION governance_jobs_v4.finish_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;p jsonb;r jsonb;publication state_map_v1.receipts;branch state_map_v1.branch_heads;key_hash bytea;outcome text;
BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);
 j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF j.auth_deadline IS NULL OR j.auth_deadline<=clock_timestamp() OR j.grant_until<=clock_timestamp() THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_AUTH_EXPIRED';END IF;
 key_hash:=sha256(decode('04','hex')||state_map_v1._frame(tenant)||state_map_v1._frame('receipt')||state_map_v1._frame('governance_command:'||j.business_key));
 p:=state_map_v1.read_proof_v1(tenant,key_hash,(SELECT root_id FROM state_map_v1.head));IF p->>'valueText' IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_BUSINESS_UNCONFIRMED';END IF;r:=(p->>'valueText')::jsonb;
 IF r->>'format'<>'IDMS_GOVERNANCE_COMMAND_V4_1' OR r->>'key'<>j.business_key OR r->>'requestHash'<>j.request_hash THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_BUSINESS_INTEGRITY';END IF;
 IF r->>'status'='COMMITTED' THEN
 SELECT * INTO STRICT publication FROM state_map_v1.receipts WHERE command_id=(r->>'publicationId')::uuid;
 SELECT * INTO STRICT branch FROM state_map_v1.branch_heads WHERE branch_id=(r->>'branchId')::uuid;
 IF branch.published_command IS DISTINCT FROM publication.command_id OR branch.root_id IS DISTINCT FROM publication.root_id OR publication.receipt_hash<>state_map_v1._receipt_hash(tenant,publication) THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_BUSINESS_INTEGRITY';END IF;outcome:='COMMITTED';
 ELSIF r->>'status'='FAILED' THEN outcome:=CASE WHEN r->'error'->>'message'='GOVERNANCE_JOB_CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END;
 ELSE RAISE EXCEPTION 'GOVERNANCE_QUEUE_BUSINESS_UNCONFIRMED';END IF;
 INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE governance_jobs_v4.jobs SET status=outcome,result=CASE WHEN outcome='COMMITTED' THEN r->'result' ELSE r->'error' END,error_code=CASE WHEN outcome='COMMITTED' THEN NULL ELSE outcome END,publication_id=CASE WHEN outcome='COMMITTED' THEN publication.command_id ELSE NULL END,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;
 DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN governance_jobs_v4._public(j);
END $$;
CREATE FUNCTION governance_jobs_v4.publish_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,branch uuid,command uuid,base_revision bigint,base_root bytea,stage_revision bigint,stage_root bytea,stage_receipt bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;publication jsonb;finished jsonb;
BEGIN
 -- Preserve lock order: state-map DDL gate 1, queue DDL gate 2, claim row.
 PERFORM state_map_v1.read_head_v1(tenant);
 PERFORM governance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);
 j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF j.cancel_requested THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_CANCEL_PENDING';END IF;
 publication:=state_map_v1.publish_branch_v1(tenant,branch,command,base_revision,base_root,stage_revision,stage_root,stage_receipt);
 finished:=governance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);
 IF finished->>'status'<>'COMMITTED' OR finished->>'publicationId'<>command::text THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_PUBLICATION_MISMATCH';END IF;
 RETURN jsonb_build_object('publication',publication,'job',finished);
END $$;
CREATE FUNCTION governance_jobs_v4._state(tenant text,ns text,wanted text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p jsonb;k bytea;BEGIN k:=sha256(decode('04','hex')||state_map_v1._frame(tenant)||state_map_v1._frame(ns)||state_map_v1._frame(wanted));p:=state_map_v1.read_proof_v1(tenant,k,(SELECT root_id FROM state_map_v1.head));RETURN jsonb_build_object('value',CASE WHEN p->>'valueText' IS NULL THEN NULL ELSE (p->>'valueText')::jsonb END,'hash',CASE WHEN p->>'valueText' IS NULL THEN NULL ELSE encode(sha256(decode('03','hex')||convert_to(p->>'valueText','UTF8')),'hex') END);END $$;
CREATE FUNCTION governance_jobs_v4.cancel_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,cancel_command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;h jsonb;existing jsonb;control jsonb;job jsonb;ops jsonb;body jsonb;next_control jsonb;ignored jsonb;
BEGIN
 h:=state_map_v1.read_head_v1(tenant);PERFORM governance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=governance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF NOT j.cancel_requested OR cancel_command IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_CANCEL_NOT_REQUESTED';END IF;
 existing:=governance_jobs_v4._state(tenant,'receipt','governance_command:'||j.business_key);
 IF existing->'value' IS NOT NULL AND existing->'value'<>'null'::jsonb THEN RETURN governance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);END IF;
 control:=governance_jobs_v4._state(tenant,'domain_head','control');job:=governance_jobs_v4._state(tenant,'domain_head','governance_job');
 IF control->'value'->>'format'<>'IDMS_TELEMETRY_DOMAIN_V4_1' OR control->'value'->>'tenantId'<>tenant THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_CONTROL';END IF;
 IF control->'value'->>'status'='UPDATING' THEN
 IF job->'value'->>'key'<>j.business_key OR job->'value'->>'requestHash'<>j.request_hash THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_OTHER_COMMAND_BUSY';END IF;
 ELSIF control->'value'->>'status'<>'ACTIVE' THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_CONTROL';END IF;
 body:=jsonb_build_object('format','IDMS_GOVERNANCE_COMMAND_V4_1','key',j.business_key,'requestHash',j.request_hash,'status','FAILED','error',jsonb_build_object('status',409,'message','GOVERNANCE_JOB_CANCELLED'));
 ops:=jsonb_build_array(jsonb_build_object('namespace','receipt','key','governance_command:'||j.business_key,'expected',NULL,'valueText',body::text));
 IF control->'value'->>'status'='UPDATING' THEN next_control:=(control->'value')||jsonb_build_object('status','ACTIVE','epoch',((control->'value'->>'epoch')::bigint+1)::text);ops:=ops||jsonb_build_array(jsonb_build_object('namespace','domain_head','key','control','expected',control->>'hash','valueText',next_control::text));END IF;
 ignored:=state_map_v1.apply_delta_v1(tenant,cancel_command,(h->>'revision')::bigint,decode(h->>'rootHash','hex'),ops);
 RETURN governance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);
END $$;
REVOKE ALL ON SCHEMA governance_jobs_v4 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA governance_jobs_v4 FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA governance_jobs_v4 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA governance_jobs_v4 FROM PUBLIC;
GRANT USAGE ON SCHEMA governance_jobs_v4 TO __WORKER__,__INGRESS__;
GRANT EXECUTE ON FUNCTION governance_jobs_v4.prepare_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,bigint,bytea,jsonb) TO __WORKER__;
GRANT EXECUTE ON FUNCTION governance_jobs_v4.enqueue_v4(text,text,uuid,uuid,text,text,jsonb,jsonb,timestamptz),governance_jobs_v4.read_v4(text,text,uuid),governance_jobs_v4.find_v4(text,text,uuid),governance_jobs_v4.authorize_v4(text,text,uuid,bigint,jsonb,timestamptz,boolean) TO __INGRESS__;
GRANT EXECUTE ON FUNCTION governance_jobs_v4.read_v4(text,text,uuid),governance_jobs_v4.find_v4(text,text,uuid),governance_jobs_v4.claim_v4(text,uuid,uuid),governance_jobs_v4.renew_v4(text,uuid,uuid,uuid,bigint,bigint),governance_jobs_v4.lock_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz),governance_jobs_v4.defer_v4(text,uuid,uuid,uuid,bigint,bigint,boolean,text),governance_jobs_v4.finish_v4(text,uuid,uuid,uuid,bigint,bigint) TO __WORKER__;
GRANT EXECUTE ON FUNCTION governance_jobs_v4.publish_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) TO __WORKER__;
GRANT EXECUTE ON FUNCTION governance_jobs_v4.cancel_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid) TO __WORKER__;
RESET ROLE;
CREATE FUNCTION governance_jobs_v4._ddl_start() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$ BEGIN PERFORM pg_advisory_xact_lock(1229213011,1);PERFORM pg_advisory_xact_lock(1229213011,2);END $$;
CREATE FUNCTION governance_jobs_v4._ddl_end() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$ BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE schema_name='governance_jobs_v4') THEN PERFORM nextval('governance_jobs_v4._ddl_epoch'::regclass);END IF;END $$;
CREATE FUNCTION governance_jobs_v4._sql_drop() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$ BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_dropped_objects() WHERE schema_name='governance_jobs_v4') THEN PERFORM nextval('governance_jobs_v4._ddl_epoch'::regclass);END IF;END $$;
ALTER FUNCTION governance_jobs_v4._ddl_start() OWNER TO __OWNER__;
ALTER FUNCTION governance_jobs_v4._ddl_end() OWNER TO __OWNER__;
ALTER FUNCTION governance_jobs_v4._sql_drop() OWNER TO __OWNER__;
REVOKE ALL ON FUNCTION governance_jobs_v4._ddl_start(),governance_jobs_v4._ddl_end(),governance_jobs_v4._sql_drop() FROM PUBLIC;
CREATE EVENT TRIGGER governance_queue_ddl_start_v4 ON ddl_command_start EXECUTE FUNCTION governance_jobs_v4._ddl_start();
CREATE EVENT TRIGGER governance_queue_ddl_end_v4 ON ddl_command_end EXECUTE FUNCTION governance_jobs_v4._ddl_end();
CREATE EVENT TRIGGER governance_queue_sql_drop_v4 ON sql_drop EXECUTE FUNCTION governance_jobs_v4._sql_drop();
ALTER EVENT TRIGGER governance_queue_ddl_start_v4 ENABLE ALWAYS;
ALTER EVENT TRIGGER governance_queue_ddl_end_v4 ENABLE ALWAYS;
ALTER EVENT TRIGGER governance_queue_sql_drop_v4 ENABLE ALWAYS;
