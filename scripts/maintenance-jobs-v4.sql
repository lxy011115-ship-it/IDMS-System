SET ROLE __OWNER__;
CREATE TABLE maintenance_jobs_v4.flows(command_id uuid PRIMARY KEY,tenant text NOT NULL,actor_id text NOT NULL,job_id uuid NOT NULL REFERENCES maintenance_jobs_v4.jobs(id),sealed_grant jsonb NOT NULL,grant_revision bigint NOT NULL CHECK(grant_revision>0),grant_until timestamptz NOT NULL,waiting_auth boolean NOT NULL DEFAULT false,next_attempt timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION maintenance_jobs_v4._flow_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR NOT EXISTS(SELECT 1 FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current()) THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_DIRECT_WRITE';END IF;
 IF TG_OP='UPDATE' AND ROW(OLD.command_id,OLD.tenant,OLD.actor_id,OLD.job_id) IS DISTINCT FROM ROW(NEW.command_id,NEW.tenant,NEW.actor_id,NEW.job_id) THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER maintenance_flow_write BEFORE INSERT OR UPDATE OR DELETE ON maintenance_jobs_v4.flows FOR EACH ROW EXECUTE FUNCTION maintenance_jobs_v4._flow_guard();
CREATE TRIGGER maintenance_flow_truncate BEFORE TRUNCATE ON maintenance_jobs_v4.flows FOR EACH STATEMENT EXECUTE FUNCTION maintenance_jobs_v4._flow_guard();
ALTER TABLE maintenance_jobs_v4.flows ENABLE ALWAYS TRIGGER maintenance_flow_write;
ALTER TABLE maintenance_jobs_v4.flows ENABLE ALWAYS TRIGGER maintenance_flow_truncate;
CREATE FUNCTION maintenance_jobs_v4._flow_assert(tenant text,worker boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM maintenance_jobs_v4._assert(tenant,worker);IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='maintenance_jobs_v4.flows'::regclass AND tgname IN('maintenance_flow_write','maintenance_flow_truncate') AND tgenabled='A')<>2 THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_PROTECTION';END IF;END $$;
CREATE OR REPLACE FUNCTION maintenance_jobs_v4.finish_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j maintenance_jobs_v4.jobs;r jsonb;a jsonb;o jsonb;f jsonb;engine_id uuid;
BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);j:=maintenance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);PERFORM maintenance_jobs_v4._flow_assert(tenant,true);
 IF j.auth_deadline IS NULL OR j.auth_deadline<=clock_timestamp() OR j.grant_until<=clock_timestamp() THEN RAISE EXCEPTION 'MAINTENANCE_QUEUE_AUTH_EXPIRED';END IF;
 r:=maintenance_jobs_v4._state(tenant,'receipt','maintenance:'||j.business_key)->'value';
 IF r IS NULL OR r='null'::jsonb OR r->>'format' IS DISTINCT FROM 'IDMS_MAINTENANCE_MAP_V4_1' OR r->>'requestHash' IS DISTINCT FROM j.request_hash OR r->'result'->>'id' IS DISTINCT FROM r->>'orderId' THEN RAISE EXCEPTION 'MAINTENANCE_QUEUE_BUSINESS_INTEGRITY';END IF;
 a:=maintenance_jobs_v4._state(tenant,'audit',r->>'auditEventId')->'value';o:=maintenance_jobs_v4._state(tenant,'audit_order',lpad(r->>'auditPosition',20,'0'))->'value';
 IF a->>'tenantId' IS DISTINCT FROM tenant OR a->>'objectType' IS DISTINCT FROM 'WORK_ORDER' OR a->>'objectId' IS DISTINCT FROM r->>'orderId' OR a->>'hash' IS DISTINCT FROM r->>'auditHash' OR a->>'eventId' IS DISTINCT FROM o->>'eventId' OR a->>'actorId' IS DISTINCT FROM j.actor_id THEN RAISE EXCEPTION 'MAINTENANCE_QUEUE_AUDIT_BINDING';END IF;
 INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 IF r->'result'->'workflow'->>'status'='PENDING' AND j.action<>'workflow/retry' THEN
  engine_id:=(r->'result'->'workflow'->>'commandId')::uuid;f:=maintenance_jobs_v4._state(tenant,'maintenance_job',engine_id::text)->'value';
  IF f->>'format' IS DISTINCT FROM 'IDMS_MAINTENANCE_MAP_V4_1' OR f->>'tenantId' IS DISTINCT FROM tenant OR f->>'orderId' IS DISTINCT FROM r->>'orderId' OR f->'context'->>'actorId' IS DISTINCT FROM j.actor_id OR f->'envelope'->>'action' IS DISTINCT FROM j.action THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_ENQUEUE_BINDING';END IF;
  INSERT INTO maintenance_jobs_v4.flows(command_id,tenant,actor_id,job_id,sealed_grant,grant_revision,grant_until) VALUES(engine_id,tenant,j.actor_id,j.id,j.sealed_grant,j.grant_revision,j.grant_until);
 END IF;
 IF j.action='workflow/retry' THEN UPDATE maintenance_jobs_v4.flows SET next_attempt=clock_timestamp() WHERE command_id=(r->'result'->'workflow'->>'commandId')::uuid AND flows.tenant=finish_v4.tenant;IF NOT FOUND THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_AUTH_MISSING';END IF;END IF;
 UPDATE maintenance_jobs_v4.jobs SET status='COMMITTED',result=r->'result',error_code=NULL,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;
 DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN maintenance_jobs_v4._public(j);
