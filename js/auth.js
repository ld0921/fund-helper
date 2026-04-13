// ═══ 认证与云同步模块 ═══
const _supabaseUrl = 'https://ajkjvknycovlltlawqac.supabase.co';
const _supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqa2p2a255Y292bGx0bGF3cWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyOTY0NDYsImV4cCI6MjA4OTg3MjQ0Nn0.aU6EI3uy3-ghsZVDnbRQcnlsK3eN409hK4ykdXJax6s';
const _supa = window.supabase ? window.supabase.createClient(_supabaseUrl, _supabaseKey) : null;
let _currentUser = null;
let _cloudVersion = 0;
let _authMode = 'login';
let _syncTimer = null;

function showAuthModal(){
  _authMode='login';
  _updateAuthModalUI();
  document.getElementById('auth-error').style.display='none';
  document.getElementById('auth-email').value='';
  document.getElementById('auth-password').value='';
  const mask=document.getElementById('auth-modal');
  mask.style.display='flex';
  requestAnimationFrame(()=>mask.classList.add('show'));
  setTimeout(()=>document.getElementById('auth-email').focus(),200);
}
function hideAuthModal(){
  const mask=document.getElementById('auth-modal');
  mask.classList.remove('show');
  setTimeout(()=>{mask.style.display='none';},200);
}
function skipAuth(){
  hideAuthModal();
  showToast('离线模式：数据仅保存在本地，不会同步到云端','info',4000);
  if(typeof showFirstTimeGuide === 'function') showFirstTimeGuide();
}
function toggleAuthMode(){
  _authMode = _authMode==='login' ? 'register' : 'login';
  _updateAuthModalUI();
  document.getElementById('auth-error').style.display='none';
}
function _updateAuthModalUI(){
  document.getElementById('auth-modal-title').textContent = _authMode==='login' ? '登录账号' : '注册账号';
  document.getElementById('auth-submit-btn').textContent = _authMode==='login' ? '登录' : '注册';
  document.getElementById('auth-toggle-text').textContent = _authMode==='login' ? '没有账号？' : '已有账号？';
  document.getElementById('auth-toggle-link').textContent = _authMode==='login' ? '注册' : '登录';
}
function _showAuthError(msg){
  const el=document.getElementById('auth-error');
  el.textContent=msg; el.style.display='block';
}

async function submitAuth(){
  if(!_supa){ _showAuthError('云端服务未加载，请刷新页面'); return; }
  const email=document.getElementById('auth-email').value.trim();
  const password=document.getElementById('auth-password').value;
  if(!email||!password){ _showAuthError('请输入邮箱和密码'); return; }
  if(password.length<6){ _showAuthError('密码至少6位'); return; }
  const btn=document.getElementById('auth-submit-btn');
  btn.disabled=true; btn.textContent='处理中…';
  document.getElementById('auth-error').style.display='none';
  try {
    let result;
    if(_authMode==='register'){
      result = await _supa.auth.signUp({ email, password });
      if(result.error) throw result.error;
      if(result.data?.user?.identities?.length===0){ _showAuthError('该邮箱已注册，请切换到登录'); btn.disabled=false; btn.textContent='注册'; return; }
      if(!result.data.session){ _showAuthError('注册成功！请到邮箱点击确认链接后再登录（若无需确认请刷新页面）'); btn.disabled=false; btn.textContent='注册'; return; }
      showToast('注册成功，已自动登录','success');
    } else {
      result = await _supa.auth.signInWithPassword({ email, password });
      if(result.error){
        const msg = result.error.message || '';
        if(msg.includes('Invalid login')) throw new Error('邮箱或密码错误');
        if(msg.includes('Email not confirmed')) throw new Error('邮箱未确认，请检查收件箱或联系管理员');
        throw result.error;
      }
    }
    if(!result.data?.user) throw new Error('登录失败，请重试');
    _currentUser = result.data.user;
    hideAuthModal();
    updateAuthUI();
    if(typeof showFirstTimeGuide === 'function') showFirstTimeGuide();
    await pullFromCloud();
    const localData = await FundDB.getSyncData();
    const hasLocalData = localData.funds?.length || localData.holdings?.length || localData.existingHoldings?.length || localData.dcaPlans?.length;
    if(hasLocalData && _cloudVersion === 0){
      if(confirm('检测到本地已有数据，是否将数据同步到云端账号？')){ await pushToCloud(); }
    }
    FundDB.onSync(_debounce(pushToCloud, 2000));
  } catch(e){
    let errMsg = e.message || '操作失败，请重试';
    if(errMsg.includes('fetch')) errMsg = '网络连接失败，请检查网络后重试';
    else if(errMsg.includes('timeout') || errMsg.includes('Timeout')) errMsg = '请求超时，请稍后重试';
    else if(errMsg.includes('rate limit') || errMsg.includes('429')) errMsg = '操作太频繁，请稍后再试';
    else if(errMsg.includes('User already registered')) errMsg = '该邮箱已注册，请切换到登录';
    else if(errMsg.includes('Network')) errMsg = '网络异常，请检查网络连接';
    _showAuthError(errMsg);
  } finally {
    btn.disabled=false;
    btn.textContent = _authMode==='login' ? '登录' : '注册';
  }
}

