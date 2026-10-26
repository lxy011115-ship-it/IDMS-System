/** Captured sequences have values, not stored-table row counts. A missing
 * table count remains an error; it must never be treated as an empty table. */
export function sumColdCoreQueueRelationRowsQaV1(relations){
  if(!Array.isArray(relations)||relations.length===0||relations.length>1024)throw Error('CORE_FIELD_QUEUE_RELATION_COUNT');let rows=0;
  for(const relation of relations){
    if(relation?.kind==='S'){if(Object.hasOwn(relation,'rows'))throw Error('CORE_FIELD_QUEUE_SEQUENCE_ROW_METADATA');continue;}
    if(relation?.kind!=='r'||!Number.isSafeInteger(relation.rows)||relation.rows<0)throw Error('CORE_FIELD_QUEUE_TABLE_ROWS');rows+=relation.rows;if(!Number.isSafeInteger(rows)||rows>4000000)throw Error('CORE_FIELD_QUEUE_TABLE_ROW_LIMIT');
  }
  return rows;
}
