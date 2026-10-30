CREATE SCHEMA idms_workflow_reservation_v1 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
CREATE TABLE idms_workflow_reservation_v1.reservations (
 control_id uuid PRIMARY KEY,entity_id text NOT NULL UNIQUE,command_id uuid NOT NULL,
 envelope jsonb NOT NULL,held_case jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('HELD','RELEASED')),
 release_digest text CHECK(release_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),released_at timestamptz,
 CHECK((status='HELD' AND release_digest IS NULL AND released_at IS NULL) OR
       (status='RELEASED' AND release_digest IS NOT NULL AND released_at IS NOT NULL))
);
CREATE FUNCTION idms_workflow_reservation_v1.immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
 IF OLD.status='HELD' AND NEW.status='RELEASED'
  AND OLD.release_digest IS NULL AND NEW.release_digest ~ '^[a-f0-9]{64}$' AND NEW.released_at IS NOT NULL
  AND (to_jsonb(OLD)-ARRAY['status','release_digest','released_at'])=(to_jsonb(NEW)-ARRAY['status','release_digest','released_at'])
 THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'WORKFLOW_RESERVATION_IMMUTABLE';
END; $$;
CREATE TRIGGER reservation_immutable BEFORE UPDATE OR DELETE ON idms_workflow_reservation_v1.reservations
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_reservation_v1.immutable_v1();
CREATE TRIGGER reservation_no_truncate BEFORE TRUNCATE ON idms_workflow_reservation_v1.reservations
 FOR EACH STATEMENT EXECUTE FUNCTION idms_workflow_reservation_v1.immutable_v1();
CREATE FUNCTION idms_workflow_reservation_v1.case_guard_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM idms_workflow_reservation_v1.reservations WHERE entity_id=OLD.entity_id AND status='HELD')
 THEN RAISE EXCEPTION 'WORKFLOW_RECONCILIATION_HELD'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
