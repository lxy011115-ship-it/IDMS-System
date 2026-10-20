import test from 'node:test';
import assert from 'node:assert/strict';
import {DataValue,Variant,DataType,VariantArrayType,StatusCodes,coerceNodeId} from 'node-opcua';
import {fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {parseFieldProfile} from '../services/field/profile.ts';
import {verifyFieldNamespace,verifyFieldNodeMetadata,fieldSamples,readOnlyFieldServices} from '../services/field/read-protocol.ts';
const now=Date.now(),dv=(type:number,value:any,statusCode=StatusCodes.Good)=>new DataValue({value:new Variant({dataType:type,arrayType:VariantArrayType.Scalar,value}),statusCode,sourceTimestamp:new Date(now)}),p=()=>parseFieldProfile(fieldProfileFixture());
test('field namespace indices are bound to approved URIs and drift is rejected before value read',()=>{
 const raw=fieldProfileFixture(),n=new DataValue({value:new Variant({dataType:DataType.String,arrayType:VariantArrayType.Array,value:['http://opcfoundation.org/UA/',raw.points[0].namespaceUri]}),statusCode:StatusCodes.Good});assert.deepEqual(verifyFieldNamespace(n,p()),[{index:1,namespaceUri:raw.points[0].namespaceUri}]);n.value.value[1]='urn:idms:other';assert.throws(()=>verifyFieldNamespace(n,p()),(e:any)=>e.code==='FIELD_NAMESPACE_MISMATCH');
});
test('field metadata requires the exact numeric scalar declaration and observed readonly user permission',()=>{
 const metadata=[dv(DataType.NodeId,coerceNodeId(DataType.Double)),dv(DataType.Int32,-1),dv(DataType.Byte,3),dv(DataType.Byte,1)];assert.equal(verifyFieldNodeMetadata(metadata,p())[0].userAccessLevel,1);for(const [index,replacement]of [[0,dv(DataType.NodeId,coerceNodeId(DataType.String))],[1,dv(DataType.Int32,1)],[3,dv(DataType.Byte,3)],[3,dv(DataType.Byte,0)]] as const){const values=[...metadata];values[index]=replacement;assert.throws(()=>verifyFieldNodeMetadata(values,p()));}assert.throws(()=>verifyFieldNodeMetadata([...metadata,...metadata],p()));
});
test('field samples preserve raw quality and typed bad/null observations without numeric string conversion',()=>{
 const good=fieldSamples([dv(DataType.Double,42)],p(),now)[0];assert.equal(good.quality,'GOOD');assert.equal(good.value,42);assert.equal(good.rawStatusCode,0);const missing=fieldSamples([dv(DataType.Null,null,StatusCodes.BadNoCommunication)],p(),now)[0];assert.equal(missing.value,null);assert.equal(missing.quality,'BAD');assert.throws(()=>fieldSamples([dv(DataType.String,'42')],p(),now));assert.throws(()=>fieldSamples([dv(DataType.Double,NaN)],p(),now));assert.throws(()=>fieldSamples([dv(DataType.Double,9999)],p(),now));assert.equal(fieldSamples([dv(DataType.Double,9999,StatusCodes.BadOutOfRange)],p(),now)[0].quality,'BAD');
});
test('field Int64 and UInt64 conversions accept only exact safe integers and retain the approved type',()=>{
 const raw=fieldProfileFixture();raw.points[0].dataType='Int64';raw.points[0].minimum=-100;const profile=parseFieldProfile(raw);assert.equal(fieldSamples([dv(DataType.Int64,[0,42])],profile,now)[0].value,42);assert.equal(fieldSamples([dv(DataType.Int64,[0xffffffff,0xffffffff])],profile,now)[0].value,-1);assert.throws(()=>fieldSamples([dv(DataType.Int64,[0x200000,0])],profile,now),(e:any)=>e.code==='FIELD_INTEGER_PRECISION_UNSAFE');raw.points[0].dataType='UInt64';assert.throws(()=>fieldSamples([dv(DataType.UInt64,[0xffffffff,0xffffffff])],parseFieldProfile(raw),now),(e:any)=>e.code==='FIELD_INTEGER_PRECISION_UNSAFE');
});
test('missing, stale, future timestamps or incomplete response arrays never return partial samples',()=>{
 const good=dv(DataType.Double,42);for(const sourceTimestamp of [null,new Date(now-60001),new Date(now+1001)]){const value=new DataValue({value:good.value,statusCode:StatusCodes.Good,sourceTimestamp});assert.throws(()=>fieldSamples([value],p(),now),(e:any)=>e.code==='FIELD_SAMPLE_TIMESTAMP_INVALID');}assert.throws(()=>fieldSamples([],p(),now));assert.throws(()=>fieldSamples([good,good],p(),now));assert.equal(readOnlyFieldServices.includes('WriteRequest'),false);assert.equal(readOnlyFieldServices.includes('CallRequest'),false);assert.ok(Object.isFrozen(readOnlyFieldServices));
});
