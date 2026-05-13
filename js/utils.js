// ═══ 工具函数模块 ═══
function _debounce(fn, ms){ let t; return function(){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,arguments), ms); }; }
function autoFadeErrors(){
  setTimeout(()=>{
    document.querySelectorAll('.form-item.has-error').forEach(fi=>fi.classList.remove('has-error'));
  },3000);
}
function showToast(msg, type='info', duration=2500){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast toast-'+type;
  t.textContent=msg;
  c.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('show')));
  setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),300);},duration);
}
// 保存成功微提示
function flashSaved(sectionId){
  const sec=document.getElementById(sectionId);
  if(!sec) return;
  let tick=sec.querySelector('.save-tick');
  if(!tick){
    tick=document.createElement('span');
    tick.className='save-tick';
    tick.textContent='✓ 已保存';
    const title=sec.querySelector('.card-title');
    if(title) title.appendChild(tick);
  }
  // 连续触发时先移除再重新添加，强制重置动画
  tick.classList.remove('show');
  void tick.offsetWidth; // 触发 reflow，确保浏览器识别为两次状态变化
  tick.classList.add('show');
  clearTimeout(tick._fadeTimer);
  tick._fadeTimer = setTimeout(()=>tick.classList.remove('show'),2000);
}
// 日期格式化为中文
function fmtDateCN(dateStr){
  if(!dateStr) return '';
  const d=new Date(dateStr);
  if(isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}
// 基金代码一键复制
function copyCode(code, el){
  if(navigator.clipboard){
    navigator.clipboard.writeText(code).then(()=>showToast(`已复制 ${code}`,'success',1500));
  } else {
    // fallback
    const ta=document.createElement('textarea');
    ta.value=code;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
    showToast(`已复制 ${code}`,'success',1500);
  }
}
function escHtml(s){
  if(typeof s!=='string') return s==null?'':String(s);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stars(n){ return '★'.repeat(n)+'☆'.repeat(5-n); }
function fmtR(v){ if(v==null) return '--'; const c=v>0?'up':v<0?'down':'neutral'; const arrow=v>0?' ▲':v<0?' ▼':''; return `<span class="${c}">${v>0?'+':''}${v}%${arrow}</span>`; }
function openModal(title,defaultVal,cb,bodyHtml){
  _modalCb=cb;
  document.getElementById('modal-title').textContent=title;
  const body=document.getElementById('modal-body');
  if(bodyHtml){ body.innerHTML=bodyHtml; body.style.display='block'; } else { body.style.display='none'; body.innerHTML=''; }
  const inp=document.getElementById('modal-input');
  inp.value=defaultVal||'';
  const mask=document.getElementById('modal-mask');
  mask.style.display='flex';
  requestAnimationFrame(()=>mask.classList.add('show'));
  setTimeout(()=>inp.focus(),200);
}
function closeModal(){
  const mask=document.getElementById('modal-mask');
  mask.classList.remove('show');
  setTimeout(()=>{mask.style.display='none'; document.getElementById('modal-input').value=''; const b=document.getElementById('modal-body'); b.style.display='none'; b.innerHTML='';},200);
  _modalCb=null;
}
function confirmModal(){
  const val=document.getElementById('modal-input').value;
  if(_modalCb) _modalCb(val);
  closeModal();
}
