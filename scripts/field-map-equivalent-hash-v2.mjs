import {hash as oneShotHash} from 'node:crypto';
import {StateMapError,stateMapFormat,stateMapLimits,stateEmptyHashes,validateStateNode,stateNodeId,statePrefix,stateBit,stateValueHash,parseStateValueText} from '../server/state-map-v1.ts';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),maximum=9223372036854775807n,empty=stateEmptyHashes.map(v=>Buffer.from(v,'hex'));
function need(value,code='STATE_MAP_INVALID'){if(!value)throw new StateMapError(code);}
function countBytes(value){need(typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=maximum);const result=Buffer.alloc(8);result.writeBigInt64BE(BigInt(value));return result;}
/** All messages and SHA-256 rounds are identical to stateExtend; buffers belong to this invocation. */
export function stateExtendEquivalentV2(valueHash,count,prefix,depth,toDepth){
 need(hex(valueHash)&&hex(prefix)&&Number.isInteger(depth)&&Number.isInteger(toDepth)&&depth<=256&&toDepth>=0&&toDepth<=depth);const encodedCount=countBytes(count),bits=Buffer.from(prefix,'hex');let current=Buffer.from(valueHash,'hex');
 const left=Buffer.alloc(81),right=Buffer.alloc(81);left[0]=right[0]=1;encodedCount.copy(left,1);encodedCount.copy(right,41);
 for(let i=depth-1;i>=toDepth;i--){const isRight=(bits[i>>3]>>(7-(i&7)))&1,frame=isRight?right:left;if(isRight){empty[i+1].copy(frame,9);current.copy(frame,49);}else{current.copy(frame,9);empty[i+1].copy(frame,49);}current=oneShotHash('sha256',frame,'buffer');}
 return current.toString('hex');
}
function commonPrefix(a,b){need(hex(a)&&hex(b));const left=Buffer.from(a,'hex'),right=Buffer.from(b,'hex');for(let i=0;i<32;i++){const xor=left[i]^right[i];if(xor)return i*8+Math.clz32(xor)-24;}return 256;}
function branchHash(leftHash,leftCount,rightHash,rightCount){need(hex(leftHash)&&hex(rightHash));const message=Buffer.alloc(81);message[0]=1;countBytes(leftCount).copy(message,1);Buffer.from(leftHash,'hex').copy(message,9);countBytes(rightCount).copy(message,41);Buffer.from(rightHash,'hex').copy(message,49);return oneShotHash('sha256',message,'hex');}
export function stateBranchEquivalentV2(depth,left,right){
 validateStateNode(left);validateStateNode(right);need(left.depth>depth&&right.depth>depth&&commonPrefix(left.prefix,right.prefix)===depth&&stateBit(left.prefix,depth)===0&&stateBit(right.prefix,depth)===1);
 const count=(BigInt(left.count)+BigInt(right.count)).toString(),prefix=statePrefix(left.prefix,depth),node={kind:1,depth,prefix,count,hash:branchHash(stateExtendEquivalentV2(left.hash,left.count,left.prefix,left.depth,depth+1),left.count,stateExtendEquivalentV2(right.hash,right.count,right.prefix,right.depth,depth+1),right.count),left:left.id,right:right.id,valueHash:null};return{id:stateNodeId(node),...node};
}
export function stateRootEquivalentV2(node){if(!node)return{rootId:null,rootHash:stateEmptyHashes[0],count:'0'};validateStateNode(node);return{rootId:node.id,rootHash:stateExtendEquivalentV2(node.hash,node.count,node.prefix,node.depth,0),count:node.count};}
export function verifyStateProofEquivalentV2(proof,expected,keyHash){
 need(proof?.format===stateMapFormat&&proof.root&&expected&&proof.keyHash===keyHash&&hex(keyHash)&&proof.root.rootId===expected.rootId&&proof.root.rootHash===expected.rootHash&&proof.root.count===expected.count,'STATE_MAP_PROOF');need(Array.isArray(proof.nodes)&&proof.nodes.length<=stateMapLimits.proofNodes,'STATE_MAP_PROOF');const nodes=new Map(),used=new Set();for(const node of proof.nodes){validateStateNode(node);need(!nodes.has(node.id),'STATE_MAP_PROOF');nodes.set(node.id,node);}const get=id=>{const node=nodes.get(id);need(node,'STATE_MAP_PROOF');used.add(id);return node;};let found=null;
 if(expected.rootId===null){need(expected.rootHash===stateEmptyHashes[0]&&expected.count==='0'&&nodes.size===0&&proof.valueText===null,'STATE_MAP_PROOF');return{present:false,value:null,valueHash:null};}
 let node=get(expected.rootId);const root=stateRootEquivalentV2(node);need(root.rootHash===expected.rootHash&&root.count===expected.count,'STATE_MAP_PROOF');for(let steps=0;;steps++){need(steps<=256,'STATE_MAP_PROOF');if(statePrefix(keyHash,node.depth)!==node.prefix)break;if(node.kind===0){found=node.valueHash;break;}const left=get(node.left),right=get(node.right),rebuilt=stateBranchEquivalentV2(node.depth,left,right);need(rebuilt.id===node.id,'STATE_MAP_PROOF');node=stateBit(keyHash,node.depth)?right:left;}
 need(used.size===nodes.size,'STATE_MAP_PROOF');if(found===null){need(proof.valueText===null,'STATE_MAP_PROOF');return{present:false,value:null,valueHash:null};}need(typeof proof.valueText==='string'&&stateValueHash(proof.valueText)===found,'STATE_MAP_PROOF');const value=parseStateValueText(proof.valueText);return{present:true,value,valueHash:found};
}
