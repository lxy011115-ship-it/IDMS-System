import {governanceJobsSchemaSqlV4} from './governance-jobs-schema-v4.mjs';
/** Fresh only, before queue event triggers: old workers cannot mutate a console deployment. */
export async function governanceConsoleSchemaSqlV4(options){
 const sql=await governanceJobsSchemaSqlV4(options),marker='CREATE EVENT TRIGGER governance_queue_ddl_start_v4',parts=sql.split(marker);if(parts.length!==2)throw Error('CONSOLE_SCHEMA_INSERTION');for(const key of ['owner','worker','ingress'])if(!/^[a-z_][a-z0-9_]{0,62}$/.test(options[key]))throw Error('CONSOLE_SCHEMA_IDENTITY');const owner='"'+options.owner+'"',worker='"'+options.worker+'"',ingress='"'+options.ingress+'"';
 const wrappers=`
SET ROLE ${owner};
CREATE TABLE governance_jobs_v4.command_fences(tenant text NOT NULL,actor_id text NOT NULL,command_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CONSTRAINT console_command_fence_pk PRIMARY KEY(tenant,actor_id,command_id));
CREATE FUNCTION governance_jobs_v4._console_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current()) THEN RAISE EXCEPTION 'CONSOLE_COMMAND_FENCE_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER console_command_fence_write BEFORE INSERT OR UPDATE OR DELETE ON governance_jobs_v4.command_fences FOR EACH ROW EXECUTE FUNCTION governance_jobs_v4._console_fence_guard();
CREATE TRIGGER console_command_fence_truncate BEFORE TRUNCATE ON governance_jobs_v4.command_fences FOR EACH STATEMENT EXECUTE FUNCTION governance_jobs_v4._console_fence_guard();
ALTER TABLE governance_jobs_v4.command_fences ENABLE ALWAYS TRIGGER console_command_fence_write;
ALTER TABLE governance_jobs_v4.command_fences ENABLE ALWAYS TRIGGER console_command_fence_truncate;
REVOKE ALL ON TABLE governance_jobs_v4.command_fences FROM PUBLIC;
REVOKE ALL ON FUNCTION governance_jobs_v4._console_fence_guard() FROM PUBLIC;
CREATE FUNCTION governance_jobs_v4.enqueue_console_v4(tenant text,actor text,wanted uuid,command uuid,action text,request text,sealed_command jsonb,sealed_grant jsonb,grant_until timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
BEGIN
 PERFORM governance_jobs_v4._assert(tenant,false);IF actor IS NULL OR octet_length(actor)<1 OR octet_length(actor)>512 OR command IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('console:'||governance_jobs_v4._business_key(tenant,actor,command),0));
 IF EXISTS(SELECT 1 FROM governance_jobs_v4.command_fences f WHERE f.tenant=enqueue_console_v4.tenant AND f.actor_id=actor AND f.command_id=command) AND NOT EXISTS(SELECT 1 FROM governance_jobs_v4.jobs q WHERE q.tenant=enqueue_console_v4.tenant AND q.actor_id=actor AND q.command_id=command) THEN RAISE EXCEPTION 'CONSOLE_COMMAND_ACCEPTANCE_CLOSED';END IF;
 RETURN governance_jobs_v4.enqueue_v4(tenant,actor,wanted,command,action,request,sealed_command,sealed_grant,grant_until);
END $$;
CREATE FUNCTION governance_jobs_v4.close_command_console_v4(tenant text,actor text,command uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE j governance_jobs_v4.jobs;BEGIN
 PERFORM governance_jobs_v4._assert(tenant,false);IF actor IS NULL OR octet_length(actor)<1 OR octet_length(actor)>512 OR command IS NULL THEN RAISE EXCEPTION 'GOVERNANCE_QUEUE_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('console:'||governance_jobs_v4._business_key(tenant,actor,command),0));
 INSERT INTO governance_jobs_v4._ctx VALUES(pg_backend_pid(),txid_current());
 INSERT INTO governance_jobs_v4.command_fences(tenant,actor_id,command_id) VALUES(tenant,actor,command) ON CONFLICT ON CONSTRAINT console_command_fence_pk DO NOTHING;
 SELECT * INTO j FROM governance_jobs_v4.jobs q WHERE q.tenant=close_command_console_v4.tenant AND q.actor_id=actor AND q.command_id=command FOR UPDATE;
 IF FOUND THEN IF j.status NOT IN('COMMITTED','FAILED','CANCELLED') THEN UPDATE governance_jobs_v4.jobs SET cancel_requested=true,status='WAITING_AUTH',error_code='GOVERNANCE_CANCEL_AUTH_REQUIRED',fence=j.fence+1,worker_id=NULL,claim_token=NULL,lease_until=NULL,auth_deadline=NULL,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;END IF;END IF;
 DELETE FROM governance_jobs_v4._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN jsonb_build_object('commandId',command::text,'acceptanceClosed',true,'job',CASE WHEN j.id IS NULL THEN NULL ELSE governance_jobs_v4._public(j) END);
END $$;
CREATE FUNCTION governance_jobs_v4.command_closed_console_v4(tenant text,actor text,command uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$ BEGIN PERFORM governance_jobs_v4._assert(tenant,false);RETURN EXISTS(SELECT 1 FROM governance_jobs_v4.command_fences f WHERE f.tenant=command_closed_console_v4.tenant AND f.actor_id=actor AND f.command_id=command);END $$;
REVOKE ALL ON FUNCTION governance_jobs_v4.enqueue_console_v4(text,text,uuid,uuid,text,text,jsonb,jsonb,timestamptz),governance_jobs_v4.close_command_console_v4(text,text,uuid),governance_jobs_v4.command_closed_console_v4(text,text,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION governance_jobs_v4.enqueue_v4(text,text,uuid,uuid,text,text,jsonb,jsonb,timestamptz) FROM ${ingress};
GRANT EXECUTE ON FUNCTION governance_jobs_v4.enqueue_console_v4(text,text,uuid,uuid,text,text,jsonb,jsonb,timestamptz),governance_jobs_v4.close_command_console_v4(text,text,uuid),governance_jobs_v4.command_closed_console_v4(text,text,uuid) TO ${ingress};
CREATE FUNCTION governance_jobs_v4.prepare_console_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,command uuid,revision bigint,root bytea,operations jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
 SELECT governance_jobs_v4.prepare_v4(tenant,wanted,owner,token,fence,grant_revision,deadline,command,revision,root,operations)
$$;
CREATE FUNCTION governance_jobs_v4.publish_console_v4(tenant text,wanted uuid,owner uuid,token uuid,fence bigint,grant_revision bigint,deadline timestamptz,branch uuid,command uuid,base_revision bigint,base_root bytea,stage_revision bigint,stage_root bytea,stage_receipt bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,governance_jobs_v4,pg_temp AS $$
DECLARE result jsonb;control jsonb;catalog jsonb;BEGIN
 result:=governance_jobs_v4.publish_v4(tenant,wanted,owner,token,fence,grant_revision,deadline,branch,command,base_revision,base_root,stage_revision,stage_root,stage_receipt);
 control:=governance_jobs_v4._state(tenant,'domain_head','control');catalog:=governance_jobs_v4._state(tenant,'domain_head','governance_console');
 IF catalog->'value'->>'format' IS DISTINCT FROM 'IDMS_GOVERNANCE_CONSOLE_V4_1' OR catalog->'value'->>'tenantId' IS DISTINCT FROM tenant OR catalog->'value'->>'governanceAnchorDigest' IS DISTINCT FROM control->'value'->>'governanceAnchorDigest' THEN RAISE EXCEPTION 'CONSOLE_PUBLICATION_CATALOG';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION governance_jobs_v4.prepare_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,bigint,bytea,jsonb),governance_jobs_v4.publish_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION governance_jobs_v4.prepare_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,bigint,bytea,jsonb),governance_jobs_v4.publish_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) FROM ${worker};
GRANT EXECUTE ON FUNCTION governance_jobs_v4.prepare_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,bigint,bytea,jsonb),governance_jobs_v4.publish_console_v4(text,uuid,uuid,uuid,bigint,bigint,timestamptz,uuid,uuid,bigint,bytea,bigint,bytea,bytea) TO ${worker};
RESET ROLE;
`;
 return parts[0]+wrappers+marker+parts[1];
}