END $$;
CREATE OR REPLACE FUNCTION maintenance_jobs_v4.prepare_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,command uuid,revision bigint,root bytea,operations jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE r jsonb;j jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM maintenance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=maintenance_jobs_v4._public(maintenance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision));IF (j->>'cancelRequested')::boolean THEN RAISE EXCEPTION 'MAINTENANCE_QUEUE_CANCEL_PENDING';END IF;
 r:=state_map_v1.apply_delta_v1(tenant,command,revision,root,operations);PERFORM maintenance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);RETURN r;
END $$;
CREATE OR REPLACE FUNCTION maintenance_jobs_v4.cancel_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,cancel_command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j maintenance_jobs_v4.jobs;r jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM maintenance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=maintenance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);IF NOT j.cancel_requested THEN RAISE EXCEPTION 'MAINTENANCE_CANCEL_NOT_REQUESTED';END IF;
 r:=maintenance_jobs_v4._state(tenant,'receipt','maintenance:'||j.business_key)->'value';IF r IS NOT NULL AND r<>'null'::jsonb THEN RETURN maintenance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);END IF;
 INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE maintenance_jobs_v4.jobs SET status='CANCELLED',result=NULL,error_code='CANCELLED',worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN maintenance_jobs_v4._public(j);
END $$;
CREATE FUNCTION maintenance_jobs_v4.fail_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,error jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j maintenance_jobs_v4.jobs;r jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM maintenance_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=maintenance_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);r:=maintenance_jobs_v4._state(tenant,'receipt','maintenance:'||j.business_key)->'value';IF r IS NOT NULL AND r<>'null'::jsonb THEN RETURN maintenance_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);END IF;
 IF (error->>'status')::integer NOT IN(400,404,409,413) OR jsonb_typeof(error->'message')<>'string' OR octet_length(error->>'message')>1000 THEN RAISE EXCEPTION 'MAINTENANCE_FAILURE_INPUT';END IF;
 INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE maintenance_jobs_v4.jobs SET status='FAILED',result=error,error_code='MAINTENANCE_REJECTED',worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN maintenance_jobs_v4._public(j);
