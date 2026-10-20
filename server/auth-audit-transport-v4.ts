import type {ClientConfig} from 'pg';
import {authAuditNeedV4 as need} from './auth-audit-event-v4.ts';
/** Check before creating a client: credentials must never leave loopback without verified TLS. */
export function requireAuthAuditTransportV4(account:ClientConfig){
 need(account&&!account.connectionString&&typeof account.host==='string'&&account.host.length>0&&typeof account.user==='string'&&account.user.length>0&&typeof account.database==='string'&&account.database.length>0&&Number.isInteger(account.port)&&account.port!>0&&account.port!<=65535,'AUTH_AUDIT_EXPLICIT_ACCOUNT');
 need(['127.0.0.1','localhost','::1'].includes(account.host!)||account.ssl&&typeof account.ssl==='object'&&account.ssl.rejectUnauthorized!==false,'AUTH_AUDIT_VERIFIED_TLS_REQUIRED');
}
