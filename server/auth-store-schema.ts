import {sha,stable} from './auth-state.ts';
export const authStoreSchema=`CREATE TABLE auth_store_meta (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),deployment_digest text NOT NULL,
 key_check jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_state (
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),kind text NOT NULL CHECK(kind IN ('LOGIN','SESSION')),
 lookup_hash text NOT NULL CHECK(lookup_hash~'^[a-f0-9]{64}$'),revision integer NOT NULL CHECK(revision>0),
 expires_at timestamptz NOT NULL,sealed jsonb NOT NULL CHECK(jsonb_typeof(sealed)='object' AND octet_length(sealed::text)<400000),
 PRIMARY KEY(scope_hash,kind,lookup_hash)
);
CREATE INDEX auth_state_expiry ON auth_state(scope_hash,kind,expires_at);
CREATE TABLE auth_schema_migrations (
 version integer PRIMARY KEY,checksum text NOT NULL,deployment_digest text NOT NULL,
 owner_role text NOT NULL,app_role text NOT NULL,backup_role text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()
);`;
export const authPrivileges:Record<string,string[]>={auth_store_meta:['SELECT'],auth_state:['SELECT','INSERT','UPDATE','DELETE'],auth_schema_migrations:['SELECT']};
export const authSchemaChecksum=sha(stable({version:1,authStoreSchema,authPrivileges,encryption:'AES-256-GCM-AAD-v1',policy:'separate-auth-state-v1'}));
