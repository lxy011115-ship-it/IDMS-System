-- Fresh deployment extension, inserted before the namespace DDL witnesses are armed.
SET ROLE __OWNER__;
ALTER TABLE predictive_jobs_v4.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE predictive_jobs_v4.jobs ADD CONSTRAINT jobs_status_check CHECK(status IN('ACCEPTED','RUNNING','WAITING_AUTH','RETRY','HUMAN_REVIEW','FAILED','COMMITTED','CANCELLED'));
ALTER TABLE predictive_jobs_v4.jobs ADD COLUMN external_started boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION predictive_jobs_v4._write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR TG_TABLE_NAME='_meta' OR NOT EXISTS(SELECT 1 FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current()) THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_DIRECT_WRITE';END IF;
 IF TG_OP='UPDATE' AND (ROW(OLD.id,OLD.ordinal,OLD.tenant,OLD.actor_id,OLD.command_id,OLD.action,OLD.request_hash,OLD.business_key,OLD.sealed_command,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.ordinal,NEW.tenant,NEW.actor_id,NEW.command_id,NEW.action,NEW.request_hash,NEW.business_key,NEW.sealed_command,NEW.created_at) OR OLD.external_started AND NOT NEW.external_started) THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_IMMUTABLE';END IF;
 IF TG_OP='UPDATE' AND OLD.status IN('COMMITTED','FAILED','CANCELLED') THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_TERMINAL';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4._public(j predictive_jobs_v4.jobs) RETURNS jsonb LANGUAGE sql STABLE STRICT AS $$
 SELECT jsonb_build_object('id',j.id::text,'tenantId',j.tenant,'actorId',j.actor_id,'commandId',j.command_id::text,'action',j.action,'requestHash',j.request_hash,'businessKey',j.business_key,'sealedCommand',j.sealed_command,'grantRevision',j.grant_revision::text,'status',j.status,'leaseLive',j.lease_until>clock_timestamp(),'cancelRequested',j.cancel_requested,'externalStarted',j.external_started,'attempts',j.attempts,'result',j.result,'errorCode',j.error_code,'publicationId',j.publication_id::text,'createdAt',j.created_at,'updatedAt',j.updated_at)
$$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4.claim_v4(tenant text,owner uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;BEGIN
 PERFORM predictive_jobs_v4._assert(tenant,true);IF owner IS NULL OR token IS NULL THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_INPUT';END IF;
 SELECT * INTO j FROM predictive_jobs_v4.jobs q WHERE q.tenant=claim_v4.tenant AND q.next_attempt<=clock_timestamp() AND (q.status IN('ACCEPTED','RETRY') OR q.status='RUNNING' AND q.lease_until<=clock_timestamp()) ORDER BY q.ordinal LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL;END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE predictive_jobs_v4.jobs SET status='RUNNING',worker_id=owner,claim_token=token,fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
 RETURN predictive_jobs_v4._public(j)||jsonb_build_object('sealedGrant',j.sealed_grant,'grantUntil',j.grant_until,'owner',j.worker_id::text,'token',j.claim_token::text,'fence',j.fence::text,'leaseUntil',j.lease_until);
END $$;
-- Check the native SDK job and completion together, never a queue flag alone.
CREATE FUNCTION predictive_jobs_v4._sdk(j predictive_jobs_v4.jobs) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b jsonb;BEGIN
 b:=predictive_jobs_v4._state(j.tenant,'predictive_job',j.business_key)->'value';
 IF b IS NULL OR b='null'::jsonb OR b->>'format' IS DISTINCT FROM 'IDMS_PREDICTIVE_MAP_V4_1' OR b->>'tenantId' IS DISTINCT FROM j.tenant OR b->>'key' IS DISTINCT FROM j.business_key OR b->>'commandId' IS DISTINCT FROM j.command_id::text OR b->>'actorId' IS DISTINCT FROM j.actor_id OR b->'context'->>'tenantId' IS DISTINCT FROM j.tenant OR b->'context'->>'actorId' IS DISTINCT FROM j.actor_id OR b->'context'->>'actorType' IS DISTINCT FROM 'USER' OR b->>'action' IS DISTINCT FROM j.action OR b->>'requestHash' IS DISTINCT FROM j.request_hash OR NOT coalesce(b->>'status' IN('PENDING','WAITING_AUTH','HUMAN_REVIEW','COMMITTED'),false) OR coalesce(b->>'planDigest','')!~'^[a-f0-9]{64}$' OR coalesce(b->>'grantRevision','')!~'^[1-9][0-9]*$' THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_SDK_BINDING';END IF;
 RETURN b;
END $$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4.finish_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;b jsonb;r jsonb;a jsonb;o jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);j:=predictive_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF j.auth_deadline IS NULL OR j.auth_deadline<=clock_timestamp() OR j.grant_until<=clock_timestamp() THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_AUTH_EXPIRED';END IF;
 b:=predictive_jobs_v4._sdk(j);r:=predictive_jobs_v4._state(tenant,'receipt','predictive:'||j.business_key)->'value';
 IF b->>'status' IS DISTINCT FROM 'COMMITTED' OR r IS NULL OR r='null'::jsonb OR r->>'format' IS DISTINCT FROM 'IDMS_PREDICTIVE_MAP_V4_1' OR r->>'tenantId' IS DISTINCT FROM tenant OR r->>'key' IS DISTINCT FROM j.business_key OR r->>'requestHash' IS DISTINCT FROM j.request_hash OR r->>'planDigest' IS DISTINCT FROM b->>'planDigest' OR r->'result' IS DISTINCT FROM b->'result' THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_COMPLETION_REQUIRED';END IF;
 IF j.action='REVIEW' AND r->'result'->>'status'='WORK_ORDER_CREATED' AND NOT j.external_started THEN RAISE EXCEPTION 'PREDICTIVE_EXTERNAL_START_REQUIRED';END IF;
 a:=predictive_jobs_v4._state(tenant,'audit',r->>'auditEventId')->'value';o:=predictive_jobs_v4._state(tenant,'audit_order',lpad(r->>'auditPosition',20,'0'))->'value';
 IF a->>'tenantId' IS DISTINCT FROM tenant OR o->>'tenantId' IS DISTINCT FROM tenant OR a->>'eventId' IS DISTINCT FROM r->>'auditEventId' OR a->>'hash' IS DISTINCT FROM r->>'auditHash' OR a->>'eventId' IS DISTINCT FROM o->>'eventId' OR a->'metadata'->>'commandId' IS DISTINCT FROM j.command_id::text OR a->'metadata'->>'jobKey' IS DISTINCT FROM j.business_key OR (a->>'actorId' IS DISTINCT FROM j.actor_id AND a->'metadata'->>'requestedBy' IS DISTINCT FROM j.actor_id) THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_COMPLETION_AUDIT';END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE predictive_jobs_v4.jobs SET status='COMMITTED',result=r->'result',error_code=NULL,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;
 DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN predictive_jobs_v4._public(j);
