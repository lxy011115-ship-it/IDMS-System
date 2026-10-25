import assert from 'node:assert/strict';
const name='idms_qa_approval_anchor_abort_v1',message='QA_APPROVAL_ANCHOR_ABORT_AFTER_REAL_INSERT';

/** QA-owned SQLite only. The trigger can abort only after a matching real row exists. */
export function armColdApprovalAnchorAbortQaV1(db,approvalId){
 assert.match(approvalId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert.equal(db.isTransaction,false);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN (?,?)").get(name,'cold_plan_approvals_v1').n,0);
 const sql="CREATE TRIGGER "+name+" BEFORE UPDATE OF details ON cold_control WHEN NEW.id=1 AND json_extract(NEW.details,'$.planApprovals.body.sequence')=1 AND EXISTS(SELECT 1 FROM cold_plan_approvals_v1 WHERE sequence=1 AND approval_id='"+approvalId+"' AND body_sha256=json_extract(NEW.details,'$.planApprovals.body.headSha256')) BEGIN SELECT RAISE(ABORT,'"+message+"'); END";
 db.exec(sql);assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql,sql);return Object.freeze({name,sql,message,approvalId});
}
export function disarmColdApprovalAnchorAbortQaV1(db,proof){assert.equal(db.isTransaction,false);assert.equal(proof.name,name);assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql,proof.sql);db.exec('DROP TRIGGER '+name);assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name=?').get(name).n,0);}
