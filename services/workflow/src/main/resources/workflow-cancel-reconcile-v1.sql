CREATE SCHEMA idms_workflow_cancel_v1 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
CREATE TABLE idms_workflow_cancel_v1.decisions (
 control_id uuid PRIMARY KEY, command_id uuid NOT NULL, entity_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 envelope jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE idms_workflow_cancel_v1.blocks (
 entity_id text PRIMARY KEY, command_id uuid NOT NULL UNIQUE,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION idms_workflow_cancel_v1.immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'WORKFLOW_CANCEL_IMMUTABLE'; END; $$;
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON idms_workflow_cancel_v1.decisions
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_cancel_v1.immutable_v1();
CREATE TRIGGER decisions_no_truncate BEFORE TRUNCATE ON idms_workflow_cancel_v1.decisions
 FOR EACH STATEMENT EXECUTE FUNCTION idms_workflow_cancel_v1.immutable_v1();
CREATE TRIGGER blocks_immutable BEFORE UPDATE OR DELETE ON idms_workflow_cancel_v1.blocks
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_cancel_v1.immutable_v1();
CREATE TRIGGER blocks_no_truncate BEFORE TRUNCATE ON idms_workflow_cancel_v1.blocks
 FOR EACH STATEMENT EXECUTE FUNCTION idms_workflow_cancel_v1.immutable_v1();
CREATE FUNCTION idms_workflow_cancel_v1.reject_blocked_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF TG_TABLE_NAME = 'idms_workflow_cases' THEN
  IF EXISTS(SELECT 1 FROM idms_workflow_cancel_v1.blocks WHERE entity_id=NEW.entity_id) THEN
   RAISE EXCEPTION 'WORKFLOW_CREATION_DURABLY_BLOCKED';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM idms_workflow_cancel_v1.blocks WHERE command_id=NEW.command_id) THEN
   RAISE EXCEPTION 'WORKFLOW_CREATION_DURABLY_BLOCKED';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION idms_workflow_cancel_v1.decide_v1(p_tenant text,p_authority uuid,p_control uuid,p_envelope jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE prior jsonb; receipt jsonb; result jsonb; original uuid; entity text; digest text; blocked record;
BEGIN
 IF p_tenant IS DISTINCT FROM '__TENANT__' OR p_authority IS DISTINCT FROM '__AUTHORITY__'::uuid OR p_control IS NULL
  OR jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' OR p_envelope->>'action' IS DISTINCT FROM 'create'
  OR p_envelope->>'expectedVersion' IS DISTINCT FROM '1'
  OR coalesce(p_envelope->>'commandId','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR coalesce(p_envelope->>'entityId','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR coalesce(p_envelope->>'requestDigest','') !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_INPUT'; END IF;
 original := (p_envelope->>'commandId')::uuid; entity := p_envelope->>'entityId'; digest := p_envelope->>'requestDigest';
 -- Same entity lock, before touching case/receipt tables, as the original creation controller.
 PERFORM pg_advisory_xact_lock(hashtext(entity));
 LOCK TABLE public.idms_workflow_cases, public.idms_workflow_commands IN ROW EXCLUSIVE MODE;
 SELECT d.result INTO prior FROM idms_workflow_cancel_v1.decisions d WHERE control_id=p_control;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM idms_workflow_cancel_v1.decisions d WHERE control_id=p_control AND envelope=p_envelope)
   THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_CONTROL_CONFLICT'; END IF;
  RETURN prior;
 END IF;
 SELECT c.response INTO receipt FROM public.idms_workflow_commands c WHERE command_id=original;
 IF FOUND THEN
  IF receipt->>'commandId' IS DISTINCT FROM original::text OR receipt->>'entityId' IS DISTINCT FROM entity
   OR receipt->>'requestDigest' IS DISTINCT FROM digest
   OR NOT EXISTS(SELECT 1 FROM public.idms_workflow_commands c WHERE command_id=original AND request_digest=digest)
   OR receipt->>'version' IS DISTINCT FROM '1'
   OR receipt->>'state' IS DISTINCT FROM (CASE WHEN coalesce(p_envelope->>'assignee','')='' THEN 'UNASSIGNED' ELSE 'ASSIGNED' END)
   OR jsonb_typeof(receipt->'tasks') IS DISTINCT FROM 'array'
   OR jsonb_array_length(receipt->'tasks') IS DISTINCT FROM 1
   OR receipt->'tasks'->0->>'key' IS DISTINCT FROM (CASE WHEN coalesce(p_envelope->>'assignee','')='' THEN 'claim' ELSE 'startRepair' END)
   OR coalesce(receipt->>'processInstanceId','')='' OR coalesce(receipt->>'definitionId','')=''
   OR NOT EXISTS(SELECT 1 FROM public.idms_workflow_cases c WHERE entity_id=entity AND process_id=receipt->>'processInstanceId')
   OR EXISTS(SELECT 1 FROM idms_workflow_cancel_v1.blocks WHERE entity_id=entity OR command_id=original)
   THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_RECEIPT_CONFLICT'; END IF;
  result := jsonb_build_object('outcome','CREATED','creation',receipt);
 ELSE
  IF EXISTS(SELECT 1 FROM public.idms_workflow_cases WHERE entity_id=entity)
   THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_ENTITY_CONFLICT'; END IF;
  SELECT * INTO blocked FROM idms_workflow_cancel_v1.blocks WHERE entity_id=entity OR command_id=original;
  IF FOUND THEN
   IF blocked.entity_id<>entity OR blocked.command_id<>original OR blocked.request_digest<>digest OR blocked.envelope<>p_envelope
    THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_BLOCK_CONFLICT'; END IF;
  ELSE
   INSERT INTO idms_workflow_cancel_v1.blocks(entity_id,command_id,request_digest,envelope)
    VALUES(entity,original,digest,p_envelope);
  END IF;
  result := jsonb_build_object('outcome','BLOCKED','creation',NULL);
 END IF;
 result := result || jsonb_build_object('format','IDMS_WORKFLOW_CANCEL_RECONCILIATION_V1','tenantId',p_tenant,
  'authorityId',p_authority::text,'controlId',p_control::text,'commandId',original::text,
  'entityId',entity,'requestDigest',digest);
 INSERT INTO idms_workflow_cancel_v1.decisions(control_id,command_id,entity_id,request_digest,envelope,result)
  VALUES(p_control,original,entity,digest,p_envelope,result);
 RETURN result;
END; $$;
CREATE FUNCTION idms_workflow_cancel_v1.read_v1(p_tenant text,p_authority uuid,p_control uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = '' AS $$
BEGIN
 IF p_tenant IS DISTINCT FROM '__TENANT__' OR p_authority IS DISTINCT FROM '__AUTHORITY__'::uuid OR p_control IS NULL
  THEN RAISE EXCEPTION 'WORKFLOW_CANCEL_INPUT'; END IF;
 RETURN (SELECT result FROM idms_workflow_cancel_v1.decisions WHERE control_id=p_control);
END; $$;
REVOKE ALL ON ALL TABLES IN SCHEMA idms_workflow_cancel_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA idms_workflow_cancel_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA idms_workflow_cancel_v1 TO __RECONCILER__;
GRANT EXECUTE ON FUNCTION idms_workflow_cancel_v1.decide_v1(text,uuid,uuid,jsonb),idms_workflow_cancel_v1.read_v1(text,uuid,uuid) TO __RECONCILER__;
RESET ROLE;
GRANT SELECT,UPDATE ON public.idms_workflow_cases,public.idms_workflow_commands TO __OWNER__;
CREATE TRIGGER idms_cancel_case_guard_v1 BEFORE INSERT ON public.idms_workflow_cases
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_cancel_v1.reject_blocked_v1();
CREATE TRIGGER idms_cancel_command_guard_v1 BEFORE INSERT ON public.idms_workflow_commands
 FOR EACH ROW EXECUTE FUNCTION idms_workflow_cancel_v1.reject_blocked_v1();
