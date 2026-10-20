// Exact comparisons and accumulation of the normalized finite Number values.
// No rounding or clamping is used to decide whether performance exceeds one.
export interface Rational {n:bigint;d:bigint}
const abs=(n:bigint)=>n<0n?-n:n;
const gcd=(a:bigint,b:bigint):bigint=>{a=abs(a);b=abs(b);while(b){const r=a%b;a=b;b=r;}return a||1n;};
export function rational(n:bigint,d=1n):Rational{if(d===0n)throw Error('Zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};}
export const zero=()=>rational(0n);
export function decimal(value:unknown):Rational|null{
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return null;const parsed=Number(value);if(!Number.isFinite(parsed))return null;
 const s=String(parsed),match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s);if(!match)return null;const places=(match[3]||'').length-Number(match[4]||0),n=BigInt(match[2]+(match[3]||''))*(match[1]?-1n:1n);return places>=0?rational(n,10n**BigInt(places)):rational(n*10n**BigInt(-places));
}
export const add=(a:Rational,b:Rational)=>rational(a.n*b.d+b.n*a.d,a.d*b.d);
export const multiply=(a:Rational,b:Rational)=>rational(a.n*b.n,a.d*b.d);
export const divide=(a:Rational,b:Rational)=>rational(a.n*b.d,a.d*b.n);
export const compare=(a:Rational,b:Rational)=>a.n*b.d<b.n*a.d?-1:a.n*b.d>b.n*a.d?1:0;
export function rounded(r:Rational,digits=9):number|null{if(!Number.isInteger(digits)||digits<0||digits>12)throw Error('Unsupported precision');const scale=10n**BigInt(digits),n=(abs(r.n)*scale+r.d/2n)/r.d,value=Number(n)/Number(scale)*(r.n<0n?-1:1);return Number.isFinite(value)?value:null;}
export const percent=(numerator:Rational,denominator:Rational)=>denominator.n>0n?rounded(multiply(divide(numerator,denominator),rational(100n))):null;
export function safeCount(v:unknown):bigint|null{const n=decimal(v);if(!n||n.d!==1n||n.n<0n||n.n>BigInt(Number.MAX_SAFE_INTEGER))return null;return n.n;}
export interface Span {from:number;to:number}
export function unionSpans(spans:readonly Span[]):Span[]{const sorted=spans.filter(s=>s.to>s.from).map(s=>({...s})).sort((a,b)=>a.from-b.from||a.to-b.to),out:Span[]=[];for(const s of sorted){const last=out.at(-1);if(last&&s.from<=last.to)last.to=Math.max(last.to,s.to);else out.push(s);}return out;}
export const spanMilliseconds=(spans:readonly Span[])=>spans.reduce((n,s)=>n+BigInt(s.to-s.from),0n);
export function intersectSpans(a:readonly Span[],b:readonly Span[]):Span[]{const left=unionSpans(a),right=unionSpans(b),out:Span[]=[];let i=0,j=0;while(i<left.length&&j<right.length){const from=Math.max(left[i].from,right[j].from),to=Math.min(left[i].to,right[j].to);if(to>from)out.push({from,to});if(left[i].to<=right[j].to)i++;else j++;}return out;}
