-- Explicit fresh-deployment installation; no startup DDL.
CREATE SCHEMA reconciliation_jobs_v1 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
CREATE SEQUENCE reconciliation_jobs_v1._ddl_epoch;
CREATE TABLE reconciliation_jobs_v1._meta(singleton boolean PRIMARY KEY CHECK(singleton),tenant text NOT NULL,owner_oid oid NOT NULL,worker_oid oid NOT NULL,ingress_oid oid NOT NULL,deployment text NOT NULL,epoch bigint NOT NULL);
CREATE TABLE reconciliation_jobs_v1._ctx(pid integer PRIMARY KEY,tx bigint NOT NULL);
CREATE TABLE reconciliation_jobs_v1.jobs(
 id uuid PRIMARY KEY,ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,tenant text NOT NULL,case_id uuid NOT NULL,operation_id uuid NOT NULL,actor_id text NOT NULL,
 action text NOT NULL CHECK(action IN('OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE')),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),domain_hash text NOT NULL CHECK(domain_hash~'^[a-f0-9]{64}$'),
 sealed_command jsonb NOT NULL CHECK(jsonb_typeof(sealed_command)='object' AND octet_length(sealed_command::text)<=65536),sealed_grant jsonb NOT NULL CHECK(jsonb_typeof(sealed_grant)='object' AND octet_length(sealed_grant::text)<=65536),
 grant_revision bigint NOT NULL DEFAULT 1 CHECK(grant_revision>0),grant_until timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'ACCEPTED' CHECK(status IN('ACCEPTED','RUNNING','WAITING_AUTH','RETRY','FAILED','COMMITTED')),
 worker_id uuid,claim_token uuid,fence bigint NOT NULL DEFAULT 0,lease_until timestamptz,next_attempt timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0,result jsonb,error_code text,publication_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant,case_id,operation_id));