END $$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4.prepare_console_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,command uuid,revision bigint,root bytea,operations jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;r jsonb;b jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM predictive_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=predictive_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF j.cancel_requested THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_CANCEL_PENDING';END IF;
 r:=state_map_v1.apply_delta_v1(tenant,command,revision,root,operations);PERFORM predictive_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);b:=predictive_jobs_v4._sdk(j);
 IF b->>'status'='COMMITTED' THEN PERFORM predictive_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);
 ELSIF b->>'status' NOT IN('PENDING','WAITING_AUTH','HUMAN_REVIEW') THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_SDK_STATUS';END IF;
 RETURN r;
END $$;
CREATE FUNCTION predictive_jobs_v4.start_external_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;b jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM predictive_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=predictive_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);b:=predictive_jobs_v4._sdk(j);
 IF j.cancel_requested OR j.action<>'REVIEW' OR b->>'status'<>'PENDING' THEN RAISE EXCEPTION 'PREDICTIVE_EXTERNAL_START_BINDING';END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE predictive_jobs_v4.jobs SET external_started=true,updated_at=clock_timestamp() WHERE id=wanted;DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN true;
END $$;
CREATE FUNCTION predictive_jobs_v4.settle_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;b jsonb;next_status text;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);j:=predictive_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);b:=predictive_jobs_v4._sdk(j);
 IF b->>'status'='COMMITTED' THEN RETURN predictive_jobs_v4.finish_v4(tenant,wanted,owner,token,fence,grant_revision);END IF;
 next_status:=CASE b->>'status' WHEN 'PENDING' THEN 'RETRY' WHEN 'WAITING_AUTH' THEN 'WAITING_AUTH' WHEN 'HUMAN_REVIEW' THEN 'HUMAN_REVIEW' END;
 IF next_status IS NULL OR coalesce(b->>'nextAttempt','')!~'^[0-9]+$' OR coalesce(b->>'attempts','')!~'^[0-9]+$' THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_SDK_STATUS';END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 UPDATE predictive_jobs_v4.jobs SET status=next_status,attempts=(b->>'attempts')::integer,error_code=b->>'lastError',next_attempt=greatest(clock_timestamp()+interval '1 second',to_timestamp((b->>'nextAttempt')::double precision/1000)),worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;
 DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN predictive_jobs_v4._public(j);
