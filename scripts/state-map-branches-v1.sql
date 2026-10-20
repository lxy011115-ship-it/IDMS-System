-- Fresh-schema extension only. Current/public heads remain unchanged during staging.
CREATE TABLE state_map_v1.branch_heads(
 branch_id uuid PRIMARY KEY,base state_map_v1.head NOT NULL,revision bigint NOT NULL CHECK(revision>=0),
 root_id bytea REFERENCES state_map_v1.nodes(id),root_hash bytea NOT NULL CHECK(octet_length(root_hash)=32),
 item_count bigint NOT NULL CHECK(item_count>=0),step_hash bytea NOT NULL CHECK(octet_length(step_hash)=32),
 published_command uuid REFERENCES state_map_v1.receipts(command_id));
CREATE TABLE state_map_v1.branch_steps(
 branch_id uuid NOT NULL REFERENCES state_map_v1.branch_heads(branch_id),command_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),body state_map_v1.receipts NOT NULL,
 PRIMARY KEY(branch_id,command_id),UNIQUE(branch_id,revision),
 CHECK((body).command_id=command_id AND (body).revision=revision AND (body).request_hash=request_hash));
CREATE FUNCTION state_map_v1._branch_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR (TG_TABLE_NAME='branch_steps' AND TG_OP<>'INSERT') OR TG_OP='DELETE' OR
 NOT EXISTS(SELECT 1 FROM state_map_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current())
 THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_DIRECT_WRITE_FORBIDDEN';END IF;RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOR t IN SELECT unnest(ARRAY['branch_heads','branch_steps']) LOOP
 EXECUTE format('CREATE TRIGGER state_map_branch_write_guard BEFORE INSERT OR UPDATE OR DELETE ON state_map_v1.%I FOR EACH ROW EXECUTE FUNCTION state_map_v1._branch_write_guard()',t);
 EXECUTE format('ALTER TABLE state_map_v1.%I ENABLE ALWAYS TRIGGER state_map_branch_write_guard',t);
 EXECUTE format('CREATE TRIGGER state_map_branch_truncate_guard BEFORE TRUNCATE ON state_map_v1.%I FOR EACH STATEMENT EXECUTE FUNCTION state_map_v1._branch_write_guard()',t);
 EXECUTE format('ALTER TABLE state_map_v1.%I ENABLE ALWAYS TRIGGER state_map_branch_truncate_guard',t);
 END LOOP;END $$;
CREATE FUNCTION state_map_v1._branch_seed(tenant text,b uuid,h state_map_v1.head) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT sha256(decode('0c','hex')||state_map_v1._frame(tenant)||uuid_send(b)||int8send(h.revision)||h.root_hash||h.receipt_hash)
$$;
CREATE FUNCTION state_map_v1._branch_receipt_hash(tenant text,b uuid,r state_map_v1.receipts) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT sha256(decode('0a','hex')||uuid_send(b)||state_map_v1._receipt_hash(tenant,r))
$$;
CREATE FUNCTION state_map_v1._assert_branches(tenant text,writing boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM state_map_v1._assert_current(tenant,writing);
 LOCK TABLE state_map_v1.branch_heads,state_map_v1.branch_steps IN ACCESS SHARE MODE;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid IN('state_map_v1.branch_heads'::regclass,'state_map_v1.branch_steps'::regclass)
 AND tgname IN('state_map_branch_write_guard','state_map_branch_truncate_guard') AND tgenabled='A')<>4
 THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_AUTHORITY';END IF;