CREATE TABLE reconciliation_jobs_v1.cases(tenant text NOT NULL,case_id uuid NOT NULL,active_job uuid REFERENCES reconciliation_jobs_v1.jobs(id),releasing_job uuid REFERENCES reconciliation_jobs_v1.jobs(id),PRIMARY KEY(tenant,case_id));
CREATE TABLE reconciliation_jobs_v1.fences(tenant text NOT NULL,case_id uuid NOT NULL,operation_id uuid NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant,case_id,operation_id));
CREATE TABLE reconciliation_jobs_v1.authorizations(control_id uuid PRIMARY KEY,tenant text NOT NULL,case_id uuid NOT NULL,operation_id uuid NOT NULL,actor_id text NOT NULL,expected_grant bigint NOT NULL,session_hash text NOT NULL CHECK(session_hash~'^[a-f0-9]{64}$'),job_id uuid NOT NULL REFERENCES reconciliation_jobs_v1.jobs(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE reconciliation_jobs_v1.authorities(tenant text NOT NULL,case_id uuid NOT NULL,operation_id uuid NOT NULL,actor_id text NOT NULL,session_hash text NOT NULL CHECK(session_hash~'^[a-f0-9]{64}$'),sealed_grant jsonb NOT NULL,grant_revision bigint NOT NULL,grant_until timestamptz NOT NULL,job_id uuid NOT NULL REFERENCES reconciliation_jobs_v1.jobs(id),PRIMARY KEY(tenant,case_id,operation_id));
CREATE TABLE reconciliation_jobs_v1.releases(tenant text NOT NULL,case_id uuid NOT NULL,job_id uuid NOT NULL UNIQUE REFERENCES reconciliation_jobs_v1.jobs(id),operation_id uuid NOT NULL,case_snapshot jsonb NOT NULL,publication jsonb NOT NULL,auth_witness jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant,case_id));
INSERT INTO reconciliation_jobs_v1._meta VALUES(true,__TENANT__,__OWNER_LITERAL__::regrole::oid,__WORKER_LITERAL__::regrole::oid,__INGRESS_LITERAL__::regrole::oid,__DEPLOYMENT__,0);

CREATE FUNCTION reconciliation_jobs_v1._guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR TG_TABLE_NAME='_meta' OR NOT EXISTS(SELECT 1 FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current()) THEN RAISE EXCEPTION 'RECON_QUEUE_DIRECT_WRITE';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME IN('fences','authorities','releases','authorizations') THEN RAISE EXCEPTION 'RECON_QUEUE_IMMUTABLE';END IF;
  IF TG_TABLE_NAME='jobs' THEN
   IF OLD.status IN('COMMITTED','FAILED') THEN RAISE EXCEPTION 'RECON_QUEUE_TERMINAL';END IF;
   IF ROW(OLD.id,OLD.ordinal,OLD.tenant,OLD.case_id,OLD.operation_id,OLD.actor_id,OLD.action,OLD.request_hash,OLD.domain_hash,OLD.sealed_command,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.ordinal,NEW.tenant,NEW.case_id,NEW.operation_id,NEW.actor_id,NEW.action,NEW.request_hash,NEW.domain_hash,NEW.sealed_command,NEW.created_at) THEN RAISE EXCEPTION 'RECON_QUEUE_IMMUTABLE';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['_meta','jobs','cases','fences','authorities','releases','authorizations'] LOOP
 EXECUTE format('CREATE TRIGGER recon_write BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_jobs_v1.%I FOR EACH ROW EXECUTE FUNCTION reconciliation_jobs_v1._guard()',t);
 EXECUTE format('ALTER TABLE reconciliation_jobs_v1.%I ENABLE ALWAYS TRIGGER recon_write',t);
 EXECUTE format('CREATE TRIGGER recon_truncate BEFORE TRUNCATE ON reconciliation_jobs_v1.%I FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_jobs_v1._guard()',t);
 EXECUTE format('ALTER TABLE reconciliation_jobs_v1.%I ENABLE ALWAYS TRIGGER recon_truncate',t);
END LOOP;END $$;
CREATE FUNCTION reconciliation_jobs_v1._assert(p_tenant text,p_worker boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE m reconciliation_jobs_v1._meta;r record;e bigint;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(1229213011,1);PERFORM pg_advisory_xact_lock_shared(1229213011,2);PERFORM pg_advisory_xact_lock_shared(1229213011,17);
 LOCK TABLE reconciliation_jobs_v1._meta,reconciliation_jobs_v1._ctx,reconciliation_jobs_v1.jobs,reconciliation_jobs_v1.cases,reconciliation_jobs_v1.fences,reconciliation_jobs_v1.authorizations,reconciliation_jobs_v1.authorities,reconciliation_jobs_v1.releases IN ACCESS SHARE MODE;
 SELECT * INTO STRICT m FROM reconciliation_jobs_v1._meta;
 IF p_tenant IS DISTINCT FROM m.tenant OR current_user::regrole::oid<>m.owner_oid OR (session_user::regrole::oid<>m.worker_oid AND (p_worker OR session_user::regrole::oid<>m.ingress_oid)) THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORITY';END IF;
 FOR r IN SELECT * FROM pg_roles WHERE oid IN(m.owner_oid,m.worker_oid,m.ingress_oid) LOOP
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolcanlogin<>(r.oid<>m.owner_oid) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORITY';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE oid IN(m.owner_oid,m.worker_oid,m.ingress_oid))<>3 OR
 EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='reconciliation_jobs_v1'::regnamespace AND c.relkind='r' AND (has_table_privilege(m.worker_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege(m.ingress_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR
 has_schema_privilege(m.worker_oid,'reconciliation_jobs_v1','CREATE') OR has_schema_privilege(m.ingress_oid,'reconciliation_jobs_v1','CREATE') OR
 EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='reconciliation_jobs_v1'::regnamespace AND left(p.proname,1)='_' AND (has_function_privilege(m.worker_oid,p.oid,'EXECUTE') OR has_function_privilege(m.ingress_oid,p.oid,'EXECUTE'))) OR
 (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='reconciliation_jobs_v1'::regnamespace AND t.tgname IN('recon_write','recon_truncate') AND t.tgenabled='A')<>14 OR
 (SELECT count(*) FROM pg_event_trigger WHERE evtname IN('recon_queue_ddl_start_v1','recon_queue_ddl_end_v1','recon_queue_sql_drop_v1') AND evtenabled='A')<>3 THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORITY';END IF;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO e FROM reconciliation_jobs_v1._ddl_epoch;
 IF e<>m.epoch THEN RAISE EXCEPTION 'RECON_QUEUE_SCHEMA_EPOCH';END IF;
END $$;
CREATE FUNCTION reconciliation_jobs_v1._case_lock(p_tenant text,p_case uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('recon-case:'||p_tenant||':'||p_case::text,0)) $$;
CREATE FUNCTION reconciliation_jobs_v1._state(p_tenant text,p_ns text,p_key text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,reconciliation_jobs_v1,state_map_v1,pg_temp AS $$
DECLARE p jsonb;k bytea;BEGIN k:=sha256(decode('04','hex')||state_map_v1._frame(p_tenant)||state_map_v1._frame(p_ns)||state_map_v1._frame(p_key));p:=state_map_v1.read_proof_v1(p_tenant,k,(SELECT root_id FROM state_map_v1.head));RETURN CASE WHEN p->>'valueText' IS NULL THEN NULL ELSE (p->>'valueText')::jsonb END;END $$;
CREATE FUNCTION reconciliation_jobs_v1._public(j reconciliation_jobs_v1.jobs) RETURNS jsonb LANGUAGE sql STABLE STRICT AS $$
 SELECT jsonb_build_object('id',j.id::text,'tenantId',j.tenant,'caseId',j.case_id::text,'operationId',j.operation_id::text,'actorId',j.actor_id,'action',j.action,'requestHash',j.request_hash,'domainHash',j.domain_hash,'sealedCommand',j.sealed_command,'grantRevision',j.grant_revision::text,'status',j.status,'leaseLive',j.lease_until>clock_timestamp(),'attempts',j.attempts,'result',j.result,'errorCode',j.error_code,'publicationId',j.publication_id::text,'releaseStarted',EXISTS(SELECT 1 FROM reconciliation_jobs_v1.releases r WHERE r.job_id=j.id),'createdAt',j.created_at,'updatedAt',j.updated_at)
$$;
CREATE FUNCTION reconciliation_jobs_v1.probe_v1(p_tenant text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN PERFORM reconciliation_jobs_v1._assert(p_tenant,false);RETURN (SELECT deployment FROM reconciliation_jobs_v1._meta);END $$;
CREATE FUNCTION reconciliation_jobs_v1.enqueue_v1(p_tenant text,p_meta jsonb,p_command jsonb,p_grant jsonb,p_until timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;c uuid;op uuid;a text;
BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);
 IF p_meta IS NULL OR jsonb_typeof(p_meta)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_meta))<>7 OR p_meta->>'action' NOT IN('OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE') OR coalesce(p_meta->>'requestHash','')!~'^[a-f0-9]{64}$' OR coalesce(p_meta->>'domainHash','')!~'^[a-f0-9]{64}$' OR coalesce(octet_length(p_meta->>'actorId'),0) NOT BETWEEN 1 AND 512 OR (p_meta->>'id')::uuid IS NULL OR (p_meta->>'caseId')::uuid IS NULL OR (p_meta->>'operationId')::uuid IS NULL OR p_until IS NULL OR p_until<=clock_timestamp() OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR jsonb_typeof(p_grant) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;
 c:=(p_meta->>'caseId')::uuid;op:=(p_meta->>'operationId')::uuid;a:=p_meta->>'actorId';PERFORM reconciliation_jobs_v1._case_lock(p_tenant,c);
 SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND case_id=c AND operation_id=op;
 IF FOUND THEN IF j.actor_id IS DISTINCT FROM a OR j.action IS DISTINCT FROM p_meta->>'action' OR j.request_hash IS DISTINCT FROM p_meta->>'requestHash' OR j.domain_hash IS DISTINCT FROM p_meta->>'domainHash' THEN RAISE EXCEPTION 'RECON_QUEUE_ACTION_CONFLICT';END IF;RETURN reconciliation_jobs_v1._public(j);END IF;
 IF EXISTS(SELECT 1 FROM reconciliation_jobs_v1.fences WHERE tenant=p_tenant AND case_id=c AND operation_id=op) THEN RAISE EXCEPTION 'RECON_QUEUE_ACCEPTANCE_CLOSED';END IF;
 IF EXISTS(SELECT 1 FROM reconciliation_jobs_v1.releases WHERE tenant=p_tenant AND case_id=c) THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_STARTED';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());
 INSERT INTO reconciliation_jobs_v1.jobs(id,tenant,case_id,operation_id,actor_id,action,request_hash,domain_hash,sealed_command,sealed_grant,grant_until) VALUES((p_meta->>'id')::uuid,p_tenant,c,op,a,p_meta->>'action',p_meta->>'requestHash',p_meta->>'domainHash',p_command,p_grant,p_until) RETURNING * INTO j;
 INSERT INTO reconciliation_jobs_v1.cases(tenant,case_id) VALUES(p_tenant,c) ON CONFLICT DO NOTHING;
 DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN reconciliation_jobs_v1._public(j);
END $$;
CREATE FUNCTION reconciliation_jobs_v1.read_v1(p_tenant text,p_actor text,p_case uuid,p_operation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;BEGIN PERFORM reconciliation_jobs_v1._assert(p_tenant,false);SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND actor_id=p_actor AND case_id=p_case AND operation_id=p_operation;IF NOT FOUND THEN RETURN NULL;END IF;RETURN reconciliation_jobs_v1._public(j);END $$;
CREATE FUNCTION reconciliation_jobs_v1.close_v1(p_tenant text,p_actor text,p_case uuid,p_operation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);IF p_case IS NULL OR p_operation IS NULL OR coalesce(octet_length(p_actor),0) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;PERFORM reconciliation_jobs_v1._case_lock(p_tenant,p_case);
 SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND case_id=p_case AND operation_id=p_operation;
 IF j.id IS NOT NULL AND j.actor_id IS DISTINCT FROM p_actor OR EXISTS(SELECT 1 FROM reconciliation_jobs_v1.fences WHERE tenant=p_tenant AND case_id=p_case AND operation_id=p_operation AND actor_id<>p_actor) THEN RAISE EXCEPTION 'RECON_QUEUE_ACTION_CONFLICT';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());INSERT INTO reconciliation_jobs_v1.fences VALUES(p_tenant,p_case,p_operation,p_actor,clock_timestamp()) ON CONFLICT DO NOTHING;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
 RETURN jsonb_build_object('acceptanceClosed',true,'recoveryRequired',j.id IS NOT NULL,'caseId',p_case::text,'operationId',p_operation::text,'job',CASE WHEN j.id IS NULL THEN NULL ELSE reconciliation_jobs_v1._public(j) END);
END $$;
CREATE FUNCTION reconciliation_jobs_v1.authorize_v1(p_tenant text,p_actor text,p_case uuid,p_operation uuid,p_revision bigint,p_grant jsonb,p_until timestamptz,p_control uuid,p_session text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;a reconciliation_jobs_v1.authorizations;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);IF p_control IS NULL OR coalesce(p_session,'')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;PERFORM reconciliation_jobs_v1._case_lock(p_tenant,p_case);PERFORM pg_advisory_xact_lock(hashtextextended('recon-auth:'||p_control::text,0));SELECT * INTO a FROM reconciliation_jobs_v1.authorizations WHERE control_id=p_control;IF FOUND THEN IF a.tenant IS DISTINCT FROM p_tenant OR a.case_id IS DISTINCT FROM p_case OR a.operation_id IS DISTINCT FROM p_operation OR a.actor_id IS DISTINCT FROM p_actor OR a.expected_grant IS DISTINCT FROM p_revision OR a.session_hash IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORIZATION_CONFLICT';END IF;SELECT * INTO STRICT j FROM reconciliation_jobs_v1.jobs WHERE id=a.job_id;RETURN reconciliation_jobs_v1._public(j);END IF;SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND case_id=p_case AND operation_id=p_operation FOR UPDATE;
 IF j.id IS NULL OR j.actor_id IS DISTINCT FROM p_actor OR j.grant_revision IS DISTINCT FROM p_revision OR j.status NOT IN('ACCEPTED','RETRY','WAITING_AUTH') OR p_until IS NULL OR p_until<=clock_timestamp() OR jsonb_typeof(p_grant) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RECON_QUEUE_GRANT_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM reconciliation_jobs_v1.releases WHERE tenant=p_tenant AND case_id=p_case) THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_STARTED';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());INSERT INTO reconciliation_jobs_v1.authorizations(control_id,tenant,case_id,operation_id,actor_id,expected_grant,session_hash,job_id) VALUES(p_control,p_tenant,p_case,p_operation,p_actor,p_revision,p_session,j.id);UPDATE reconciliation_jobs_v1.jobs SET sealed_grant=p_grant,grant_until=p_until,grant_revision=grant_revision+1,status='ACCEPTED',fence=fence+1,worker_id=NULL,claim_token=NULL,lease_until=NULL,error_code=NULL,next_attempt=clock_timestamp(),updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;UPDATE reconciliation_jobs_v1.cases SET active_job=NULL WHERE tenant=p_tenant AND case_id=p_case AND active_job=j.id;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN reconciliation_jobs_v1._public(j);
END $$;
CREATE FUNCTION reconciliation_jobs_v1._lease(p_tenant text,p jsonb) RETURNS reconciliation_jobs_v1.jobs LANGUAGE plpgsql SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,true);SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE id=(p->>'id')::uuid AND tenant=p_tenant;IF NOT FOUND THEN RAISE EXCEPTION 'RECON_QUEUE_LEASE_LOST';END IF;
 PERFORM reconciliation_jobs_v1._case_lock(p_tenant,j.case_id);SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE id=j.id FOR UPDATE;
 IF j.status<>'RUNNING' OR j.worker_id IS DISTINCT FROM (p->>'owner')::uuid OR j.claim_token IS DISTINCT FROM (p->>'token')::uuid OR j.fence IS DISTINCT FROM (p->>'fence')::bigint OR j.grant_revision IS DISTINCT FROM (p->>'grantRevision')::bigint OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM reconciliation_jobs_v1.cases WHERE tenant=p_tenant AND case_id=j.case_id AND active_job=j.id) THEN RAISE EXCEPTION 'RECON_QUEUE_LEASE_LOST';END IF;RETURN j;
END $$;
CREATE FUNCTION reconciliation_jobs_v1.claim_v1(p_tenant text,p_owner uuid,p_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;c reconciliation_jobs_v1.cases;
BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,true);IF p_owner IS NULL OR p_token IS NULL THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;
 FOR j IN SELECT q.* FROM reconciliation_jobs_v1.jobs q WHERE q.tenant=p_tenant AND q.next_attempt<=clock_timestamp() AND (q.status IN('ACCEPTED','RETRY') OR q.status='RUNNING' AND q.lease_until<=clock_timestamp()) ORDER BY q.ordinal FOR UPDATE SKIP LOCKED LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('recon-case:'||p_tenant||':'||j.case_id::text,0)) THEN CONTINUE;END IF;
  SELECT * INTO c FROM reconciliation_jobs_v1.cases WHERE tenant=p_tenant AND case_id=j.case_id FOR UPDATE;
  IF c.active_job IS NOT NULL AND c.active_job<>j.id OR c.releasing_job IS NOT NULL AND c.releasing_job<>j.id THEN CONTINUE;END IF;
  INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());UPDATE reconciliation_jobs_v1.jobs SET status='RUNNING',worker_id=p_owner,claim_token=p_token,fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;UPDATE reconciliation_jobs_v1.cases SET active_job=j.id WHERE tenant=p_tenant AND case_id=j.case_id;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
  RETURN reconciliation_jobs_v1._public(j)||jsonb_build_object('owner',p_owner::text,'token',p_token::text,'fence',j.fence::text,'sealedGrant',j.sealed_grant,'grantUntil',j.grant_until,'leaseUntil',j.lease_until);
 END LOOP;RETURN NULL;