END $$;
CREATE FUNCTION maintenance_jobs_v4.flow_read_v4(tenant text,actor text,command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,pg_temp AS $$
DECLARE f maintenance_jobs_v4.flows;j maintenance_jobs_v4.jobs;m maintenance_jobs_v4._meta;BEGIN
 PERFORM maintenance_jobs_v4._flow_assert(tenant,false);SELECT * INTO STRICT m FROM maintenance_jobs_v4._meta;SELECT * INTO f FROM maintenance_jobs_v4.flows q WHERE q.tenant=flow_read_v4.tenant AND q.command_id=command AND (session_user::regrole::oid=m.worker_oid OR q.actor_id=actor);IF NOT FOUND THEN RETURN NULL;END IF;SELECT * INTO STRICT j FROM maintenance_jobs_v4.jobs WHERE id=f.job_id;
 RETURN jsonb_build_object('commandId',f.command_id,'actorId',f.actor_id,'revision',f.grant_revision::text,'grantUntil',f.grant_until,'waitingAuth',f.waiting_auth,'ready',f.next_attempt<=clock_timestamp(),'sealedGrant',f.sealed_grant,'job',maintenance_jobs_v4._public(j));END $$;
CREATE FUNCTION maintenance_jobs_v4.flow_authorize_v4(tenant text,actor text,command uuid,expected bigint,sealed jsonb,until_time timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,pg_temp AS $$
DECLARE f maintenance_jobs_v4.flows;BEGIN
 PERFORM maintenance_jobs_v4._flow_assert(tenant,false);SELECT * INTO STRICT f FROM maintenance_jobs_v4.flows q WHERE q.tenant=flow_authorize_v4.tenant AND q.command_id=command AND q.actor_id=actor FOR UPDATE;
 IF f.grant_revision<>expected OR sealed IS NULL OR jsonb_typeof(sealed)<>'object' OR octet_length(sealed::text)>65536 OR until_time<=clock_timestamp() THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_GRANT_CONFLICT';END IF;
 INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE maintenance_jobs_v4.flows SET sealed_grant=sealed,grant_revision=f.grant_revision+1,grant_until=until_time,waiting_auth=false,next_attempt=clock_timestamp() WHERE command_id=command;DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;
END $$;
CREATE FUNCTION maintenance_jobs_v4.flow_defer_v4(tenant text,command uuid,expected bigint,waiting boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,pg_temp AS $$ DECLARE changed boolean;BEGIN
 PERFORM maintenance_jobs_v4._flow_assert(tenant,true);IF waiting IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_DEFER_INPUT';END IF;INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE maintenance_jobs_v4.flows SET waiting_auth=waiting,next_attempt=clock_timestamp()+interval '1 second' WHERE flows.tenant=flow_defer_v4.tenant AND command_id=command AND grant_revision=expected;changed:=FOUND;DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN changed;END $$;
CREATE FUNCTION maintenance_jobs_v4.flow_apply_v4(tenant text,engine_command uuid,expected bigint,deadline timestamptz,command uuid,revision bigint,root bytea,operations jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,maintenance_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE f maintenance_jobs_v4.flows;r jsonb;body jsonb;delay integer;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM maintenance_jobs_v4._flow_assert(tenant,true);SELECT * INTO STRICT f FROM maintenance_jobs_v4.flows q WHERE q.tenant=flow_apply_v4.tenant AND q.command_id=engine_command FOR UPDATE;
 IF f.grant_revision<>expected OR deadline IS NULL OR deadline<=clock_timestamp() OR f.grant_until<=clock_timestamp() OR f.waiting_auth THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_AUTH_CHANGED';END IF;
 r:=state_map_v1.apply_delta_v1(tenant,command,revision,root,operations);body:=maintenance_jobs_v4._state(tenant,'maintenance_job',engine_command::text)->'value';
 IF body->>'format' IS DISTINCT FROM 'IDMS_MAINTENANCE_MAP_V4_1' OR body->>'commandId' IS DISTINCT FROM engine_command::text OR body->'context'->>'actorId' IS DISTINCT FROM f.actor_id THEN RAISE EXCEPTION 'MAINTENANCE_FLOW_APPLY_BINDING';END IF;
 delay:=CASE WHEN body->>'status'='PENDING' THEN least(60,power(2,least(6,greatest(0,(body->>'networkFailures')::integer-1)))::integer) ELSE 0 END;
 INSERT INTO maintenance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE maintenance_jobs_v4.flows SET next_attempt=clock_timestamp()+delay*interval '1 second' WHERE command_id=engine_command;DELETE FROM maintenance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN r;
END $$;
REVOKE ALL ON TABLE maintenance_jobs_v4.flows FROM PUBLIC;
REVOKE ALL ON FUNCTION maintenance_jobs_v4._flow_guard(),maintenance_jobs_v4._flow_assert(text,boolean),maintenance_jobs_v4.fail_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,jsonb),maintenance_jobs_v4.flow_read_v4(text,text,uuid),maintenance_jobs_v4.flow_authorize_v4(text,text,uuid,bigint,jsonb,timestamptz),maintenance_jobs_v4.flow_defer_v4(text,uuid,bigint,boolean),maintenance_jobs_v4.flow_apply_v4(text,uuid,bigint,timestamptz,uuid,bigint,bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_jobs_v4.fail_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,jsonb),maintenance_jobs_v4.flow_read_v4(text,text,uuid),maintenance_jobs_v4.flow_defer_v4(text,uuid,bigint,boolean),maintenance_jobs_v4.flow_apply_v4(text,uuid,bigint,timestamptz,uuid,bigint,bytea,jsonb) TO __WORKER__;
GRANT EXECUTE ON FUNCTION maintenance_jobs_v4.flow_read_v4(text,text,uuid),maintenance_jobs_v4.flow_authorize_v4(text,text,uuid,bigint,jsonb,timestamptz) TO __INGRESS__;
REVOKE EXECUTE ON FUNCTION maintenance_jobs_v4.publish_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) FROM __WORKER__;
RESET ROLE;
