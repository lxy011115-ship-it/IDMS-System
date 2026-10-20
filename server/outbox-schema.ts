import type pg from 'pg';
export const outboxKinds={workflow:{table:'workflow_outbox',key:'command_id'},ai:{table:'ai_review_outbox',key:'request_id'}} as const;
export type OutboxKind=keyof typeof outboxKinds;
export const workerClaimColumns=['worker_id','claim_token','claim_fence','lease_until','claimed_at'] as const;
export const workerClaimSchema=Object.values(outboxKinds).map(({table})=>`ALTER TABLE ${table}
 ADD COLUMN worker_id uuid,ADD COLUMN claim_token uuid,
 ADD COLUMN claim_fence bigint NOT NULL DEFAULT 0 CHECK(claim_fence>=0),
 ADD COLUMN lease_until timestamptz,ADD COLUMN claimed_at timestamptz,
 ADD CONSTRAINT ${table}_claim_consistent CHECK(
  (worker_id IS NULL AND claim_token IS NULL AND lease_until IS NULL) OR
  (worker_id IS NOT NULL AND claim_token IS NOT NULL AND lease_until IS NOT NULL AND claimed_at IS NOT NULL AND claim_fence>0)
 );
CREATE INDEX ${table}_dispatch_due ON ${table}(next_attempt,lease_until,created_at) WHERE status='PENDING';`).join('\n');
export async function verifyWorkerSchema(client:pg.PoolClient){
 for(const {table}of Object.values(outboxKinds)){
  const columns=(await client.query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attname=ANY($2::text[]) AND NOT a.attisdropped",[table,workerClaimColumns])).rows;
  const expected:Record<string,string>={worker_id:'uuid',claim_token:'uuid',claim_fence:'bigint',lease_until:'timestamp with time zone',claimed_at:'timestamp with time zone'};
  if(columns.length!==5||columns.some(c=>c.type!==expected[c.attname]||c.attnotnull!==(c.attname==='claim_fence')||(c.attname==='claim_fence'?c.default_expr!=='0':c.default_expr!==null)))throw Error('Outbox worker claim schema is missing or changed; explicit v4 migration required');
  const constraints=(await client.query("SELECT pg_get_expr(conbin,conrelid) AS body,convalidated FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'",[table])).rows;
  const expectedClaims=['(claim_fence >= 0)','(((worker_id IS NULL) AND (claim_token IS NULL) AND (lease_until IS NULL)) OR ((worker_id IS NOT NULL) AND (claim_token IS NOT NULL) AND (lease_until IS NOT NULL) AND (claimed_at IS NOT NULL) AND (claim_fence > 0)))'];
  if(expectedClaims.some(body=>!constraints.some(c=>c.convalidated&&c.body.replace(/\s/g,'')===body.replace(/\s/g,''))))throw Error('Outbox worker claim constraints are missing or changed');
  const indexes=(await client.query("SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::regclass AND c.relname=$2",[table,table+'_dispatch_due'])).rows;
  if(indexes.length!==1||!indexes[0].indisvalid||!indexes[0].indisready||!indexes[0].definition.includes('(next_attempt, lease_until, created_at)')||!indexes[0].definition.includes("status = 'PENDING'::text"))throw Error('Outbox worker dispatch index is missing or changed');
 }
}