END $$;
CREATE FUNCTION reconciliation_jobs_v1.renew_v1(p_tenant text,p jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;BEGIN j:=reconciliation_jobs_v1._lease(p_tenant,p);INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());UPDATE reconciliation_jobs_v1.jobs SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=j.id;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;END $$;
CREATE FUNCTION reconciliation_jobs_v1.check_v1(p_tenant text,p jsonb,p_deadline timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;BEGIN j:=reconciliation_jobs_v1._lease(p_tenant,p);IF p_deadline IS NULL OR p_deadline<=clock_timestamp() OR j.grant_until<=clock_timestamp() THEN RAISE EXCEPTION 'RECON_QUEUE_AUTH_EXPIRED';END IF;RETURN true;END $$;
CREATE FUNCTION reconciliation_jobs_v1.defer_v1(p_tenant text,p jsonb,p_mode text,p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;started boolean;BEGIN
 j:=reconciliation_jobs_v1._lease(p_tenant,p);IF p_mode NOT IN('WAITING_AUTH','RETRY','FAILED') OR coalesce(p_code,'')!~'^[A-Z0-9_]{1,80}$' THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;started:=EXISTS(SELECT 1 FROM reconciliation_jobs_v1.releases WHERE job_id=j.id);
 IF started AND p_mode<>'RETRY' THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_RECOVERY_REQUIRED';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());UPDATE reconciliation_jobs_v1.jobs SET status=p_mode,error_code=p_code,attempts=attempts+1,worker_id=NULL,claim_token=NULL,lease_until=NULL,next_attempt=clock_timestamp()+interval '1 second',updated_at=clock_timestamp() WHERE id=j.id;UPDATE reconciliation_jobs_v1.cases SET active_job=NULL WHERE tenant=p_tenant AND case_id=j.case_id;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;
END $$;
CREATE FUNCTION reconciliation_jobs_v1.authority_v1(p_tenant text,p jsonb,p_review uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;a reconciliation_jobs_v1.authorities;BEGIN j:=reconciliation_jobs_v1._lease(p_tenant,p);SELECT * INTO a FROM reconciliation_jobs_v1.authorities WHERE tenant=p_tenant AND case_id=j.case_id AND operation_id=p_review;IF NOT FOUND THEN RETURN NULL;END IF;RETURN jsonb_build_object('jobId',a.job_id::text,'actorId',a.actor_id,'sessionHash',a.session_hash,'operationId',a.operation_id::text,'grantRevision',a.grant_revision::text,'sealedGrant',a.sealed_grant,'grantUntil',a.grant_until);END $$;
CREATE FUNCTION reconciliation_jobs_v1.start_release_v1(p_tenant text,p jsonb,p_deadline timestamptz,p_revision text,p_auth jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,state_map_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;c jsonb;r jsonb;old reconciliation_jobs_v1.releases;a reconciliation_jobs_v1.authorities;
BEGIN
 j:=reconciliation_jobs_v1._lease(p_tenant,p);SELECT * INTO old FROM reconciliation_jobs_v1.releases WHERE tenant=p_tenant AND case_id=j.case_id;
 IF FOUND THEN IF old.job_id<>j.id THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_STARTED';END IF;RETURN to_jsonb(old);END IF;
 PERFORM reconciliation_jobs_v1.check_v1(p_tenant,p,p_deadline);PERFORM state_map_v1.read_head_v1(p_tenant);
 c:=reconciliation_jobs_v1._state(p_tenant,'predictive_cancel_case',j.case_id::text);r:=reconciliation_jobs_v1._state(p_tenant,'receipt','predictive_cancel_publish:'||j.case_id::text);
 SELECT * INTO a FROM reconciliation_jobs_v1.authorities WHERE tenant=p_tenant AND case_id=j.case_id AND operation_id=(c->'review'->>'operationId')::uuid;
 IF j.action<>'SETTLE' OR c->>'status' IS DISTINCT FROM 'RELEASE_PENDING' OR c->>'revision' IS DISTINCT FROM p_revision OR c->>'originalActorId' IS DISTINCT FROM j.actor_id OR c->'confirmation' IS NULL OR c->'confirmation'='null'::jsonb OR c->'review'->>'decision' IS DISTINCT FROM 'APPROVE' OR a.job_id IS NULL OR c->'review'->>'actorId' IS DISTINCT FROM a.actor_id OR c->'review'->>'sessionHash' IS DISTINCT FROM a.session_hash OR r->>'caseId' IS DISTINCT FROM j.case_id::text OR r->>'releaseDigest' IS DISTINCT FROM c->>'releaseDigest' OR coalesce(r->>'releaseDigest','')!~'^[a-f0-9]{64}$' OR r->>'orderId' IS DISTINCT FROM c->>'orderId' OR jsonb_typeof(p_auth) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_auth))<>4 OR p_auth->>'actorId' IS DISTINCT FROM j.actor_id OR p_auth->>'reviewerId' IS DISTINCT FROM a.actor_id OR p_auth->>'reviewSessionHash' IS DISTINCT FROM a.session_hash OR coalesce(p_auth->>'sessionHash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_PROOF';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());INSERT INTO reconciliation_jobs_v1.releases(tenant,case_id,job_id,operation_id,case_snapshot,publication,auth_witness) VALUES(p_tenant,j.case_id,j.id,j.operation_id,c,r,p_auth) RETURNING * INTO old;UPDATE reconciliation_jobs_v1.cases SET releasing_job=j.id WHERE tenant=p_tenant AND case_id=j.case_id;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN to_jsonb(old);
END $$;
CREATE FUNCTION reconciliation_jobs_v1.release_intent_v1(p_tenant text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;r reconciliation_jobs_v1.releases;BEGIN j:=reconciliation_jobs_v1._lease(p_tenant,p);SELECT * INTO r FROM reconciliation_jobs_v1.releases WHERE job_id=j.id;IF NOT FOUND THEN RETURN NULL;END IF;RETURN to_jsonb(r);END $$;
CREATE FUNCTION reconciliation_jobs_v1.publish_v1(p_tenant text,p jsonb,p_deadline timestamptz,p_command uuid,p_revision bigint,p_root bytea,p_operations jsonb,p_session_hash text,p_recovery boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,state_map_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;b jsonb;c jsonb;rec jsonb;event jsonb;ord jsonb;tip jsonb;r jsonb;intent reconciliation_jobs_v1.releases;receipt_key text;
BEGIN
 j:=reconciliation_jobs_v1._lease(p_tenant,p);IF p_recovery IS NULL THEN RAISE EXCEPTION 'RECON_QUEUE_INPUT';END IF;
 IF j.action='SETTLE' THEN SELECT * INTO STRICT intent FROM reconciliation_jobs_v1.releases WHERE job_id=j.id;END IF;
 IF p_recovery THEN SELECT * INTO STRICT intent FROM reconciliation_jobs_v1.releases WHERE job_id=j.id;IF j.action<>'SETTLE' THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_PROOF';END IF;ELSE PERFORM reconciliation_jobs_v1.check_v1(p_tenant,p,p_deadline);END IF;
 IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_operations) NOT BETWEEN 5 AND 64 OR coalesce(p_session_hash,'')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECON_QUEUE_OPERATIONS';END IF;
 receipt_key:=CASE WHEN p_recovery THEN 'predictive_cancel_recovered:' ELSE 'predictive_cancel_action:' END||j.case_id::text||':'||j.operation_id::text;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_operations) o WHERE (
  o->>'namespace' IN('audit','audit_order') OR o->>'namespace'='domain_head' AND o->>'key'='audit' OR
  o->>'namespace'='predictive_cancel_case' AND o->>'key'=j.case_id::text OR
  o->>'namespace'='receipt' AND (o->>'key'=receipt_key OR NOT p_recovery AND j.action='CONFIRM' AND o->>'key'='predictive_cancel_publish:'||j.case_id::text) OR
  NOT p_recovery AND j.action='OPEN' AND o->>'namespace'='predictive_cancel_index' OR
  NOT p_recovery AND j.action IN('OPEN','CONFIRM') AND o->>'namespace'='predictive_intent' OR
  NOT p_recovery AND j.action='CONFIRM' AND o->>'namespace' IN('v4_entity','v4_order','v4_collection','maintenance_link','blob')
 ) IS NOT TRUE) OR (SELECT count(*) FROM jsonb_array_elements(p_operations) o WHERE o->>'namespace'='predictive_cancel_case')<>1 THEN RAISE EXCEPTION 'RECON_QUEUE_OPERATIONS';END IF;
 b:=reconciliation_jobs_v1._state(p_tenant,'predictive_cancel_case',j.case_id::text);tip:=reconciliation_jobs_v1._state(p_tenant,'domain_head','audit');
 r:=state_map_v1.apply_delta_v1(p_tenant,p_command,p_revision,p_root,p_operations);PERFORM reconciliation_jobs_v1._lease(p_tenant,p);
 IF NOT p_recovery THEN PERFORM reconciliation_jobs_v1.check_v1(p_tenant,p,p_deadline);END IF;
 c:=reconciliation_jobs_v1._state(p_tenant,'predictive_cancel_case',j.case_id::text);rec:=reconciliation_jobs_v1._state(p_tenant,'receipt',receipt_key);
 IF c->>'format' IS DISTINCT FROM 'IDMS_PREDICTIVE_CANCEL_RECONCILIATION_V1' OR c->>'tenantId' IS DISTINCT FROM p_tenant OR c->>'id' IS DISTINCT FROM j.case_id::text OR rec->>'caseId' IS DISTINCT FROM j.case_id::text OR rec->>'operationId' IS DISTINCT FROM j.operation_id::text OR rec->>'requestHash' IS DISTINCT FROM j.domain_hash OR rec->>'resultRevision' IS DISTINCT FROM c->>'revision' OR rec->>'kind' IS DISTINCT FROM (CASE WHEN p_recovery THEN 'RELEASE_RECOVERY' ELSE j.action END) OR rec->>'actorId' IS DISTINCT FROM (CASE WHEN p_recovery THEN 'idms.reconciliation-worker-v1' ELSE j.actor_id END) THEN RAISE EXCEPTION 'RECON_QUEUE_DOMAIN_RECEIPT';END IF;
 event:=reconciliation_jobs_v1._state(p_tenant,'audit',rec->>'auditEventId');ord:=reconciliation_jobs_v1._state(p_tenant,'audit_order',lpad(rec->>'auditPosition',20,'0'));
 IF event->>'hash' IS DISTINCT FROM rec->>'auditHash' OR event->>'eventId' IS DISTINCT FROM ord->>'eventId' OR ord->>'tenantId' IS DISTINCT FROM p_tenant OR event->>'actorType' IS DISTINCT FROM (CASE WHEN p_recovery THEN 'SYSTEM' ELSE 'USER' END) OR event->>'actorId' IS DISTINCT FROM rec->>'actorId' OR event->>'action' IS DISTINCT FROM ('PREDICTIVE_CANCEL_'||(CASE WHEN p_recovery THEN 'RELEASE_RECOVERY' ELSE j.action END)) OR event->'metadata'->>'requestHash' IS DISTINCT FROM j.domain_hash OR event->'metadata'->>'caseId' IS DISTINCT FROM j.case_id::text OR event->'metadata'->>'operationId' IS DISTINCT FROM j.operation_id::text OR (rec->>'auditPosition')::bigint<=(tip->>'count')::bigint THEN RAISE EXCEPTION 'RECON_QUEUE_AUDIT_PROOF';END IF;
 IF p_recovery AND ((c-ARRAY['status','revision']) IS DISTINCT FROM (intent.case_snapshot-ARRAY['status','revision']) OR b IS DISTINCT FROM intent.case_snapshot OR c->>'status' IS DISTINCT FROM 'RESOLVED_LINKED' OR (c->>'revision')::bigint<>(b->>'revision')::bigint+1 OR jsonb_array_length(p_operations)<>5) THEN RAISE EXCEPTION 'RECON_QUEUE_RELEASE_PROOF';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());
 IF j.action='REVIEW' THEN
  IF c->'review'->>'actorId' IS DISTINCT FROM j.actor_id OR c->'review'->>'operationId' IS DISTINCT FROM j.operation_id::text OR c->'review'->>'sessionHash' IS DISTINCT FROM p_session_hash THEN RAISE EXCEPTION 'RECON_QUEUE_REVIEW_PROOF';END IF;
  INSERT INTO reconciliation_jobs_v1.authorities VALUES(p_tenant,j.case_id,j.operation_id,j.actor_id,p_session_hash,j.sealed_grant,j.grant_revision,j.grant_until,j.id);
 END IF;
 UPDATE reconciliation_jobs_v1.jobs SET status='COMMITTED',result=c,publication_id=p_command,error_code=NULL,worker_id=NULL,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=j.id;UPDATE reconciliation_jobs_v1.cases SET active_job=NULL WHERE tenant=p_tenant AND case_id=j.case_id;
 IF j.action='REVIEW' THEN UPDATE reconciliation_jobs_v1.jobs SET status='FAILED',error_code='RECON_QUEUE_REVIEW_SUPERSEDED',worker_id=NULL,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant=p_tenant AND case_id=j.case_id AND id<>j.id AND status='WAITING_AUTH' AND action IN('CONFIRM','SETTLE');END IF;
 IF j.action='SETTLE' THEN UPDATE reconciliation_jobs_v1.jobs SET status='FAILED',error_code='RECON_QUEUE_RELEASE_STARTED',worker_id=NULL,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant=p_tenant AND case_id=j.case_id AND id<>j.id AND status NOT IN('COMMITTED','FAILED');END IF;
 DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN r;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA reconciliation_jobs_v1 FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reconciliation_jobs_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reconciliation_jobs_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA reconciliation_jobs_v1 TO __WORKER__,__INGRESS__;