async function resetPassword(){
  if(!_supa){ _showAuthError('云端服务未加载'); return; }
  const email=document.getElementById('auth-email').value.trim();
  if(!email){ _showAuthError('请先在邮箱框填写你的注册邮箱'); return; }
  try {
    const {error} = await _supa.auth.resetPasswordForEmail(email);
    if(error) throw error;
    document.getElementById('auth-error').style.display='none';
    showToast('密码重置邮件已发送，请查收邮箱','success',5000);
  } catch(e){ _showAuthError('发送失败: '+(e.message||'请稍后重试')); }
}

async function authLogout(){
  if(!_supa) return;
  await _supa.auth.signOut();
  _currentUser = null; _cloudVersion = 0;
  FundDB.onSync(null);
  updateAuthUI();
  showToast('已退出登录','info');
  showAuthModal();
}

function updateAuthUI(){
  const area = document.getElementById('auth-area');
  if(!area) return;
  if(_currentUser){
    const email = _currentUser.email || '';
    area.innerHTML = `
      <div style="cursor:pointer;-webkit-tap-highlight-color:transparent;position:relative" onclick="event.stopPropagation();toggleUserMenu()">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,.2),rgba(255,255,255,.1));display:flex;align-items:center;justify-content:center;font-size:18px;border:2px solid rgba(255,255,255,.3);box-shadow:0 2px 8px rgba(0,0,0,.15);transition:all .2s" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">👤</div>
        <span id="sync-status-dot" style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:#52c41a;border:2px solid #0050d0;box-shadow:0 0 0 2px rgba(82,196,26,.2)" title="已同步"></span>
      </div>
      <div id="user-menu" style="display:none;position:absolute;right:0;top:100%;margin-top:8px;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:12px 16px;min-width:200px;z-index:200" onclick="event.stopPropagation()">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">👤 账号信息</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;word-break:break-all">${escHtml(email)}</div>
        <div style="border-top:1px solid var(--border);padding-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="authLogout()" style="width:100%;font-size:12px;justify-content:center">退出登录</button>
        </div>
      </div>`;
  } else {
    area.innerHTML = `<button class="btn btn-sm" onclick="showAuthModal()" style="background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.25);font-size:13px;padding:6px 16px;border-radius:18px;font-weight:600;transition:all .2s" onmouseover="this.style.background='rgba(255,255,255,.25)'" onmouseout="this.style.background='rgba(255,255,255,.15)'">登录</button>`;
  }
}

function updateSyncStatus(status){
  const dot = document.getElementById('sync-status-dot');
  if(!dot) return;
  const colors = {synced:'#52c41a', syncing:'#faad14', error:'#ff4d4f', offline:'#8c8c8c'};
  const titles = {synced:'已同步', syncing:'同步中…', error:'同步失败', offline:'离线'};
  dot.style.background = colors[status] || '#8c8c8c';
  dot.title = titles[status] || '';
}