CREATE FUNCTION idms_workflow_reservation_v1.view_v1(p_tenant text,p_authority uuid,p_control uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path='' AS $$
DECLARE decision jsonb; r record; current_case jsonb; phase text; release_digest text;
BEGIN
 IF p_tenant IS DISTINCT FROM '__TENANT__' OR p_authority IS DISTINCT FROM '__AUTHORITY__'::uuid OR p_control IS NULL
 THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_BINDING'; END IF;
 decision:=idms_workflow_cancel_v1.read_v1(p_tenant,p_authority,p_control);
 IF decision IS NULL THEN RETURN NULL; END IF;
 IF decision->>'outcome'='BLOCKED' THEN phase:='BLOCKED';current_case:=NULL;
 ELSE
  SELECT * INTO r FROM idms_workflow_reservation_v1.reservations WHERE control_id=p_control;
  IF FOUND THEN
   phase:=r.status;release_digest:=r.release_digest;current_case:=r.held_case;
   IF r.entity_id IS DISTINCT FROM decision->>'entityId' OR r.command_id::text IS DISTINCT FROM decision->>'commandId'
    OR (phase='HELD' AND NOT EXISTS(SELECT 1 FROM public.idms_workflow_cases c WHERE c.entity_id=r.entity_id
      AND c.version=(r.held_case->>'version')::integer AND c.state=r.held_case->>'state'
      AND c.assignee=r.held_case->>'assignee' AND c.process_id=r.held_case->>'processInstanceId'))
   THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_CASE_CHANGED'; END IF;
  ELSE
   SELECT jsonb_build_object('entityId',c.entity_id,'version',c.version,'state',c.state,'assignee',c.assignee,
    'processInstanceId',c.process_id,'definitionId',decision->'creation'->>'definitionId') INTO current_case
    FROM public.idms_workflow_cases c WHERE c.entity_id=decision->>'entityId';
   IF current_case IS NULL THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_CASE_MISSING'; END IF;
   phase:=CASE WHEN current_case->>'version'='1' AND current_case->>'state'=decision->'creation'->>'state'
    AND current_case->>'processInstanceId'=decision->'creation'->>'processInstanceId' THEN 'UNRESERVED' ELSE 'ADVANCED' END;
  END IF;
 END IF;
 RETURN jsonb_build_object('format','IDMS_WORKFLOW_CANCEL_RESERVATION_V1','tenantId',p_tenant,'authorityId',p_authority::text,
  'controlId',p_control::text,'decision',decision,'phase',phase,'case',current_case,'domainReceiptDigest',release_digest);
END; $$;
CREATE FUNCTION idms_workflow_reservation_v1.reserve_v1(p_tenant text,p_authority uuid,p_control uuid,p_envelope jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE decision jsonb; value jsonb; entity text; prior record;
BEGIN
 entity:=p_envelope->>'entityId';PERFORM pg_advisory_xact_lock(hashtext(entity));
 decision:=idms_workflow_cancel_v1.decide_v1(p_tenant,p_authority,p_control,p_envelope);
 value:=idms_workflow_reservation_v1.view_v1(p_tenant,p_authority,p_control);
 IF value->>'phase'<>'UNRESERVED' THEN RETURN value; END IF;
 SELECT * INTO prior FROM idms_workflow_reservation_v1.reservations WHERE entity_id=entity;
 IF FOUND THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_OTHER_CONTROL'; END IF;
 INSERT INTO idms_workflow_reservation_v1.reservations(control_id,entity_id,command_id,envelope,held_case,status)
 VALUES(p_control,entity,(p_envelope->>'commandId')::uuid,p_envelope,value->'case','HELD');
 RETURN idms_workflow_reservation_v1.view_v1(p_tenant,p_authority,p_control);
END; $$;
CREATE FUNCTION idms_workflow_reservation_v1.release_v1(p_tenant text,p_authority uuid,p_control uuid,p_envelope jsonb,p_digest text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record; value jsonb;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_RELEASE_DIGEST'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(p_envelope->>'entityId'));
 value:=idms_workflow_reservation_v1.view_v1(p_tenant,p_authority,p_control);
 SELECT * INTO r FROM idms_workflow_reservation_v1.reservations WHERE control_id=p_control;
 IF NOT FOUND OR r.envelope IS DISTINCT FROM p_envelope OR r.entity_id IS DISTINCT FROM p_envelope->>'entityId'
 THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_RELEASE_BINDING'; END IF;
 IF r.status='RELEASED' THEN
  IF r.release_digest<>p_digest THEN RAISE EXCEPTION 'WORKFLOW_RESERVATION_RELEASE_CONFLICT'; END IF;
  RETURN value;
 END IF;
 UPDATE idms_workflow_reservation_v1.reservations SET status='RELEASED',release_digest=p_digest,released_at=clock_timestamp()
 WHERE control_id=p_control;
 RETURN idms_workflow_reservation_v1.view_v1(p_tenant,p_authority,p_control);
END; $$;
CREATE FUNCTION idms_workflow_reservation_v1.read_v1(p_tenant text,p_authority uuid,p_control uuid)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path='' AS $$
 SELECT idms_workflow_reservation_v1.view_v1(p_tenant,p_authority,p_control)
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA idms_workflow_reservation_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA idms_workflow_reservation_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA idms_workflow_reservation_v1 TO __RECONCILER__;
GRANT EXECUTE ON FUNCTION idms_workflow_reservation_v1.reserve_v1(text,uuid,uuid,jsonb),
 idms_workflow_reservation_v1.release_v1(text,uuid,uuid,jsonb,text),idms_workflow_reservation_v1.read_v1(text,uuid,uuid) TO __RECONCILER__;
RESET ROLE;
CREATE TRIGGER idms_reconciliation_case_hold_v1 BEFORE UPDATE OR DELETE ON public.idms_workflow_cases
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_reservation_v1.case_guard_v1();
