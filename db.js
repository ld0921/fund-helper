// ═══════════════ IndexedDB 数据持久化封装 ═══════════════
const FundDB = (function(){
  const DB_NAME = 'FundHelperDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'appData';
  const DATA_KEYS = ['funds','holdings','existingHoldings','dcaPlans','navCache'];
  // 需要同步到云端的 key（用户创建的数据，排除可重新拉取的缓存）
  const SYNC_KEYS = ['funds','holdings','existingHoldings','dcaPlans'];

  let _db = null;
  let _syncCallback = null; // 云端同步回调

  function open(){
    if(_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE_NAME)){
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  function get(key){
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    }));
  }

  function set(key, value){
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(value, key);
      req.onsuccess = () => {
        // Record last data change timestamp
        const tx2 = db.transaction(STORE_NAME, 'readwrite');
        tx2.objectStore(STORE_NAME).put(Date.now(), '_lastDataChange');
        resolve();
        // 触发云端同步回调（仅对需要同步的 key）
        if(_syncCallback && SYNC_KEYS.includes(key)){
          try { _syncCallback(key, value); } catch(e){ console.warn('sync callback error:', e); }
        }
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  // 注册云端同步回调
  function onSync(cb){ _syncCallback = cb; }

  function getAll(){
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const result = {};
      const pending = DATA_KEYS.map(key => new Promise(res => {
        const req = store.get(key);
        req.onsuccess = () => { result[key] = req.result || (key==='navCache'?{}:[]); res(); };
        req.onerror = () => { result[key] = key==='navCache'?{}:[]; res(); };
      }));
      Promise.all(pending).then(() => resolve(result));
    }));
  }

  // 获取需要同步的数据（排除缓存）
  function getSyncData(){
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const result = {};
      const pending = SYNC_KEYS.map(key => new Promise(res => {
        const req = store.get(key);
        req.onsuccess = () => { result[key] = req.result || []; res(); };
        req.onerror = () => { result[key] = []; res(); };
      }));
      Promise.all(pending).then(() => resolve(result));
    }));
  }

  function exportAll(){
    return getAll().then(data => {
      data._exportTime = new Date().toISOString();
      data._version = 1;
      const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fund-helper-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // Record last export timestamp
      return set('_lastExport', Date.now());
    });
  }

  function importAll(jsonStr){
    return open().then(db => {
      let data;
      try { data = JSON.parse(jsonStr); } catch(e){ return Promise.reject(new Error('JSON 格式无效')); }
      // Schema 验证：数组字段必须是数组，navCache 必须是对象
      for(const key of DATA_KEYS){
        if(data[key] === undefined) continue;
        if(key === 'navCache'){
          if(typeof data[key] !== 'object' || Array.isArray(data[key])){ return Promise.reject(new Error(`备份数据格式错误：${key} 应为对象`)); }
        } else {
          if(!Array.isArray(data[key])){ return Promise.reject(new Error(`备份数据格式错误：${key} 应为数组`)); }
        }
      }
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const promises = DATA_KEYS.map(key => {
        if(data[key] !== undefined){
          return new Promise((resolve, reject) => {
            const req = store.put(data[key], key);
            req.onsuccess = () => resolve();
            req.onerror = e => reject(e.target.error);
          });
        }
        return Promise.resolve();
      });
      return Promise.all(promises);
    });
  }

  // Migrate from localStorage to IndexedDB (one-time)
  function migrateFromLocalStorage(){
    return open().then(db => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('_migrated');
      return new Promise(resolve => {
        req.onsuccess = () => {
          if(req.result) { resolve(false); return; } // already migrated
          // Check if localStorage has any data
          const hasData = DATA_KEYS.some(k => localStorage.getItem(k));
          if(!hasData){ resolve(false); return; }
          // Migrate each key
          const tx2 = db.transaction(STORE_NAME, 'readwrite');
          const store = tx2.objectStore(STORE_NAME);
          DATA_KEYS.forEach(key => {
            const raw = localStorage.getItem(key);
            if(raw){
              try { store.put(JSON.parse(raw), key); } catch(e){}
            }
          });
          store.put(true, '_migrated');
          tx2.oncomplete = () => resolve(true);
          tx2.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      });
    });
  }

  // Check if backup reminder is needed (>7 days since last export)
  function checkBackupReminder(){
    return Promise.all([get('_lastExport'), get('_lastDataChange')]).then(([lastExport, lastChange]) => {
      if(!lastChange) return false; // no data changes yet
      if(!lastExport) return true;  // never exported
      const daysSince = (Date.now() - lastExport) / (1000*60*60*24);
      return daysSince > 7;
    });
  }

  return { open, get, set, getAll, getSyncData, exportAll, importAll, migrateFromLocalStorage, checkBackupReminder, onSync, DATA_KEYS, SYNC_KEYS };
})();
