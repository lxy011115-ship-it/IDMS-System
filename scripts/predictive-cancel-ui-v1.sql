-- Fresh deployment only, inserted before reconciliation queue event triggers are armed.
SET ROLE __OWNER__;
CREATE TABLE reconciliation_jobs_v1.auth_fences_ui(authorization_id uuid PRIMARY KEY,tenant text NOT NULL,actor_id text NOT NULL,case_id uuid NOT NULL,operation_id uuid NOT NULL,expected_grant bigint NOT NULL CHECK(expected_grant>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION reconciliation_jobs_v1._ui_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current()) THEN RAISE EXCEPTION 'RECON_UI_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER recon_ui_write BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_jobs_v1.auth_fences_ui FOR EACH ROW EXECUTE FUNCTION reconciliation_jobs_v1._ui_guard();
CREATE TRIGGER recon_ui_truncate BEFORE TRUNCATE ON reconciliation_jobs_v1.auth_fences_ui FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_jobs_v1._ui_guard();
ALTER TABLE reconciliation_jobs_v1.auth_fences_ui ENABLE ALWAYS TRIGGER recon_ui_write;
ALTER TABLE reconciliation_jobs_v1.auth_fences_ui ENABLE ALWAYS TRIGGER recon_ui_truncate;
ALTER FUNCTION reconciliation_jobs_v1.authorize_v1(text,text,uuid,uuid,bigint,jsonb,timestamptz,uuid,text) RENAME TO _authorize_core_ui_v1;
REVOKE ALL ON FUNCTION reconciliation_jobs_v1._authorize_core_ui_v1(text,text,uuid,uuid,bigint,jsonb,timestamptz,uuid,text) FROM __INGRESS__,__WORKER__,PUBLIC;
CREATE FUNCTION reconciliation_jobs_v1.authorize_v1(p_tenant text,p_actor text,p_case uuid,p_operation uuid,p_revision bigint,p_grant jsonb,p_until timestamptz,p_control uuid,p_session text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);PERFORM reconciliation_jobs_v1._case_lock(p_tenant,p_case);PERFORM pg_advisory_xact_lock(hashtextextended('recon-auth:'||p_control::text,0));
 IF EXISTS(SELECT 1 FROM reconciliation_jobs_v1.auth_fences_ui WHERE authorization_id=p_control) AND NOT EXISTS(SELECT 1 FROM reconciliation_jobs_v1.authorizations WHERE control_id=p_control) THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORIZATION_CLOSED';END IF;
 RETURN reconciliation_jobs_v1._authorize_core_ui_v1(p_tenant,p_actor,p_case,p_operation,p_revision,p_grant,p_until,p_control,p_session);
END $$;
CREATE FUNCTION reconciliation_jobs_v1.browse_ui_v1(p_tenant text,p_actor text,p_kind text,p_case uuid,p_position bigint,p_horizon bigint,p_limit integer,p_asof timestamptz,p_pending boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE hi bigint;at_time timestamptz;rows jsonb;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);
 IF p_kind NOT IN('CASES','MINE') OR p_position IS NULL OR p_position<0 OR p_horizon<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR p_pending IS NULL OR coalesce(octet_length(p_actor),0) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'RECON_UI_INPUT';END IF;
 at_time:=coalesce(p_asof,clock_timestamp());IF at_time>clock_timestamp()+interval '30 seconds' OR at_time<clock_timestamp()-interval '30 minutes' THEN RAISE EXCEPTION 'RECON_UI_PAGE_EXPIRED';END IF;
 SELECT coalesce(max(ordinal),0) INTO hi FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant;hi:=coalesce(p_horizon,hi);
 SELECT coalesce(jsonb_agg(jsonb_build_object('position',q.ordinal::text,'job',reconciliation_jobs_v1._public(q)) ORDER BY q.ordinal),'[]'::jsonb) INTO rows FROM (SELECT * FROM reconciliation_jobs_v1.jobs j WHERE j.tenant=p_tenant AND j.ordinal>p_position AND j.ordinal<=hi AND (p_case IS NULL OR j.case_id=p_case) AND (p_kind='CASES' AND j.action='OPEN' AND j.status='COMMITTED' AND j.updated_at<=at_time OR p_kind='MINE' AND j.actor_id=p_actor AND (NOT p_pending OR j.status NOT IN('COMMITTED','FAILED'))) ORDER BY j.ordinal LIMIT p_limit) q;
 RETURN jsonb_build_object('horizon',hi::text,'asOf',at_time,'items',rows);
END $$;
CREATE FUNCTION reconciliation_jobs_v1.flags_ui_v1(p_tenant text,p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$ BEGIN PERFORM reconciliation_jobs_v1._assert(p_tenant,false);RETURN jsonb_build_object('caseId',p_case::text,'releaseStarted',EXISTS(SELECT 1 FROM reconciliation_jobs_v1.releases WHERE tenant=p_tenant AND case_id=p_case),'busy',EXISTS(SELECT 1 FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND case_id=p_case AND status IN('ACCEPTED','RUNNING','RETRY')));END $$;
CREATE FUNCTION reconciliation_jobs_v1.auth_status_ui_v1(p_tenant text,p_actor text,p_control uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE a reconciliation_jobs_v1.authorizations;f reconciliation_jobs_v1.auth_fences_ui;j reconciliation_jobs_v1.jobs;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);SELECT * INTO a FROM reconciliation_jobs_v1.authorizations WHERE control_id=p_control AND tenant=p_tenant AND actor_id=p_actor;
 IF FOUND THEN SELECT * INTO STRICT j FROM reconciliation_jobs_v1.jobs WHERE id=a.job_id;RETURN jsonb_build_object('authorizationId',p_control::text,'caseId',a.case_id::text,'operationId',a.operation_id::text,'expectedGrantRevision',a.expected_grant::text,'accepted',true,'acceptanceClosed',EXISTS(SELECT 1 FROM reconciliation_jobs_v1.auth_fences_ui WHERE authorization_id=p_control),'job',reconciliation_jobs_v1._public(j));END IF;
 SELECT * INTO f FROM reconciliation_jobs_v1.auth_fences_ui WHERE authorization_id=p_control AND tenant=p_tenant AND actor_id=p_actor;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO STRICT j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND actor_id=p_actor AND case_id=f.case_id AND operation_id=f.operation_id;RETURN jsonb_build_object('authorizationId',p_control::text,'caseId',f.case_id::text,'operationId',f.operation_id::text,'expectedGrantRevision',f.expected_grant::text,'accepted',false,'acceptanceClosed',true,'job',reconciliation_jobs_v1._public(j));
END $$;
CREATE FUNCTION reconciliation_jobs_v1.close_auth_ui_v1(p_tenant text,p_actor text,p_case uuid,p_operation uuid,p_control uuid,p_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reconciliation_jobs_v1,pg_temp AS $$
DECLARE j reconciliation_jobs_v1.jobs;a reconciliation_jobs_v1.authorizations;f reconciliation_jobs_v1.auth_fences_ui;BEGIN
 PERFORM reconciliation_jobs_v1._assert(p_tenant,false);IF p_control IS NULL OR p_case IS NULL OR p_operation IS NULL OR p_revision IS NULL OR p_revision<1 THEN RAISE EXCEPTION 'RECON_UI_INPUT';END IF;PERFORM reconciliation_jobs_v1._case_lock(p_tenant,p_case);PERFORM pg_advisory_xact_lock(hashtextextended('recon-auth:'||p_control::text,0));
 SELECT * INTO j FROM reconciliation_jobs_v1.jobs WHERE tenant=p_tenant AND actor_id=p_actor AND case_id=p_case AND operation_id=p_operation;IF NOT FOUND THEN RAISE EXCEPTION 'RECON_UI_JOB_NOT_FOUND';END IF;
 SELECT * INTO a FROM reconciliation_jobs_v1.authorizations WHERE control_id=p_control;IF FOUND AND ROW(a.tenant,a.actor_id,a.case_id,a.operation_id,a.expected_grant) IS DISTINCT FROM ROW(p_tenant,p_actor,p_case,p_operation,p_revision) THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORIZATION_CONFLICT';END IF;
 SELECT * INTO f FROM reconciliation_jobs_v1.auth_fences_ui WHERE authorization_id=p_control;IF FOUND AND ROW(f.tenant,f.actor_id,f.case_id,f.operation_id,f.expected_grant) IS DISTINCT FROM ROW(p_tenant,p_actor,p_case,p_operation,p_revision) THEN RAISE EXCEPTION 'RECON_QUEUE_AUTHORIZATION_CONFLICT';END IF;
 INSERT INTO reconciliation_jobs_v1._ctx VALUES(pg_backend_pid(),txid_current());INSERT INTO reconciliation_jobs_v1.auth_fences_ui(authorization_id,tenant,actor_id,case_id,operation_id,expected_grant) VALUES(p_control,p_tenant,p_actor,p_case,p_operation,p_revision) ON CONFLICT DO NOTHING;DELETE FROM reconciliation_jobs_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();
 RETURN reconciliation_jobs_v1.auth_status_ui_v1(p_tenant,p_actor,p_control);
END $$;
REVOKE ALL ON TABLE reconciliation_jobs_v1.auth_fences_ui FROM PUBLIC;
REVOKE ALL ON FUNCTION reconciliation_jobs_v1._ui_guard(),reconciliation_jobs_v1.authorize_v1(text,text,uuid,uuid,bigint,jsonb,timestamptz,uuid,text),reconciliation_jobs_v1.browse_ui_v1(text,text,text,uuid,bigint,bigint,integer,timestamptz,boolean),reconciliation_jobs_v1.flags_ui_v1(text,uuid),reconciliation_jobs_v1.auth_status_ui_v1(text,text,uuid),reconciliation_jobs_v1.close_auth_ui_v1(text,text,uuid,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconciliation_jobs_v1.authorize_v1(text,text,uuid,uuid,bigint,jsonb,timestamptz,uuid,text) TO __INGRESS__;
GRANT EXECUTE ON FUNCTION reconciliation_jobs_v1.browse_ui_v1(text,text,text,uuid,bigint,bigint,integer,timestamptz,boolean),reconciliation_jobs_v1.flags_ui_v1(text,uuid),reconciliation_jobs_v1.auth_status_ui_v1(text,text,uuid),reconciliation_jobs_v1.close_auth_ui_v1(text,text,uuid,uuid,uuid,bigint) TO __INGRESS__,__WORKER__;
RESET ROLE;
