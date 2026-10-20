import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stateMapSchemaSql} from './state-map-schema-v1.mjs';
import {stateEmptyHashes} from '../server/state-map-v1.ts';
const expectedV1Sql='477f37e8c5aa00a965ea8958b331dda7d93e71a305703737621db720ac2a05d0';
/** Fresh-schema implementation revision only. Wire hashes/format and all guards remain v1. */
export async function stateMapSchemaSqlV2(options){
 const base=await readFile(new URL('./state-map-v1.sql',import.meta.url),'utf8');
 if(createHash('sha256').update(base).digest('hex')!==expectedV1Sql)throw Error('STATE_MAP_V2_BASE_SOURCE_CHANGED');
 const start=base.indexOf('CREATE FUNCTION state_map_v1._extend('),end=base.indexOf('\nCREATE FUNCTION state_map_v1._id(',start);if(start<0||end<0)throw Error('STATE_MAP_V2_SOURCE_BOUNDARY');
 const original=base.slice(start,end),sql=await stateMapSchemaSql(options);if(sql.split(original).length!==2)throw Error('STATE_MAP_V2_SOURCE_BOUNDARY');
 const fixed=stateEmptyHashes.map(h=>"'\\x"+h+"'::bytea").join(',');
 const replacement=`CREATE FUNCTION state_map_v1._extend(h bytea,n bigint,p bytea,d integer,target integer) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE out bytea:=h; e bytea;
 -- Deterministic COMPRESSED_SMT_COUNTED_V1 constants, not a mutable data cache.
 empty_hashes CONSTANT bytea[]:=ARRAY[${fixed}];
BEGIN
 IF target<0 OR d>256 OR target>d THEN RAISE EXCEPTION 'STATE_MAP_INVALID'; END IF;
 IF d>target THEN FOR i IN REVERSE d-1..target LOOP
 e:=empty_hashes[i+2];
 IF state_map_v1._bit(p,i)=0 THEN out:=state_map_v1._merge(out,n,e,0); ELSE out:=state_map_v1._merge(e,0,out,n); END IF;
 END LOOP; END IF; RETURN out;
END $$;`;
 return sql.replace(original,()=>replacement);
}
