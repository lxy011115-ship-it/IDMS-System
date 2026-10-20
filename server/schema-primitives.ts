import {DomainError} from './service.ts';
export function object(value:unknown,label='对象'):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError(400,label+'无效');return value as Record<string,unknown>;}
export function keys(input:Record<string,unknown>,allowed:string[]){if(Object.keys(input).some(k=>!allowed.includes(k)))throw new DomainError(400,'存在未知或保留字段');}
export function text(value:unknown,label:string,max=120){if(typeof value!=='string'||!value.trim()||value.length>max)throw new DomainError(400,label+'无效');return value.trim();}