END $$;
-- Accepting a close request never pretends a possibly-created external order was cancelled.
CREATE OR REPLACE FUNCTION predictive_jobs_v4.close_command_console_v4(tenant text,actor text,command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;BEGIN
 PERFORM predictive_jobs_v4._assert(tenant,false);IF actor IS NULL OR octet_length(actor)<1 OR octet_length(actor)>512 OR command IS NULL THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('console:'||predictive_jobs_v4._business_key(tenant,actor,command),0));
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());INSERT INTO predictive_jobs_v4.command_fences(tenant,actor_id,command_id) VALUES(tenant,actor,command) ON CONFLICT ON CONSTRAINT console_command_fence_pk DO NOTHING;
 SELECT * INTO j FROM predictive_jobs_v4.jobs q WHERE q.tenant=close_command_console_v4.tenant AND q.actor_id=actor AND q.command_id=command FOR UPDATE;
 IF FOUND AND j.status NOT IN('COMMITTED','FAILED','CANCELLED') AND NOT j.external_started THEN UPDATE predictive_jobs_v4.jobs SET cancel_requested=true,status='WAITING_AUTH',error_code='PREDICTIVE_CANCEL_AUTH_REQUIRED',fence=j.fence+1,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;END IF;
 DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN jsonb_build_object('commandId',command::text,'acceptanceClosed',true,'recoveryRequired',coalesce(j.external_started AND j.status NOT IN('COMMITTED','FAILED','CANCELLED'),false),'job',CASE WHEN j.id IS NULL THEN NULL ELSE predictive_jobs_v4._public(j) END);
END $$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4.authorize_v4(tenant text,actor text,wanted uuid,expected_grant bigint,sealed jsonb,until_time timestamptz,cancel boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;BEGIN
 PERFORM predictive_jobs_v4._assert(tenant,false);SELECT * INTO STRICT j FROM predictive_jobs_v4.jobs q WHERE q.id=wanted AND q.tenant=authorize_v4.tenant AND q.actor_id=actor FOR UPDATE;
 IF j.status IN('COMMITTED','FAILED','CANCELLED') THEN RETURN predictive_jobs_v4._public(j);END IF;
 IF cancel IS NULL OR j.grant_revision<>expected_grant OR sealed IS NULL OR until_time IS NULL OR until_time<=clock_timestamp() THEN RAISE EXCEPTION 'PREDICTIVE_QUEUE_GRANT_CONFLICT';END IF;
 IF cancel AND j.external_started THEN RAISE EXCEPTION 'PREDICTIVE_CREATION_RECOVERY_REQUIRED';END IF;
 IF j.status='HUMAN_REVIEW' AND NOT cancel THEN RAISE EXCEPTION 'PREDICTIVE_RETRY_REQUIRED';END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE predictive_jobs_v4.jobs SET sealed_grant=sealed,grant_revision=j.grant_revision+1,grant_until=until_time,cancel_requested=cancel_requested OR cancel,status='ACCEPTED',worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,fence=fence+1,next_attempt=clock_timestamp(),updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN predictive_jobs_v4._public(j);
END $$;
CREATE OR REPLACE FUNCTION predictive_jobs_v4.cancel_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,cancel_command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,predictive_jobs_v4,state_map_v1,pg_temp AS $$
DECLARE j predictive_jobs_v4.jobs;b jsonb;BEGIN
 PERFORM state_map_v1.read_head_v1(tenant);PERFORM predictive_jobs_v4.lock_v4(tenant,wanted,owner,token,fence,grant_revision,deadline);j:=predictive_jobs_v4._claim(tenant,wanted,owner,token,fence,grant_revision);
 IF NOT j.cancel_requested OR j.external_started THEN RAISE EXCEPTION 'PREDICTIVE_CREATION_RECOVERY_REQUIRED';END IF;
 b:=predictive_jobs_v4._state(tenant,'predictive_job',j.business_key)->'value';
 IF b IS NOT NULL AND b<>'null'::jsonb THEN RAISE EXCEPTION 'PREDICTIVE_SDK_CANCEL_REQUIRED';END IF;
 INSERT INTO predictive_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());UPDATE predictive_jobs_v4.jobs SET status='CANCELLED',result=NULL,error_code='CANCELLED',worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=wanted RETURNING * INTO j;DELETE FROM predictive_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN predictive_jobs_v4._public(j);
END $$;
REVOKE ALL ON FUNCTION predictive_jobs_v4._sdk(predictive_jobs_v4.jobs),predictive_jobs_v4.start_external_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz),predictive_jobs_v4.settle_v4(text,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION predictive_jobs_v4.start_external_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz),predictive_jobs_v4.settle_v4(text,uuid,uuid,uuid,bigint,bigint) TO __WORKER__;
REVOKE EXECUTE ON FUNCTION predictive_jobs_v4.publish_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) FROM __WORKER__;
RESET ROLE;