function toggleUserMenu(){
  const menu=document.getElementById('user-menu');
  if(menu) menu.style.display=menu.style.display==='none'?'block':'none';
}
document.addEventListener('click',function(e){
  const menu=document.getElementById('user-menu');
  if(menu && menu.style.display!=='none' && !e.target.closest('#auth-area')) menu.style.display='none';
});

async function pushToCloud(){
  if(!_currentUser || !_supa) return;
  if(!navigator.onLine){ localStorage.setItem('_syncPending','1'); updateSyncStatus('offline'); return; }
  updateSyncStatus('syncing');
  try {
    const data = await FundDB.getSyncData();
    const newVersion = _cloudVersion + 1;
    const payload = { user_id: _currentUser.id, data, updated_at: new Date().toISOString(), version: newVersion };
    const { data: existing } = await _supa.from('user_data').select('user_id').eq('user_id', _currentUser.id).single();
    let error;
    if(existing){
      ({ error } = await _supa.from('user_data').update({ data, updated_at: payload.updated_at, version: newVersion }).eq('user_id', _currentUser.id));
    } else {
      ({ error } = await _supa.from('user_data').insert(payload));
    }
    if(error) throw error;
    _cloudVersion = newVersion;
    localStorage.removeItem('_syncPending');
    updateSyncStatus('synced');
  } catch(e){
    console.error('pushToCloud failed:', e);
    localStorage.setItem('_syncPending','1');
    updateSyncStatus('error');
    showToast('云端同步失败: ' + (e.message||e.code||'未知错误'), 'error', 5000);
  }
}

async function pullFromCloud(){
  if(!_currentUser || !_supa || !navigator.onLine) return;
  try {
    const { data: row, error } = await _supa.from('user_data').select('data, version, updated_at').eq('user_id', _currentUser.id).single();
    if(error && error.code !== 'PGRST116') throw error;
    if(!row){ _cloudVersion = 0; return; }
    if(row.version > _cloudVersion){
      if(_cloudVersion === 0){ await applyCloudData(row.data, row.version); return; }
      const localTs = await FundDB.get('_lastDataChange');
      const cloudTs = new Date(row.updated_at).getTime();
      if(localTs && localTs > cloudTs){
        const useCloud = confirm('检测到本地数据和云端数据都有更新。\n点击「确定」使用云端数据，点击「取消」保留本地数据并覆盖云端。');
        if(useCloud){ await applyCloudData(row.data, row.version); } else { await pushToCloud(); }
      } else { await applyCloudData(row.data, row.version); }
    } else { _cloudVersion = row.version; }
  } catch(e){
    console.error('pullFromCloud failed:', e);
    showToast('云端数据拉取失败: '+(e.message||''), 'error', 3000);
  }
}

async function applyCloudData(cloudData, version){
  if(!cloudData) return;
  const savedCb = FundDB._syncCallback;
  FundDB.onSync(null);
  for(const key of FundDB.SYNC_KEYS){
    if(cloudData[key] !== undefined) await FundDB.set(key, cloudData[key]);
  }
  FundDB.onSync(savedCb);
  const data = await FundDB.getAll();
  funds = data.funds || [];
  holdings = data.holdings || [];
  existingHoldings = data.existingHoldings || [];
  dcaPlans = data.dcaPlans || [];
  navCache = data.navCache || {};
  _cloudVersion = version;
  renderAll();
  showToast('已从云端同步最新数据','success');
}

window.addEventListener('offline', ()=>{
  if(_currentUser) updateSyncStatus('offline');
  showToast('网络已断开，数据暂存本地，联网后自动同步','error',4000);
});
window.addEventListener('online', ()=>{
  showToast('网络已恢复，正在同步…','success',2000);
  if(_currentUser){
    if(localStorage.getItem('_syncPending')) pushToCloud();
    pullFromCloud();
    updateSyncStatus('synced');
  }
});
