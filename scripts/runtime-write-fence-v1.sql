CREATE SCHEMA runtime_write_fence_v1 AUTHORIZATION __OWNER__;
SET ROLE __OWNER__;
CREATE SEQUENCE runtime_write_fence_v1._ddl_epoch;
CREATE TABLE runtime_write_fence_v1._state(
 singleton boolean PRIMARY KEY CHECK(singleton),deployment uuid NOT NULL,database_oid oid NOT NULL,owner_oid oid NOT NULL,control_oid oid NOT NULL,
 state text NOT NULL CHECK(state IN('CLOSED','OPEN')),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),operation uuid NOT NULL,
 authority_id uuid,authority_epoch bigint NOT NULL DEFAULT 0,authority_hash text,finalized boolean NOT NULL DEFAULT false,ddl_epoch bigint NOT NULL DEFAULT 0,catalog_hash text
);
CREATE TABLE runtime_write_fence_v1._actors(role_oid oid PRIMARY KEY);
CREATE TABLE runtime_write_fence_v1._relations(relation_oid oid PRIMARY KEY,schema_name text NOT NULL,table_name text NOT NULL,owner_oid oid NOT NULL,UNIQUE(schema_name,table_name));
INSERT INTO runtime_write_fence_v1._state VALUES(true,__DEPLOYMENT__,(SELECT oid FROM pg_database WHERE datname=current_database()),__OWNER_LITERAL__::regrole::oid,__CONTROL_LITERAL__::regrole::oid,'CLOSED',0,__DEPLOYMENT__,NULL,0,NULL,false,0,NULL);
CREATE FUNCTION runtime_write_fence_v1._private_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,runtime_write_fence_v1,pg_temp AS $$
BEGIN IF session_user::regrole::oid<>(SELECT control_oid FROM runtime_write_fence_v1._state) THEN RAISE EXCEPTION 'RUNTIME_FENCE_CONTROL_ONLY';END IF;IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE FUNCTION runtime_write_fence_v1._write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,runtime_write_fence_v1,pg_temp AS $$
DECLARE s runtime_write_fence_v1._state;a record;e bigint;
BEGIN
 SELECT * INTO STRICT s FROM runtime_write_fence_v1._state;
 IF session_user::regrole::oid=s.control_oid THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM runtime_write_fence_v1._actors WHERE role_oid=session_user::regrole::oid) OR NOT EXISTS(SELECT 1 FROM runtime_write_fence_v1._relations WHERE relation_oid=TG_RELID) THEN RAISE EXCEPTION 'RUNTIME_FENCE_ACTOR_OR_RELATION';END IF;
 SELECT * INTO STRICT a FROM pg_roles WHERE oid=session_user::regrole::oid;
 IF a.rolsuper OR a.rolinherit OR a.rolcreatedb OR a.rolcreaterole OR a.rolreplication OR a.rolbypassrls OR NOT a.rolcanlogin OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=a.oid OR roleid=a.oid) OR has_parameter_privilege(a.oid,'session_replication_role','SET') THEN RAISE EXCEPTION 'RUNTIME_FENCE_ROLE';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(1229213011,905001) THEN RAISE EXCEPTION 'RUNTIME_FENCE_DRAINING';END IF;
 SELECT * INTO STRICT s FROM runtime_write_fence_v1._state FOR SHARE;
 IF s.state<>'OPEN' THEN RAISE EXCEPTION 'RUNTIME_FENCE_CLOSED';END IF;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO e FROM runtime_write_fence_v1._ddl_epoch;
 IF s.finalized AND e<>s.ddl_epoch THEN RAISE EXCEPTION 'RUNTIME_FENCE_CATALOG_CHANGED';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION runtime_write_fence_v1.set_state_v1(wanted uuid,expected bigint,op uuid,next_state text,auth_id uuid,auth_epoch bigint,auth_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,runtime_write_fence_v1,pg_temp AS $$
DECLARE s runtime_write_fence_v1._state;
BEGIN
 IF session_user::regrole::oid<>(SELECT control_oid FROM runtime_write_fence_v1._state) THEN RAISE EXCEPTION 'RUNTIME_FENCE_CONTROL_ONLY';END IF;
 PERFORM pg_advisory_xact_lock(1229213011,905001);SELECT * INTO STRICT s FROM runtime_write_fence_v1._state FOR UPDATE;
 IF wanted IS NULL OR expected IS NULL OR expected<0 OR s.deployment<>wanted OR op IS NULL OR next_state IS NULL OR next_state NOT IN('CLOSED','OPEN') THEN RAISE EXCEPTION 'RUNTIME_FENCE_INPUT';END IF;
 IF s.operation=op AND s.state=next_state AND (next_state='CLOSED' OR s.authority_id=auth_id AND s.authority_epoch=auth_epoch AND s.authority_hash=auth_hash) THEN RETURN to_jsonb(s);END IF;
 IF s.revision<>expected THEN RAISE EXCEPTION 'RUNTIME_FENCE_CAS';END IF;
 IF next_state='OPEN' AND (auth_id IS NULL OR auth_epoch IS NULL OR auth_epoch<=0 OR auth_epoch<s.authority_epoch OR auth_hash IS NULL OR auth_hash!~'^[a-f0-9]{64}$' OR s.authority_id IS NOT NULL AND s.authority_id<>auth_id) THEN RAISE EXCEPTION 'RUNTIME_FENCE_AUTHORITY';END IF;
 UPDATE runtime_write_fence_v1._state SET state=next_state,revision=revision+1,operation=op,authority_id=CASE WHEN next_state='OPEN' THEN auth_id ELSE authority_id END,authority_epoch=CASE WHEN next_state='OPEN' THEN auth_epoch ELSE authority_epoch END,authority_hash=CASE WHEN next_state='OPEN' THEN auth_hash ELSE authority_hash END RETURNING * INTO s;
 RETURN to_jsonb(s);
END $$;
CREATE FUNCTION runtime_write_fence_v1._ddl_start() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,runtime_write_fence_v1,pg_temp AS $$
BEGIN IF session_user::regrole::oid<>(SELECT control_oid FROM runtime_write_fence_v1._state) THEN RAISE EXCEPTION 'RUNTIME_FENCE_DDL_FORBIDDEN';END IF;PERFORM pg_advisory_xact_lock(1229213011,905001);END $$;
CREATE FUNCTION runtime_write_fence_v1._ddl_end() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,runtime_write_fence_v1,pg_temp AS $$
BEGIN PERFORM nextval('runtime_write_fence_v1._ddl_epoch');END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['_state','_actors','_relations'] LOOP
 EXECUTE format('CREATE TRIGGER runtime_fence_private BEFORE INSERT OR UPDATE OR DELETE ON runtime_write_fence_v1.%I FOR EACH ROW EXECUTE FUNCTION runtime_write_fence_v1._private_guard()',t);
 EXECUTE format('ALTER TABLE runtime_write_fence_v1.%I ENABLE ALWAYS TRIGGER runtime_fence_private',t);
 END LOOP;END $$;
REVOKE ALL ON SCHEMA runtime_write_fence_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA runtime_write_fence_v1 FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA runtime_write_fence_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA runtime_write_fence_v1 FROM PUBLIC;
RESET ROLE;
CREATE EVENT TRIGGER runtime_fence_ddl_start_v1 ON ddl_command_start EXECUTE FUNCTION runtime_write_fence_v1._ddl_start();
CREATE EVENT TRIGGER runtime_fence_ddl_end_v1 ON ddl_command_end EXECUTE FUNCTION runtime_write_fence_v1._ddl_end();
ALTER EVENT TRIGGER runtime_fence_ddl_start_v1 ENABLE ALWAYS;
ALTER EVENT TRIGGER runtime_fence_ddl_end_v1 ENABLE ALWAYS;
