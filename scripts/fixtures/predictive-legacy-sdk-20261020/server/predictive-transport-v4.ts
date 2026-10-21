import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {readLimited} from '../integrations/ai.ts';
import {analyze,type Point} from '../services/predictor/model.ts';
import type {FrozenPredictiveInputV4} from './predictive-input-v4.ts';
const brand=Symbol('PREDICTIVE_REAL_RULE_RESPONSE_V4');
export class PredictiveTransportErrorV4 extends Error {readonly terminal:boolean;constructor(code:string,terminal=false){super(code);this.terminal=terminal;}}
export class PredictiveResultProofV4 {
 #input:string;#binding:string;#result:ReturnType<typeof analyze>;
 constructor(token:symbol,input:FrozenPredictiveInputV4,binding:string,result:ReturnType<typeof analyze>){need(token===brand,'PREDICTIVE_REAL_RESPONSE_REQUIRED');this.#input=canonicalDigest(input);this.#binding=binding;this.#result=structuredClone(result);}
 forInput(input:FrozenPredictiveInputV4,binding:string){need(this.#input===canonicalDigest(input)&&this.#binding===binding,'PREDICTIVE_RESPONSE_BINDING');return structuredClone(this.#result);}
}
export class PredictiveRuleTransportV4 {
 readonly binding:string;#url:URL;#token:string;
 constructor(c:{baseUrl:string;serviceToken:string}){const u=new URL(c.baseUrl);need(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname))&&typeof c.serviceToken==='string'&&c.serviceToken.length>=32&&c.serviceToken.length<=4096&&!/[\r\n]/.test(c.serviceToken),'PREDICTIVE_SERVICE_CONFIG');this.#url=u;this.#token=c.serviceToken;this.binding=canonicalDigest({origin:u.origin,credentialWitness:canonicalDigest(c.serviceToken)});}
 async dispatch(input:FrozenPredictiveInputV4){let r:Response,text:string;try{r=await fetch(new URL('/v1/analyze',this.#url),{method:'POST',headers:{authorization:'Bearer '+this.#token,'content-type':'application/json'},body:JSON.stringify({points:input.points}),redirect:'error',signal:AbortSignal.timeout(10000)});text=await readLimited(r.body,65536);}catch{throw new PredictiveTransportErrorV4('PREDICTIVE_SERVICE_NETWORK_UNCONFIRMED');}if(!r.ok)throw new PredictiveTransportErrorV4('PREDICTIVE_SERVICE_HTTP_'+r.status,r.status<500&&r.status!==429);let result:ReturnType<typeof analyze>;try{result=JSON.parse(text);if(!canonicalEqual(result,analyze(input.points as Point[])))throw Error();}catch{throw new PredictiveTransportErrorV4('PREDICTIVE_SERVICE_RESPONSE_INVALID',true);}return new PredictiveResultProofV4(brand,input,this.binding,result);}
}
