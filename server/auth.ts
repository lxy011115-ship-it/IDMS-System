import {reserveResponse} from './request-capacity.ts';
import {MemoryAuthStore,opaqueId,validId,sessionLifetime,pendingLifetime,type AuthStateStore,type Identity,type Session,type Tokens} from './auth-state.ts';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { DomainError } from './service.ts';
import { actor } from './audit.ts';
import { permissionsFor, requiredScope, scopeClaimsFromPayload, type AccessContext } from './access.ts';

export interface AuthConfig { mode: 'demo' | 'oidc'; issuer?: string; audience?: string; clientId?: string; clientSecret?: string; origin?: string }
const opaque=opaqueId;
function cookie(req: IncomingMessage, name: string) {
  const values=(req.headers.cookie||'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(name+'='));
  if(values.length>1)throw new DomainError(401,'登录Cookie重复或无效');return values[0]?.slice(name.length+1)||'';
}
function json(res: ServerResponse, data: unknown) {
  if(res.destroyed||res.writableEnded)return;const text=JSON.stringify(data);reserveResponse(Buffer.byteLength(text));res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(text);
}
function redirect(res: ServerResponse, url: string, cookies?: string[]) {
  res.writeHead(303, { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookies ? { 'set-cookie': cookies } : {}) }); res.end();
}
function safePath(path: string | null) { return path && path.length<=2048 && /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/.test(path) && !path.startsWith('/api/') ? path : '/?view=predictive'; }
export function authConfigFromEnv(): AuthConfig {
  const mode = process.env.IDMS_AUTH_MODE || 'demo';
  if (!['demo', 'oidc'].includes(mode)) throw Error('Invalid authentication mode');
  return { mode: mode as AuthConfig['mode'], issuer: process.env.IDMS_OIDC_ISSUER, audience: process.env.IDMS_OIDC_AUDIENCE || 'idms-api', clientId: process.env.IDMS_OIDC_CLIENT_ID || 'idms-web', clientSecret: process.env.IDMS_OIDC_CLIENT_SECRET, origin: process.env.IDMS_PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 4010}` };
}
export function createAuth(config: AuthConfig, record?: (who: AccessContext, action: string) => Promise<void>,authState:AuthStateStore=new MemoryAuthStore()) {
  let issuer: URL | undefined, origin: URL | undefined;
  if (config.mode === 'oidc') {
    if (!config.issuer || !config.audience || !config.clientId || !config.origin) throw Error('OIDC configuration is incomplete');
    issuer = new URL(config.issuer); origin = new URL(config.origin);
    for (const url of [issuer, origin]) {
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('OIDC requires HTTPS outside loopback development');
    }
    if (origin.pathname !== '/' || config.issuer.endsWith('/')) throw Error('OIDC issuer/origin is not canonical');
  }
  const remoteKeys = issuer ? createRemoteJWKSet(new URL(issuer.href + '/protocol/openid-connect/certs'), { timeoutDuration: 5000, cooldownDuration: 1000 }) : undefined;
  const secure = origin?.protocol === 'https:' ? '; Secure' : '';
  const setCookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure}`;
  const endpoint = (suffix: string) => config.issuer + '/protocol/openid-connect/' + suffix;
  function identity(payload: JWTPayload): Identity {
    if (payload.typ !== 'Bearer' || payload.azp !== config.clientId) throw new DomainError(401, '令牌类型或调用客户端不匹配');
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 30) throw new DomainError(401, '登录令牌缺少有效身份或时间');
    if (typeof payload.tenant_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(payload.tenant_id)) throw new DomainError(403, '账号缺少受信任的企业声明');
    // Only the server-managed realm roles are trusted. Request headers and user profile text never grant permissions.
    const realm = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realm?.roles) ? realm.roles.filter((r): r is string => typeof r === 'string') : [];
    const permissions = permissionsFor(roles);
    if (!permissions.includes('read') || payload.preferred_username?.toString().startsWith('service-account-')) throw new DomainError(403, '该账号没有本平台用户权限');
    const scope=scopeClaimsFromPayload(payload as Record<string,unknown>), required=requiredScope(roles);
    if(['SITE','LINE','OWN_TASKS'].includes(required)&&!scope.provided) throw new DomainError(403,'账号缺少管理员分配的数据范围');
    return { tenantId: payload.tenant_id, actorId: payload.sub, actorType: 'USER', correlationId: '', authMode: 'oidc', roles, permissions, scope, username: typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub, name: typeof payload.name === 'string' ? payload.name : String(payload.preferred_username || payload.sub) };
  }
  async function verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, remoteKeys!, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
      return { identity: identity(payload), expiresAt: payload.exp! * 1000 };
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(401, '登录令牌无效或已过期'); }
  }
  async function tokenRequest(params: URLSearchParams): Promise<Tokens> {
    params.set('client_id', config.clientId!); if (config.clientSecret) params.set('client_secret', config.clientSecret);
    try {
      const response = await fetch(endpoint('token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(7000), redirect: 'error' });
      if (!response.ok) throw Error('exchange rejected');
      const reader=response.body?.getReader();if(!reader)throw Error('missing token response');let total=0;const buffers:Buffer[]=[];
      while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>262144){await reader.cancel();throw Error('token response exceeds limit');}buffers.push(Buffer.from(part.value));}
      const tokens=JSON.parse(Buffer.concat(buffers).toString('utf8')) as Tokens;
      if (typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>32768||(['refresh_token','id_token'] as const).some(k=>tokens[k]!==undefined&&(typeof tokens[k]!=='string'||!tokens[k]||tokens[k]!.length>65536)))throw Error('invalid token response');
      return tokens;
    } catch { throw new DomainError(401, '登录或会话续期失败，请重新登录'); }
  }
  async function sessionFor(req: IncomingMessage) {
    const key=cookie(req,'idms_session');if(!validId(key))return;
    const result=await authState.withSession<{session?:Session;error?:unknown}>(key,async session=>{
      try{
        if(session.createdAt+sessionLifetime<=Date.now())return {remove:true,value:{}};
        let tokens=session.tokens,changed=false;
        if(session.expiresAt<Date.now()+15000){
          if(!tokens.refresh_token)throw new DomainError(401,'会话已过期，请重新登录');
          const fresh=await tokenRequest(new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh_token}));tokens={...fresh,refresh_token:fresh.refresh_token||tokens.refresh_token,id_token:fresh.id_token||tokens.id_token};changed=true;
        }
        const checked=await verify(tokens.access_token);
        if(checked.identity.actorId!==session.identity.actorId||checked.identity.tenantId!==session.identity.tenantId)throw new DomainError(401,'会话身份已变化，请重新登录');
        const next:Session={...session,...checked,tokens};return {value:{session:next},...(changed?{session:next}:{})};
      }catch(error){return {remove:true,value:{error}};}
    });
    if(result?.error)throw result.error;return result?.session;
  }
  function checkCsrf(req:IncomingMessage,session:Session){const csrf=String(req.headers['x-csrf-token']||'');if(Buffer.byteLength(csrf)!==Buffer.byteLength(session.csrf)||!timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrf)))throw new DomainError(403,'请求防伪校验失败');}
  function checkOrigin(req: IncomingMessage) { if (req.headers.origin !== origin!.origin) throw new DomainError(403, '请求来源校验失败'); }
  async function context(req: IncomingMessage): Promise<AccessContext> {
    if (config.mode === 'demo') return { tenantId: String(req.headers['x-tenant-id'] || ''), ...actor(req.headers), correlationId: String(req.headers['x-correlation-id'] || opaque()), authMode: 'demo' };
    const authorization = req.headers.authorization;
    let who: Identity;
    if (authorization) {
      if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 32768) throw new DomainError(401, '授权头无效');
      who = (await verify(authorization.slice(7))).identity;
    } else {
      const session = await sessionFor(req);
      if (!session) throw new DomainError(401, '请先登录 IDMS');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
        checkOrigin(req);
        checkCsrf(req,session);
      }
      who = session.identity;
    }
    if (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== who.tenantId) throw new DomainError(403, '请求企业与登录身份不一致');
    return { ...who, correlationId: String(req.headers['x-correlation-id'] || opaque()) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith('/api/v1/auth/')) return false;
    if (url.pathname === '/api/v1/auth/session' && req.method === 'GET') {
      const session = config.mode === 'oidc' ? await sessionFor(req) : undefined;
      json(res, { mode: config.mode, authenticated: !!session, ...(session ? { user: session.identity, csrfToken: session.csrf, expiresAt: session.expiresAt } : {}) }); return true;
    }
    if (config.mode !== 'oidc') throw new DomainError(404, '演示模式不提供真实登录');
    if (url.pathname === '/api/v1/auth/login' && req.method === 'GET') {
      if (req.headers.host !== origin!.host) { redirect(res, origin!.origin + url.pathname + url.search); return true; }
      const state = opaque(), verifier = opaque(), nonce = opaque();
      await authState.putAttempt(state, { verifier, nonce, returnTo: safePath(url.searchParams.get('returnTo')), expires: Date.now() + pendingLifetime });
      const target = new URL(endpoint('auth'));
      target.search = new URLSearchParams({ client_id: config.clientId!, response_type: 'code', scope: 'openid profile', redirect_uri: origin!.origin + '/api/v1/auth/callback', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      redirect(res, target.href, [setCookie('idms_login', state, 300)]); return true;
    }
    if (url.pathname === '/api/v1/auth/callback' && req.method === 'GET') {
      const state=url.searchParams.get('state')||'';
      if(!validId(state)||cookie(req,'idms_login')!==state||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length>1||(url.searchParams.has('iss')&&url.searchParams.get('iss')!==config.issuer))throw new DomainError(401,'登录请求已失效，请返回系统重新登录');
      const attempt=await authState.takeAttempt(state);
      if(!attempt||attempt.expires<Date.now()||url.searchParams.has('error'))throw new DomainError(401,'登录请求已失效，请返回系统重新登录');
      const code = url.searchParams.get('code'); if (!code || code.length > 4096) throw new DomainError(401, '登录授权无效');
      const tokens = await tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: origin!.origin + '/api/v1/auth/callback', code_verifier: attempt.verifier }));
      if (!tokens.id_token) throw new DomainError(401, '登录缺少身份令牌');
      try {
        const id = await jwtVerify(tokens.id_token, remoteKeys!, { issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'] });
        const checked = await verify(tokens.access_token);
        if (id.payload.nonce !== attempt.nonce || id.payload.sub !== checked.identity.actorId) throw Error('identity binding');
        await record?.(checked.identity, 'AUTH_LOGIN');
        const key=opaque(),old=cookie(req,'idms_session');await authState.createSession(key,{...checked,tokens,createdAt:Date.now(),csrf:opaque()},old);
        redirect(res, attempt.returnTo, [setCookie('idms_session', key, sessionLifetime / 1000), setCookie('idms_login', '', 0)]); return true;
      } catch(error) {if(error instanceof DomainError&&[429,503].includes(error.status))throw error;throw new DomainError(401, '登录身份校验失败'); }
    }
    if (url.pathname === '/api/v1/auth/logout' && req.method === 'POST') {
      checkOrigin(req);const session=await authState.withSession(cookie(req,'idms_session'),async value=>{checkCsrf(req,value);return {remove:true,value};});if(!session)throw new DomainError(401,'会话已结束');
      res.setHeader('set-cookie',setCookie('idms_session','',0));let auditFailed=false;try{await record?.(session.identity,'AUTH_LOGOUT');}catch{auditFailed=true;}
      // End the local session even if upstream logout is temporarily unavailable; never restore an old session.
      if (session.tokens.refresh_token) try {
        const params = new URLSearchParams({ client_id: config.clientId!, refresh_token: session.tokens.refresh_token });
        if (config.clientSecret) params.set('client_secret', config.clientSecret);
        await fetch(endpoint('logout'), { method: 'POST', body: params, signal: AbortSignal.timeout(5000), redirect: 'error' });
      } catch { /* local logout remains effective */ }
      if(auditFailed)throw new DomainError(503,'会话已撤销，退出审计尚未确认');json(res,{loggedOut:true});return true;
    }
    throw new DomainError(404, '登录接口不存在');
  }
  return { mode: config.mode, storage:authState.mode,auditCursors:authState.auditCursors,context,handle,verify,close:()=>authState.close() };
}