END $$;
CREATE FUNCTION state_map_v1._branch_current(tenant text,wanted uuid,writing boolean) RETURNS state_map_v1.branch_heads LANGUAGE plpgsql AS $$
DECLARE b state_map_v1.branch_heads;r state_map_v1.receipts;n state_map_v1.nodes;
BEGIN
 PERFORM state_map_v1._assert_branches(tenant,writing);
 SELECT * INTO STRICT b FROM state_map_v1.branch_heads WHERE branch_id=wanted;
 IF b.revision=0 THEN
 IF b.root_id IS DISTINCT FROM (b.base).root_id OR b.root_hash<>(b.base).root_hash OR b.item_count<>(b.base).item_count OR b.step_hash<>state_map_v1._branch_seed(tenant,wanted,b.base)
 THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_INTEGRITY';END IF;
 ELSE
 SELECT (s.body).* INTO STRICT r FROM state_map_v1.branch_steps s WHERE s.branch_id=wanted AND s.revision=b.revision;
 IF r.root_id IS DISTINCT FROM b.root_id OR r.root_hash<>b.root_hash OR r.item_count<>b.item_count OR r.receipt_hash<>b.step_hash OR r.revision<>r.before_revision+1 OR r.receipt_hash<>state_map_v1._branch_receipt_hash(tenant,wanted,r)
 THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_INTEGRITY';END IF;
 END IF;
 IF b.root_id IS NULL THEN IF b.item_count<>0 OR b.root_hash<>(SELECT h FROM state_map_v1._empty WHERE depth=0) THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_ROOT';END IF;
 ELSE n:=state_map_v1._checked(b.root_id);IF b.item_count<>n.item_count OR b.root_hash<>state_map_v1._extend(n.state_hash,n.item_count,n.prefix,n.depth,0) THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_ROOT';END IF;END IF;
 IF b.published_command IS NOT NULL THEN
 SELECT * INTO STRICT r FROM state_map_v1.receipts WHERE command_id=b.published_command;
 IF r.root_id IS DISTINCT FROM b.root_id OR r.root_hash<>b.root_hash OR r.item_count<>b.item_count OR r.before_revision<>(b.base).revision OR r.before_root<>(b.base).root_hash OR r.before_receipt_hash<>(b.base).receipt_hash OR r.receipt_hash<>state_map_v1._receipt_hash(tenant,r)
 THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_PUBLICATION_INTEGRITY';END IF;END IF;
 RETURN b;
END $$;
CREATE FUNCTION state_map_v1._branch_json(b state_map_v1.branch_heads) RETURNS jsonb LANGUAGE sql STABLE STRICT AS $$
 SELECT jsonb_build_object('format','STATE_MAP_BRANCH_V1','tenantId',(SELECT tenant FROM state_map_v1._meta),'branchId',b.branch_id::text,
 'base',jsonb_build_object('revision',(b.base).revision::text,'rootId',encode((b.base).root_id,'hex'),'rootHash',encode((b.base).root_hash,'hex'),'count',(b.base).item_count::text,'receiptHash',encode((b.base).receipt_hash,'hex')),
 'head',jsonb_build_object('revision',b.revision::text,'rootId',encode(b.root_id,'hex'),'rootHash',encode(b.root_hash,'hex'),'count',b.item_count::text,'receiptHash',encode(b.step_hash,'hex')),
 'publishedCommandId',b.published_command::text)
