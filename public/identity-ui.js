const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function loginView(error = '', checking = false) {
  return `<main class="login-screen"><section class="panel login-card"><div class="brand"><div class="brand-mark">⌁</div><div><strong>IDMS</strong><span>设备智能管理与预测维护</span></div></div><h1>${checking?'正在核对登录状态':'登录企业工作台'}</h1><p>真实身份登录 · 企业隔离 · 独立人工终审</p>${error?`<p role="alert" class="error-banner">${esc(error)}</p>`:''}${checking?'<p>请稍候…</p>':`<a class="primary login-link" href="/api/v1/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}" data-testid="oidc-login">使用企业账号登录</a><p class="boundary-note">首次登录需修改临时密码。本机初始账号保存在受限权限的 .local/本机登录账户.txt；不要将账户文件对外分享。</p><button class="secondary" data-action="refresh">重试连接</button>`}<small>本机开发版；工程规则不是经过现场验证的故障预测。设备只读，不下发控制指令。</small></section></main>`;
}
export function identityBadge(user) {
  return `<div class="verified-identity" data-testid="verified-identity"><b title="${esc(user.name || user.username)}">${esc(user.name || user.username)}</b><small title="${esc(user.username)} · 企业 ${esc(user.tenantId)}">${esc(user.username)} · 企业 ${esc(user.tenantId)}</small><button class="secondary" data-action="logout">退出登录</button></div>`;
}