GRANT EXECUTE ON FUNCTION reconciliation_jobs_v1.probe_v1(text),reconciliation_jobs_v1.read_v1(text,text,uuid,uuid) TO __WORKER__,__INGRESS__;
GRANT EXECUTE ON FUNCTION reconciliation_jobs_v1.enqueue_v1(text,jsonb,jsonb,jsonb,timestamptz),reconciliation_jobs_v1.close_v1(text,text,uuid,uuid),reconciliation_jobs_v1.authorize_v1(text,text,uuid,uuid,bigint,jsonb,timestamptz,uuid,text) TO __INGRESS__;
GRANT EXECUTE ON FUNCTION reconciliation_jobs_v1.claim_v1(text,uuid,uuid),reconciliation_jobs_v1.renew_v1(text,jsonb),reconciliation_jobs_v1.check_v1(text,jsonb,timestamptz),reconciliation_jobs_v1.defer_v1(text,jsonb,text,text),reconciliation_jobs_v1.authority_v1(text,jsonb,uuid),reconciliation_jobs_v1.start_release_v1(text,jsonb,timestamptz,text,jsonb),reconciliation_jobs_v1.release_intent_v1(text,jsonb),reconciliation_jobs_v1.publish_v1(text,jsonb,timestamptz,uuid,bigint,bytea,jsonb,text,boolean) TO __WORKER__;
RESET ROLE;
CREATE FUNCTION reconciliation_jobs_v1._ddl_start() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN PERFORM pg_advisory_xact_lock(1229213011,1);PERFORM pg_advisory_xact_lock(1229213011,2);PERFORM pg_advisory_xact_lock(1229213011,17);END $$;
CREATE FUNCTION reconciliation_jobs_v1._ddl_end() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE schema_name='reconciliation_jobs_v1') THEN PERFORM nextval('reconciliation_jobs_v1._ddl_epoch');END IF;END $$;
CREATE FUNCTION reconciliation_jobs_v1._sql_drop() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_dropped_objects() WHERE schema_name='reconciliation_jobs_v1') THEN PERFORM nextval('reconciliation_jobs_v1._ddl_epoch');END IF;END $$;
ALTER FUNCTION reconciliation_jobs_v1._ddl_start() OWNER TO __OWNER__;
ALTER FUNCTION reconciliation_jobs_v1._ddl_end() OWNER TO __OWNER__;
ALTER FUNCTION reconciliation_jobs_v1._sql_drop() OWNER TO __OWNER__;
REVOKE ALL ON FUNCTION reconciliation_jobs_v1._ddl_start(),reconciliation_jobs_v1._ddl_end(),reconciliation_jobs_v1._sql_drop() FROM PUBLIC;
CREATE EVENT TRIGGER recon_queue_ddl_start_v1 ON ddl_command_start EXECUTE FUNCTION reconciliation_jobs_v1._ddl_start();
CREATE EVENT TRIGGER recon_queue_ddl_end_v1 ON ddl_command_end EXECUTE FUNCTION reconciliation_jobs_v1._ddl_end();
CREATE EVENT TRIGGER recon_queue_sql_drop_v1 ON sql_drop EXECUTE FUNCTION reconciliation_jobs_v1._sql_drop();
ALTER EVENT TRIGGER recon_queue_ddl_start_v1 ENABLE ALWAYS;
ALTER EVENT TRIGGER recon_queue_ddl_end_v1 ENABLE ALWAYS;
ALTER EVENT TRIGGER recon_queue_sql_drop_v1 ENABLE ALWAYS;
