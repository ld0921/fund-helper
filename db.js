// ═══════════════ IndexedDB 数据持久化封装 ═══════════════
const FundDB = (function(){
  const DB_NAME = 'FundHelperDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'appData';
  const DATA_KEYS = ['funds','holdings','existingHoldings','dcaPlans','navCache','myHoldingScheme','_takeProfitLog'];
  // 需要同步到云端的 key（用户创建的数据，排除可重新拉取的缓存）
  const SYNC_KEYS = ['funds','holdings','existingHoldings','dcaPlans','myHoldingScheme','_takeProfitLog'];

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

  return { open, get, set, getAll, getSyncData, migrateFromLocalStorage, onSync, get _syncCallback(){ return _syncCallback; }, DATA_KEYS, SYNC_KEYS };
})();