$$;
CREATE FUNCTION state_map_v1.read_branch_v1(tenant text,branch uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE b state_map_v1.branch_heads;BEGIN b:=state_map_v1._branch_current(tenant,branch,false);RETURN state_map_v1._branch_json(b);END $$;
CREATE FUNCTION state_map_v1.begin_branch_v1(tenant text,branch uuid,expected_revision bigint,expected_root bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE h state_map_v1.head;b state_map_v1.branch_heads;
BEGIN
 PERFORM state_map_v1._assert_branches(tenant,true);
 IF branch IS NULL OR expected_revision IS NULL OR expected_revision<0 OR expected_root IS NULL OR octet_length(expected_root)<>32 THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 SELECT * INTO STRICT h FROM state_map_v1.head FOR SHARE;
 SELECT * INTO b FROM state_map_v1.branch_heads WHERE branch_id=branch;
 IF FOUND THEN b:=state_map_v1._branch_current(tenant,branch,true);IF (b.base).revision<>expected_revision OR (b.base).root_hash<>expected_root THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_CONFLICT';END IF;RETURN state_map_v1._branch_json(b);END IF;
 IF h.revision<>expected_revision OR h.root_hash<>expected_root THEN RAISE EXCEPTION 'STATE_MAP_CAS_CONFLICT';END IF;
 INSERT INTO state_map_v1._ctx VALUES(pg_backend_pid(),txid_current());
 INSERT INTO state_map_v1.branch_heads VALUES(branch,h,0,h.root_id,h.root_hash,h.item_count,state_map_v1._branch_seed(tenant,branch,h),NULL) ON CONFLICT DO NOTHING;
 b:=state_map_v1._branch_current(tenant,branch,true);
 IF (b.base).revision<>expected_revision OR (b.base).root_hash<>expected_root THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_CONFLICT';END IF;
 DELETE FROM state_map_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN state_map_v1._branch_json(b);
END $$;
CREATE FUNCTION state_map_v1.read_branch_step_v1(tenant text,branch uuid,command uuid,wanted_request bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE r state_map_v1.receipts;
BEGIN
 PERFORM state_map_v1._branch_current(tenant,branch,false);
 SELECT (s.body).* INTO r FROM state_map_v1.branch_steps s WHERE s.branch_id=branch AND s.command_id=command;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.request_hash IS DISTINCT FROM wanted_request THEN RAISE EXCEPTION 'STATE_MAP_COMMAND_CONFLICT';END IF;
 IF r.receipt_hash<>state_map_v1._branch_receipt_hash(tenant,branch,r) THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_INTEGRITY';END IF;
 RETURN state_map_v1._receipt_json(r,true)||jsonb_build_object('branchId',branch::text,'format','STATE_MAP_BRANCH_V1');
END $$;

__STAGE_FUNCTION__

CREATE FUNCTION state_map_v1.publish_branch_v1(tenant text,branch uuid,command uuid,expected_revision bigint,expected_root bytea,stage_revision bigint,stage_root bytea,stage_receipt bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,state_map_v1,pg_temp AS $$
DECLARE b state_map_v1.branch_heads;h state_map_v1.head;r state_map_v1.receipts;old state_map_v1.receipts;request bytea;
BEGIN
 PERFORM state_map_v1._assert_branches(tenant,true);
 IF branch IS NULL OR command IS NULL OR expected_revision IS NULL OR expected_revision<0 OR stage_revision IS NULL OR stage_revision<1 OR expected_root IS NULL OR octet_length(expected_root)<>32 OR stage_root IS NULL OR octet_length(stage_root)<>32 OR stage_receipt IS NULL OR octet_length(stage_receipt)<>32 THEN RAISE EXCEPTION 'STATE_MAP_INVALID';END IF;
 request:=sha256(decode('0b','hex')||state_map_v1._frame(tenant)||uuid_send(command)||uuid_send(branch)||int8send(expected_revision)||expected_root||int8send(stage_revision)||stage_root||stage_receipt);
 SELECT * INTO STRICT h FROM state_map_v1.head FOR UPDATE;
 SELECT * INTO STRICT b FROM state_map_v1.branch_heads WHERE branch_id=branch FOR UPDATE;
 b:=state_map_v1._branch_current(tenant,branch,true);
 SELECT * INTO old FROM state_map_v1.receipts WHERE command_id=command;
 IF FOUND THEN
 IF b.published_command IS DISTINCT FROM command OR old.request_hash<>request OR old.receipt_hash<>state_map_v1._receipt_hash(tenant,old) THEN RAISE EXCEPTION 'STATE_MAP_COMMAND_CONFLICT';END IF;
 RETURN state_map_v1._receipt_json(old,true);END IF;
 IF b.published_command IS NOT NULL THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_PUBLISHED';END IF;
 IF b.revision<>stage_revision OR b.root_hash<>stage_root OR b.step_hash<>stage_receipt THEN RAISE EXCEPTION 'STATE_MAP_BRANCH_CAS_CONFLICT';END IF;
 IF h.revision<>expected_revision OR h.root_hash<>expected_root OR h.revision<>(b.base).revision OR h.root_hash<>(b.base).root_hash OR h.receipt_hash<>(b.base).receipt_hash THEN RAISE EXCEPTION 'STATE_MAP_CAS_CONFLICT';END IF;
 INSERT INTO state_map_v1._ctx VALUES(pg_backend_pid(),txid_current());
 r.command_id:=command;r.request_hash:=request;r.before_revision:=h.revision;r.before_root:=h.root_hash;r.before_receipt_hash:=h.receipt_hash;r.revision:=h.revision+1;r.root_id:=b.root_id;r.root_hash:=b.root_hash;r.item_count:=b.item_count;
 r.receipt_hash:=state_map_v1._receipt_hash(tenant,r);INSERT INTO state_map_v1.receipts SELECT r.*;
 UPDATE state_map_v1.head SET revision=r.revision,root_id=r.root_id,root_hash=r.root_hash,item_count=r.item_count,receipt_hash=r.receipt_hash;
 UPDATE state_map_v1.branch_heads SET published_command=command WHERE branch_id=branch;
 PERFORM state_map_v1._branch_current(tenant,branch,true);
 DELETE FROM state_map_v1._ctx WHERE pid=pg_backend_pid() AND tx=txid_current();RETURN state_map_v1._receipt_json(r,false);
END $$;
