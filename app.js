// SchooMy 明るさ比較システム v4.2
// 3モードのタブ切替 (📈マイ波形 / 🔲グリッド / 🔀重ね合わせ)
// 計測と全体表示が独立。共有してもモード遷移しない (手動切替)。
// Firebase は常時購読 — 計測していない先生もモード2/3で全体を見られる。
//
// v4.2 変更点:
//   - 重ね合わせモードの X軸正規化 (各自 0秒スタート)
//     原因: 元データ p.e は「各自の接続起点からの経過秒」なので、人によって
//     340秒台と 0秒台で大きくズレ、X軸の直近10秒スライドだとデータ点が
//     全て描画範囲外に落ちて「線が出ない」状態になっていた。
//     対策: computeOverlayDatasets で dataset ごとに最小 e を引いて
//     0 始まりに正規化。updateOverlayChart は X軸スライドを廃止し、
//     min=0, max=Math.max(60, xMax) の全期間表示に変更。
//     (v3.3 で決定の「波形の形を比較する」仕様に立ち返り)
//
// v4.1 変更点:
//   - 重ね合わせモードの描画修正
//     原因: 親 #overlayPanel が display:none → 表示直後の同期タイミングで
//     new Chart() が走るため、Chart.js が親サイズを 0×0 と測ってしまい
//     キャンバスのビットマップが 0×0 のまま固定。以降 update() しても
//     0×0 に描画され続け何も見えなかった。
//     対策: 生成前に強制 reflow を起こし、生成後と setMode('overlay')
//     直後の rAF で chart.resize() を呼んで親サイズを再採取する。
//
// v4.0 変更点:
//   - 3モード切替: my-wave / grid / overlay
//   - 共有してもモード自動遷移しない (トースト通知で誘導)
//   - Firebase 常時購読 (個人モード中も他人データを保持)
//   - studentId を sessionStorage に変更 (2タブテスト = 2ユーザー成立)
//   - 自分のデータも sharedStudents に含む (filter しない) — 自セルが見える
//   - グリッドモード: 6面まで 2x3 グリッド (各セルにミニチャート)
//   - 重ね合わせモード: 共有中全員の波形を1グラフに重ねる
//   - 詳細表示: グリッドセルタップで全画面1人波形 (✕で戻る)
//
// 描画方針 (v3.5 維持):
//   - シリアル受信 → rawBuffer → 移動平均 → 50ms throttle で localHistory に push
//   - requestAnimationFrame ループ内で 50ms throttle 描画
//   - Chart.js インスタンスは destroy せず使い回し (グリッドはセルごと)
//   - tension 0.4 + cubicInterpolationMode 'monotone' でなめらか
//
// v3.4 変更点:
//   - X軸: 接続中は直近10秒スライド (波形が画面いっぱいに見える)
//   - Y軸: 0 固定 + max を実データに自動追従、5秒猶予のヒステリシス
//   - 記録レビューモード追加: 切断後も localHistory を保持し全範囲表示
//   - レビュー専用ボタン [🔄 やり直す] [⬇ CSV] [🔌 再接続] を追加
//   - グラフタイトルがモード別に動的変化
//
// v3.3 変更点 (WAVE LAB 準拠):
//   - X軸を絶対時刻 → 経過時間(秒) ベースに変更
//   - 接続開始時刻 connectStartedAt を起点にした e (経過秒) を各点に保存
//   - 共有モーダルを「名前 + 場所」の2項目に
//   - Firebase スキーマに place / startedAt を追加
// 授業利用シナリオ:
//   教室A 14:00 接続 → 経過 0秒〜
//   教室B 14:05 接続 → 経過 0秒〜
//   両者が共有中なら画面上は両方とも「直近10秒」の範囲に重なる

// =============== Firebase ===============
const FIREBASE_CONFIG={apiKey:"AIzaSyAJsJ2gLDgAuvfowjuaRwz9HBLm1s05IP4",authDomain:"schoomy-sensor.firebaseapp.com",databaseURL:"https://schoomy-sensor-default-rtdb.asia-southeast1.firebasedatabase.app",projectId:"schoomy-sensor",storageBucket:"schoomy-sensor.firebasestorage.app",messagingSenderId:"885079688723",appId:"1:885079688723:web:62e5c1a86206914fe921e6"};
let db=null;
try{firebase.initializeApp(FIREBASE_CONFIG);db=firebase.database()}catch(e){console.warn('Firebase init skipped:',e.message)}

// =============== 定数 ===============
const SESSION_ID='light-class';                 // 共有時は全員ここに集まる
const KEEP_DURATION_MS=60*1000;                  // 60秒保持 (Firebase送信側)
const LIVE_WINDOW_SEC=10;                        // v3.4: ライブ表示の X 軸幅 (秒)
const FB_PUSH_INTERVAL_MS=1000;                  // 1秒ごとに Firebase へ
const MIN_Y_MAX=100;                             // Y軸 max の下限
const Y_HYSTERESIS_MS=5000;                      // v3.4: Y軸max が下がるまでの猶予 (5秒)
// v3.5: スムージング/スロットル定数 (調整しやすいよう冒頭に集約)
const SMOOTHING_WINDOW=10;                       // 移動平均のサンプル数 (5にすると反応速、15にすると滑らか)
const RAW_BUFFER_SIZE=50;                        // 移動平均用 raw 値の保持数
const RENDER_INTERVAL=50;                        // 描画ループの最小間隔 ms (50ms = 20fps)
const HISTORY_PUSH_INTERVAL=50;                  // localHistory への push 最小間隔 ms
const PALETTE=['#E88A0A','#2E8EC4','#c8a030','#5cc8c5','#f5a830','#4aaee0','#a05ec2','#e35c5c','#6dbf6d','#a36df0'];
const MY_COLOR='#3AABA8';

// =============== State ===============
// v4.0: studentId は sessionStorage で per-tab unique にする
//       (同一ブラウザの2タブで別ユーザーとして共有テストできる)
let myId=sessionStorage.getItem('studentId');
if(!myId){myId=crypto.randomUUID();sessionStorage.setItem('studentId',myId)}
let myName=localStorage.getItem('myName')||'';
let myPlace=localStorage.getItem('myPlace')||'';
let myMemo='';

// v4.0: 現在表示モード
let currentMode = localStorage.getItem('viewMode') || 'my-wave';
const VALID_MODES = new Set(['my-wave','grid','overlay']);
if(!VALID_MODES.has(currentMode)) currentMode='my-wave';

let connected=false;
let shared=false;
let demoMode=false;
let serialPort=null, serialReader=null;
let demoIntervals=[];
let demoRestoreName=null;

let connectStartedAt=null;  // v3.3: 接続開始の絶対時刻 (経過秒の起点)
let localHistory=[];        // [{e, v}] 直近 60秒分 (e = 接続からの経過秒)
let latestValue=null;
let pushInterval=null;      // 共有モード時の FB 書き込みタイマー

// v3.5: スムージング/スロットル用
let rawBuffer=[];           // 受信した raw 値のリングバッファ (移動平均用)
let lastPushAt=0;           // 最後に localHistory へ push した時刻
let lastRenderAt=0;         // 最後に updateChart を回した時刻

// v3.4: 記録レビューモード
let reviewMode=false;       // 切断後 localHistory を保持して全範囲表示
let reviewEndElapsed=0;     // レビュー時の X 軸最大値 (秒)

// v3.4: Y 軸 max ヒステリシス (5秒猶予)
let yMaxObservedValue=0;
let yMaxObservedTime=0;

let sharedStudents={};          // {studentId: {name, memo, recent, updatedAt}}
let focusedId=null;         // 詳細表示中の id (null = 全員表示)

let studentsRef=null, notesRef=null;
let othersSubscribed=false; // v3.2: 観覧モード = 起動時に他人購読を常時開始
let onDisconnectRef=null;   // v3.2: ブラウザ閉じ自動削除のハンドラ
let lineChart=null;

// グループ色マップ
const colorMap={};
let colorIdx=0;
function colorFor(id){if(!colorMap[id]){colorMap[id]=PALETTE[colorIdx%PALETTE.length];colorIdx++}return colorMap[id]}

// =============== Util ===============
function $(id){return document.getElementById(id)}
function escapeHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function setStatusPill(label, live){
  const pill=$('statusPill');
  pill.classList.toggle('live',live);
  pill.querySelector('.pulse').classList.toggle('live',live);
  $('statusText').textContent=label;
}

// v3.2: モードバッジ (観覧中 / 個人モード / 共有中 / v3.4: 記録レビュー)
function updateModeBadge(){
  const badge=$('modeBadge');
  if(!badge) return;
  badge.classList.remove('viewing','personal','sharing','review');
  if(reviewMode){
    badge.textContent='📼 記録レビュー';
    badge.classList.add('review');
  } else if(shared || demoMode){
    badge.textContent='共有中';
    badge.classList.add('sharing');
  } else if(connected){
    badge.textContent='個人モード';
    badge.classList.add('personal');
  } else {
    badge.textContent='観覧中';
    badge.classList.add('viewing');
  }
}

// v3.4: モード別グラフタイトル
function updateChartTitle(){
  let title;
  if(focusedId){
    let name, place;
    if(focusedId===myId){ name=myName||'自分'; place=myPlace; }
    else { name=sharedStudents[focusedId]?.name||'名前なし'; place=sharedStudents[focusedId]?.place||sharedStudents[focusedId]?.memo||''; }
    title = place ? `時系列グラフ — ${name} (${place}) の波形` : `時系列グラフ — ${name} の波形`;
  } else if(reviewMode){
    const dur = Math.max(0, reviewEndElapsed).toFixed(0);
    title = `時系列グラフ — 記録レビュー (全 ${dur}秒)`;
  } else if(shared || demoMode){
    title = '時系列グラフ — リアルタイム (全員)';
  } else if(connected){
    title = '時系列グラフ — リアルタイム (直近10秒)';
  } else {
    title = (Object.keys(sharedStudents).length>0) ? '時系列グラフ — みんなの波形 (観覧中)' : '時系列グラフ — 自分の明るさ波形';
  }
  $('lineChartTitle').textContent = title;
}
// v3.3: 経過秒 (現在の自分の接続開始からの秒数)。未接続時は 0。
function currentElapsed(){
  if(connectStartedAt===null) return 0;
  return (Date.now() - connectStartedAt) / 1000;
}
// v3.3: 直近 KEEP_DURATION (60秒) より古い点を捨てる (e ベース)
// v3.4: レビュー中は trim しない (全記録を保持)
function trimToWindow(arr){
  if(reviewMode) return;
  const cutoff = currentElapsed() - (KEEP_DURATION_MS/1000) - 5;
  while(arr.length>0 && arr[0].e<cutoff) arr.shift();
}
// v3.4: チャート X軸の表示範囲
// - レビューモード: [0, 記録の最終 elapsed] (全範囲)
// - 接続中 / 観覧中: 直近 LIVE_WINDOW_SEC (10秒) スライド
// - elapsed <= 10 のときは [0, 10] 固定 (左端に空白を作らない)
function chartXRange(){
  if(reviewMode){
    return {xMin: 0, xMax: Math.max(LIVE_WINDOW_SEC, reviewEndElapsed)};
  }
  let maxE = currentElapsed();
  for(const o of Object.values(sharedStudents)){
    if(o && Array.isArray(o.recent) && o.recent.length){
      const last = o.recent[o.recent.length-1].e || 0;
      if(last > maxE) maxE = last;
    }
  }
  if(maxE <= LIVE_WINDOW_SEC) return {xMin: 0, xMax: LIVE_WINDOW_SEC};
  return {xMin: maxE - LIVE_WINDOW_SEC, xMax: maxE};
}

// v3.4: Y軸 max を実データから決定。下がるときは5秒猶予 (ヒステリシス)
function computeYMax(datasets){
  let maxV = 0;
  for(const ds of datasets){
    for(const pt of ds.data){
      if(pt.y > maxV) maxV = pt.y;
    }
  }
  const now = Date.now();
  if(reviewMode){
    // レビューはデータが変わらないのでヒステリシス不要、即時計算
    return Math.max(MIN_Y_MAX, Math.ceil(maxV * 1.2));
  }
  if(maxV >= yMaxObservedValue){
    // 上昇は即時反映
    yMaxObservedValue = maxV;
    yMaxObservedTime = now;
  } else if(now - yMaxObservedTime > Y_HYSTERESIS_MS){
    // 5秒以上経って下回ったので、現在の max を採用 (緩やかに縮小)
    yMaxObservedValue = maxV;
    yMaxObservedTime = now;
  }
  return Math.max(MIN_Y_MAX, Math.ceil(yMaxObservedValue * 1.2));
}
function updateClock(){$('clock').textContent=new Date().toLocaleTimeString('ja-JP')}
setInterval(updateClock,1000);updateClock();

// v4.0: トースト通知 (3秒で消える)
let toastHideTimer=null;
function showToast(msg){
  const t=$('toast');
  if(!t) return;
  t.textContent=msg;
  t.style.display='block';
  if(toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer=setTimeout(()=>{ t.style.display='none'; }, 3500);
}

// v4.0: モード切替
function setMode(mode){
  if(!VALID_MODES.has(mode)) return;
  currentMode=mode;
  try{ localStorage.setItem('viewMode', mode); }catch(e){}
  document.querySelectorAll('.mode-tab').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  if(mode==='my-wave') $('viewMyWave').classList.add('active');
  else if(mode==='grid') $('viewGrid').classList.add('active');
  else if(mode==='overlay') $('viewOverlay').classList.add('active');
  // モード切替直後に即時描画 (rAF まで待たない)
  drawForCurrentMode(true);
  // v4.1: 重ね合わせは親が display:none → block への遷移直後だと Chart.js が
  // 親サイズを正しく取れず 0×0 のまま固定されることがある。次フレームで
  // 必ず resize を呼んで親サイズを再採取する。
  if(mode==='overlay'){
    requestAnimationFrame(()=>{ try{ overlayChart && overlayChart.resize(); }catch(e){} });
  }
}

// v4.0: 共有人数バッジ更新
function updateShareCounts(){
  const n=Object.keys(sharedStudents).length;
  $('gridCount').textContent=n;
  $('overlayCount').textContent=n;
}

// v4.0: グリッドモード描画
const gridCharts={}; // {studentId: Chart instance}
function renderGrid(){
  const container=$('gridCards');
  const empty=$('gridEmpty');
  const entries=Object.entries(sharedStudents);
  if(entries.length===0){
    if(empty) empty.style.display='';
    container.innerHTML='';
    // 残ったチャートを掃除
    for(const id of Object.keys(gridCharts)){
      try{ gridCharts[id].destroy(); }catch(e){}
      delete gridCharts[id];
    }
    return;
  }
  if(empty) empty.style.display='none';

  // 既存セルの id を取得して、消えた人を除去
  const liveIds = new Set(entries.map(([id])=>id));
  for(const id of Object.keys(gridCharts)){
    if(!liveIds.has(id)){
      try{ gridCharts[id].destroy(); }catch(e){}
      delete gridCharts[id];
      const oldCell=document.querySelector(`.grid-cell[data-id="${id}"]`);
      if(oldCell) oldCell.remove();
    }
  }

  for(const [id, o] of entries){
    const c = (id===myId) ? MY_COLOR : colorFor(id);
    let cell=document.querySelector(`.grid-cell[data-id="${id}"]`);
    if(!cell){
      cell=document.createElement('div');
      cell.className='grid-cell' + (id===myId?' is-me':'');
      cell.dataset.id=id;
      cell.style.setProperty('--cell-color', c);
      cell.innerHTML=`
        <div class="gc-top">
          <div class="gc-name">${escapeHtml(o.name||'名前なし')}${id===myId?'<span class="me-tag">自分</span>':''}</div>
          <div class="gc-place">${escapeHtml(o.place||o.memo||'')}</div>
        </div>
        <div class="gc-row">
          <div class="gc-meta">直近値</div>
          <div class="gc-cur"><span class="gc-cur-val">--</span><span class="gc-unit">raw</span></div>
        </div>
        <div class="gc-chart"><canvas></canvas></div>
      `;
      cell.addEventListener('click', ()=>openDetail(id));
      container.appendChild(cell);
    }
    // 値を更新
    cell.querySelector('.gc-name').innerHTML = escapeHtml(o.name||'名前なし') + (id===myId?'<span class="me-tag">自分</span>':'');
    cell.querySelector('.gc-place').textContent = o.place||o.memo||'';
    const last = (Array.isArray(o.recent)&&o.recent.length) ? o.recent[o.recent.length-1].v : '--';
    cell.querySelector('.gc-cur-val').textContent = last;
    // チャート
    let ch=gridCharts[id];
    if(!ch){
      const canvas=cell.querySelector('canvas');
      ch=new Chart(canvas.getContext('2d'),{
        type:'line',
        data:{datasets:[{data:[],borderColor:c,backgroundColor:c+'22',borderWidth:2,pointRadius:0,tension:0.4,cubicInterpolationMode:'monotone',fill:false}]},
        options:{
          responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:true,
          plugins:{legend:{display:false},tooltip:{enabled:false}},
          scales:{
            x:{type:'linear',min:0,max:LIVE_WINDOW_SEC,display:false},
            y:{beginAtZero:true,min:0,display:false}
          }
        }
      });
      gridCharts[id]=ch;
    }
    const data=(o.recent||[]).map(p=>({x:p.e,y:p.v}));
    ch.data.datasets[0].data=data;
    ch.data.datasets[0].borderColor=c;
    // X 範囲
    const maxE=data.length?data[data.length-1].x:0;
    if(maxE<=LIVE_WINDOW_SEC){ ch.options.scales.x.min=0; ch.options.scales.x.max=LIVE_WINDOW_SEC; }
    else { ch.options.scales.x.min=maxE-LIVE_WINDOW_SEC; ch.options.scales.x.max=maxE; }
    // Y は max
    let maxV=0;
    for(const pt of data) if(pt.y>maxV) maxV=pt.y;
    ch.options.scales.y.max = Math.max(MIN_Y_MAX, Math.ceil(maxV*1.2));
    ch.update('none');
  }
}

// v4.0: 詳細表示を開く (グリッドセルクリック時)
function openDetail(id){
  focusedId=id;
  const o = (id===myId) ? {name:myName||'自分', place:myPlace} : sharedStudents[id];
  const place=o?.place||o?.memo||'';
  $('detailTitle').textContent = place ? `${o?.name||'名前なし'} (${place}) の波形` : (o?.name||'名前なし')+' の波形';
  $('detailOverlay').style.display='flex';
  updateDetailChart();
}
function closeDetail(){
  focusedId=null;
  $('detailOverlay').style.display='none';
}

// v4.0: 現在モードに応じた描画
function drawForCurrentMode(forceRedraw){
  if(currentMode==='my-wave'){
    updateMyChart();
    updateSummary();
  } else if(currentMode==='grid'){
    renderGrid();
  } else if(currentMode==='overlay'){
    const has=Object.keys(sharedStudents).length>0;
    $('overlayEmpty').style.display = has ? 'none' : '';
    $('overlayPanel').style.display = has ? '' : 'none';
    if(has) updateOverlayChart();
  }
  // 詳細オーバーレイが開いていれば常に更新
  if(focusedId && $('detailOverlay').style.display==='flex'){
    updateDetailChart();
  }
}

// =============== Chart ===============
function ensureChart(){
  if(lineChart) return lineChart;
  const ctx=$('lineChart');
  lineChart=new Chart(ctx,{
    type:'line',
    data:{datasets:[]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:false,
      parsing:false,
      normalized:true,
      plugins:{
        legend:{position:'top',align:'start',labels:{color:'#2D3A3A',font:{size:12,weight:'600'},boxWidth:14,boxHeight:14,padding:12,usePointStyle:true,pointStyle:'circle'}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:items=>items.length?('経過 '+items[0].parsed.x.toFixed(1)+'秒'):'',
          label:c=>c.dataset.label+': '+c.parsed.y+' raw'
        }}
      },
      scales:{
        x:{
          // v3.3: 経過時間軸 (秒)
          type:'linear',
          min:0,
          max:60,
          ticks:{color:'#6B8180',callback:v=>v+'s',maxTicksLimit:7,font:{size:11}},
          grid:{color:'rgba(58,171,168,0.1)'},
          title:{display:true,text:'経過時間 (秒)',color:'#6B8180',font:{size:11}}
        },
        y:{
          beginAtZero:true,
          min:0,
          ticks:{color:'#6B8180',font:{size:11}},
          grid:{color:'rgba(58,171,168,0.1)'},
          title:{display:true,text:'明るさ (raw)',color:'#6B8180',font:{size:11}}
        }
      }
    }
  });
  return lineChart;
}

// v4.0: マイ波形モードの dataset (自分の localHistory のみ)
function computeMyDatasets(){
  if(localHistory.length===0) return [];
  return [{
    label: (myName||'自分'),
    data: localHistory.map(p=>({x:p.e,y:p.v})),
    borderColor: MY_COLOR,
    backgroundColor: MY_COLOR+'22',
    borderWidth: 2.5,
    pointRadius: 0,
    tension: 0.4,
    cubicInterpolationMode: 'monotone',
    fill: false
  }];
}

// v4.2: 重ね合わせモードの datasets (sharedStudents 全員)
// 各自の接続開始 = 0秒 として正規化する。
// 元データの p.e は「各自の接続起点からの経過秒」なので、人によって 340秒台
// だったり 0秒台だったりする。重ね合わせは「波形の形」を比較するモードなので
// 各 dataset 内の最小 e を引いて 0 始まりに揃える (v3.3 で決定した仕様)。
function computeOverlayDatasets(){
  const out=[];
  for(const [id,o] of Object.entries(sharedStudents)){
    const c = (id===myId) ? MY_COLOR : colorFor(id);
    const label = (o.name||'名前なし') + (o.place?' ('+o.place+')':'') + (id===myId?' (自分)':'');
    const recent = (o && Array.isArray(o.recent)) ? o.recent : [];
    let data=[];
    if(recent.length){
      const xs = recent.map(p=>p.e||0);
      const xMin = Math.min(...xs);
      data = recent.map(p=>({x:(p.e||0)-xMin, y:p.v}));
    }
    out.push({
      label,
      data,
      borderColor: c,
      backgroundColor: c+'22',
      borderWidth: (id===myId)?3:2,
      pointRadius: 0,
      tension: 0.4,
      cubicInterpolationMode: 'monotone',
      fill: false
    });
  }
  return out;
}

// v4.0: 詳細表示モードの datasets (1人のみ)
function computeDetailDatasets(){
  if(!focusedId) return [];
  if(focusedId===myId && localHistory.length>0){
    return [{
      label: (myName||'自分'),
      data: localHistory.map(p=>({x:p.e,y:p.v})),
      borderColor: MY_COLOR, backgroundColor: MY_COLOR+'22',
      borderWidth: 2.5, pointRadius: 0, tension: 0.4, cubicInterpolationMode: 'monotone', fill: false
    }];
  }
  const o=sharedStudents[focusedId];
  if(!o) return [];
  const c = (focusedId===myId) ? MY_COLOR : colorFor(focusedId);
  return [{
    label: o.name||'名前なし',
    data: (o.recent||[]).map(p=>({x:p.e,y:p.v})),
    borderColor: c, backgroundColor: c+'22',
    borderWidth: 2.5, pointRadius: 0, tension: 0.4, cubicInterpolationMode: 'monotone', fill: false
  }];
}

// v4.0: マイ波形チャート更新 (自分の localHistory のみ)
function updateMyChart(){
  const ch=ensureChart();
  const datasets=computeMyDatasets();
  ch.data.datasets=datasets;
  const {xMin, xMax} = chartXRange();
  ch.options.scales.x.min = xMin;
  ch.options.scales.x.max = xMax;
  ch.options.scales.y.max = computeYMax(datasets);
  ch.update('none');
}

// v4.0: 重ね合わせチャート更新
let overlayChart=null;
function ensureOverlayChart(){
  if(overlayChart) return overlayChart;
  const ctx=$('overlayChart');
  if(!ctx) return null;
  // v4.1: 親 (#overlayPanel) が display:none から表示直後の同期タイミングだと
  // Chart.js が親サイズを 0×0 と測ってしまうので、生成前に強制 reflow する。
  const panel=$('overlayPanel');
  if(panel) void panel.offsetHeight;
  if(ctx.parentElement) void ctx.parentElement.offsetHeight;
  overlayChart=new Chart(ctx,{
    type:'line',
    data:{datasets:[]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:true,
      plugins:{
        legend:{position:'top',align:'start',labels:{color:'#2D3A3A',font:{size:12,weight:'600'},boxWidth:14,boxHeight:14,padding:12,usePointStyle:true,pointStyle:'circle'}},
        tooltip:{mode:'index',intersect:false,callbacks:{
          title:items=>items.length?('経過 '+items[0].parsed.x.toFixed(1)+'秒'):'',
          label:c=>c.dataset.label+': '+c.parsed.y+' raw'
        }}
      },
      scales:{
        x:{type:'linear',min:0,max:60,ticks:{color:'#6B8180',callback:v=>v+'s',maxTicksLimit:7,font:{size:11}},grid:{color:'rgba(58,171,168,0.1)'},title:{display:true,text:'経過時間 (秒)',color:'#6B8180',font:{size:11}}},
        y:{beginAtZero:true,min:0,ticks:{color:'#6B8180',font:{size:11}},grid:{color:'rgba(58,171,168,0.1)'},title:{display:true,text:'明るさ (raw)',color:'#6B8180',font:{size:11}}}
      }
    }
  });
  // v4.1: 生成直後の親サイズはまだ確定していないことがあるので次フレームで再採取。
  requestAnimationFrame(()=>{ try{ overlayChart && overlayChart.resize(); }catch(e){} });
  return overlayChart;
}
function updateOverlayChart(){
  const ch=ensureOverlayChart();
  if(!ch) return;
  const datasets=computeOverlayDatasets();
  ch.data.datasets=datasets;
  // v4.2: 各 dataset は 0 始まりに正規化済 (computeOverlayDatasets 参照)。
  // 全期間表示で「変化の形」を比較できるよう、X軸スライドは廃止。
  // 全 dataset の x 最大値を取り、min=0, max=Math.max(60, xMax) とする。
  let xMax=0;
  for(const ds of datasets){
    if(ds.data && ds.data.length){
      const last=ds.data[ds.data.length-1].x||0;
      if(last>xMax) xMax=last;
    }
  }
  ch.options.scales.x.min=0;
  ch.options.scales.x.max=Math.max(60, xMax);
  ch.options.scales.y.max = computeYMax(datasets);
  ch.update('none');
}

// v4.0: 詳細チャート (グリッドセルタップ時)
let detailChart=null;
function ensureDetailChart(){
  if(detailChart) return detailChart;
  const ctx=$('detailChart');
  if(!ctx) return null;
  detailChart=new Chart(ctx,{
    type:'line',
    data:{datasets:[]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:true,
      plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,callbacks:{
        title:items=>items.length?('経過 '+items[0].parsed.x.toFixed(1)+'秒'):'',
        label:c=>c.dataset.label+': '+c.parsed.y+' raw'
      }}},
      scales:{
        x:{type:'linear',min:0,max:LIVE_WINDOW_SEC,ticks:{color:'#6B8180',callback:v=>v+'s',maxTicksLimit:7,font:{size:11}},grid:{color:'rgba(58,171,168,0.1)'},title:{display:true,text:'経過時間 (秒)',color:'#6B8180',font:{size:11}}},
        y:{beginAtZero:true,min:0,ticks:{color:'#6B8180',font:{size:11}},grid:{color:'rgba(58,171,168,0.1)'},title:{display:true,text:'明るさ (raw)',color:'#6B8180',font:{size:11}}}
      }
    }
  });
  return detailChart;
}
function updateDetailChart(){
  const ch=ensureDetailChart();
  if(!ch || !focusedId) return;
  const datasets=computeDetailDatasets();
  ch.data.datasets=datasets;
  // 対象データから X 範囲を決定
  let maxE=0;
  for(const ds of datasets){
    for(const pt of ds.data) if(pt.x>maxE) maxE=pt.x;
  }
  if(maxE <= LIVE_WINDOW_SEC){ ch.options.scales.x.min=0; ch.options.scales.x.max=LIVE_WINDOW_SEC; }
  else { ch.options.scales.x.min=maxE-LIVE_WINDOW_SEC; ch.options.scales.x.max=maxE; }
  ch.options.scales.y.max = computeYMax(datasets);
  ch.update('none');
}

// =============== Summary ===============
function updateSummary(){
  let targetHistory=null;
  if(focusedId && focusedId!==myId){
    targetHistory = sharedStudents[focusedId]?.recent || [];
  } else {
    targetHistory = localHistory;
  }
  // v3.3: targetHistory には既に 60秒分しか入っていないのでフィルタは不要
  // (送信側 publishOwnRecent / pushSample / trimToWindow で既に直近60秒に絞られる)
  const pts=targetHistory;
  if(pts.length===0){
    $('sumMax').innerHTML='--<span class="summary-unit">raw</span>';
    $('sumAvg').innerHTML='--<span class="summary-unit">raw</span>';
    $('sumMin').innerHTML='--<span class="summary-unit">raw</span>';
    $('sumCount').innerHTML='--<span class="summary-unit">raw</span>';
    $('sumCountLabel').textContent='現在値';
    $('sumCountSub').textContent='接続するとライブ';
    return;
  }
  let mn=Infinity, mx=-Infinity, sum=0;
  for(const p of pts){
    if(p.v<mn)mn=p.v;
    if(p.v>mx)mx=p.v;
    sum+=p.v;
  }
  const avg=Math.round(sum/pts.length);
  const cur=pts[pts.length-1].v;
  // v3.4: ラベルをモード別に変更
  const scope = reviewMode ? '記録全体' : '直近10秒〜60秒';
  $('sumMax').innerHTML=mx+'<span class="summary-unit">raw</span>';
  $('sumAvg').innerHTML=avg+'<span class="summary-unit">raw</span>';
  $('sumMin').innerHTML=mn+'<span class="summary-unit">raw</span>';
  $('sumMaxLabel').textContent=scope;
  $('sumAvgLabel').textContent=scope;
  $('sumMinLabel').textContent=scope;

  if(reviewMode){
    // v3.4: レビュー中は現在値の代わりに記録の最後の値を表示
    $('sumCount').innerHTML=cur+'<span class="summary-unit">raw</span>';
    $('sumCountLabel').textContent='終了時の値';
    $('sumCountSub').textContent=`全 ${reviewEndElapsed.toFixed(1)} 秒`;
  } else if(shared && focusedId===null){
    // チーム数を表示 (自分 + 他人)
    const myCount=(connected||demoMode)?1:0;
    const totalCount=myCount + Object.keys(sharedStudents).length;
    $('sumCount').innerHTML=totalCount+'<span class="summary-unit">チーム</span>';
    $('sumCountLabel').textContent='チーム数';
    $('sumCountSub').textContent='共有中';
  } else {
    $('sumCount').innerHTML=cur+'<span class="summary-unit">raw</span>';
    $('sumCountLabel').textContent='現在値';
    $('sumCountSub').textContent = (focusedId && focusedId!==myId) ? (sharedStudents[focusedId]?.name||'') : (myName||'自分');
  }
}

// =============== rAF loop ===============
// v3.5: rAF で 60fps で起こされるが、実際の描画は RENDER_INTERVAL (50ms = 20fps) に間引く
// v4.0: モードに応じて適切な描画関数を呼ぶ
let rafId=null;
function tick(){
  const now = performance.now();
  if(now - lastRenderAt >= RENDER_INTERVAL){
    if(connected || demoMode || reviewMode || Object.keys(sharedStudents).length>0){
      drawForCurrentMode();
    }
    lastRenderAt = now;
  }
  rafId=requestAnimationFrame(tick);
}

// =============== Serial ===============
async function disconnectSerial(){
  const hadHistory = localHistory.length > 0;
  const endElapsed = currentElapsed();
  connected=false;
  try{ if(serialReader){ await serialReader.cancel().catch(()=>{}); try{serialReader.releaseLock()}catch(_){}; serialReader=null; } }catch(e){}
  try{ if(serialPort){ await serialPort.close().catch(()=>{}); } }catch(e){}
  serialPort=null;
  if(shared) stopSharing(); // 接続切れたら共有も自動停止 (Firebase からも自分のノードを削除)
  setStatusPill(hadHistory ? '記録レビュー中' : '観覧中', false);
  $('shareBtn').style.display='none';
  $('myVal').textContent='--';
  latestValue=null;
  // v3.4: 記録があればレビューモードに入る (localHistory を保持して全範囲表示)
  if(hadHistory){
    enterReviewMode(endElapsed);
  } else {
    // 記録ゼロなら通常の観覧モードへ
    localHistory=[];
    rawBuffer=[];
    lastPushAt=0;
    connectStartedAt=null;
    $('serialBtn').textContent='🔌 接続';
    $('serialBtn').classList.remove('connected');
    showReviewControls(false);
    updateChartTitle();
  }
  updateModeBadge();
  drawForCurrentMode();
  updateSummary();
}

// v3.4: レビューモードに入る (記録は保持、全範囲表示)
function enterReviewMode(endElapsed){
  reviewMode=true;
  reviewEndElapsed=endElapsed;
  // ボタン群を「やり直す / CSV / 再接続」に切り替え
  $('serialBtn').style.display='none';
  showReviewControls(true);
  // ヒステリシスは止めて即時 Y 計算
  yMaxObservedValue=0; yMaxObservedTime=0;
  updateChartTitle();
}

// v3.4: レビューを終了 (やり直す / 再接続が呼び出す)
function exitReviewMode(){
  reviewMode=false;
  reviewEndElapsed=0;
  localHistory=[];
  rawBuffer=[];
  lastPushAt=0;
  connectStartedAt=null;
  yMaxObservedValue=0; yMaxObservedTime=0;
  $('serialBtn').style.display='';
  $('serialBtn').textContent='🔌 接続';
  $('serialBtn').classList.remove('connected');
  showReviewControls(false);
  setStatusPill('観覧中', false);
  $('myVal').textContent='--';
  updateChartTitle();
  updateModeBadge();
  drawForCurrentMode();
  updateSummary();
}

// レビュー用ボタン群の表示切替
function showReviewControls(show){
  const el=$('reviewControls');
  if(el) el.style.display = show ? '' : 'none';
}

async function connectSerial(){
  if(!('serial' in navigator)){
    alert('このブラウザは Web Serial API に対応していません。Chrome / Edge / Opera をお使いください。');
    return;
  }
  try{
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({baudRate:9600});
    connected = true;
    // v3.3: 接続開始時刻を起点に経過秒を測る
    connectStartedAt = Date.now();
    localHistory = [];
    rawBuffer = [];
    lastPushAt = 0;
    setStatusPill('接続中', true);
    const btn=$('serialBtn');
    btn.textContent='🔌 切断';
    btn.classList.add('connected');
    $('shareBtn').style.display='';
    // デモ中ならデモ停止
    if(demoMode) stopDemo();
    // v3.2: タイトルとバッジ更新
    updateChartTitle();
    updateModeBadge();

    const dec=new TextDecoderStream();
    serialPort.readable.pipeTo(dec.writable).catch(()=>{});
    const reader=dec.readable.getReader();
    serialReader=reader;
    let buf='';
    (async()=>{
      while(connected){
        try{
          const{value,done}=await reader.read();
          if(done) break;
          buf+=value;
          const lines=buf.split('\n');
          buf=lines.pop();
          for(const l of lines){
            const n=parseInt(l.trim(),10);
            // v2.1 由来: 0〜4095 範囲チェック + 急変フィルタ (前値の ±50%+30 以内)
            // v3.5: 移動平均は onRawSample 内 (rawBuffer + SMOOTHING_WINDOW)
            if(!isNaN(n) && n>=0 && n<=4095){
              if(latestValue===null || Math.abs(n-latestValue) < Math.max(50, latestValue*0.5+30)){
                onRawSample(n);
              }
            }
          }
        }catch(e){ break; }
      }
    })();
  }catch(e){
    console.error('Serial error:',e);
    serialPort=null;
    connected=false;
  }
}

// v3.5: シリアルから受信した raw 値を入口で処理する
//   rawBuffer に貯め、移動平均で滑らかな値を作る。
//   localHistory への push は HISTORY_PUSH_INTERVAL ms に1回まで throttle。
//   描画は別の rAF ループ (tick) が RENDER_INTERVAL ms 間隔で回す。
function onRawSample(n){
  rawBuffer.push(n);
  if(rawBuffer.length > RAW_BUFFER_SIZE) rawBuffer.shift();
  // 直近 SMOOTHING_WINDOW 点の平均
  const w = rawBuffer.slice(-SMOOTHING_WINDOW);
  let s = 0;
  for(const x of w) s += x;
  const avg = Math.round(s / w.length);
  latestValue = avg;
  // 現在値表示は即時 (体感の遅延を避ける)
  $('myVal').textContent = avg;
  // localHistory への push は throttle
  const now = Date.now();
  if(now - lastPushAt >= HISTORY_PUSH_INTERVAL){
    lastPushAt = now;
    const e = currentElapsed();
    localHistory.push({e, v: avg});
    trimToWindow(localHistory);
  }
}

// 互換用 (デモ等から直接呼ぶケース) — 経過秒を指定して 1点追加
function pushSample(v){
  const e = currentElapsed();
  localHistory.push({e, v});
  trimToWindow(localHistory);
  $('myVal').textContent=v;
}

$('serialBtn').addEventListener('click',()=>{
  if(connected){ disconnectSerial(); }
  else { connectSerial(); }
});

// v3.4: レビューボタン群
$('restartBtn').addEventListener('click',()=>{
  if(!confirm('記録をクリアしてやり直しますか？')) return;
  exitReviewMode();
});
$('reconnectBtn').addEventListener('click',()=>{
  exitReviewMode();
  // 即時で新規接続フローへ
  connectSerial();
});
$('reviewCsvBtn').addEventListener('click',()=>{
  if(localHistory.length===0){ alert('記録データがありません'); return; }
  const name=myName||'自分';
  const place=myPlace||'';
  let csv='﻿名前,場所,経過秒,raw値,絶対時刻\n';
  for(const p of localHistory){
    const absMs = (connectStartedAt||0) + p.e*1000;
    const isoT = new Date(absMs).toISOString();
    csv += `"${name}","${place}",${p.e.toFixed(3)},${p.v},${isoT}\n`;
  }
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  const d=new Date();
  const ds=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'_'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0');
  a.href=URL.createObjectURL(blob);
  a.download=`light-compare-review-${ds}.csv`;
  a.click();
});

// =============== Sharing ===============
$('shareBtn').addEventListener('click',()=>{
  if(!shared){
    $('modalNameInput').value=myName;
    $('modalPlaceInput').value=myPlace;
    $('shareModal').style.display='flex';
    setTimeout(()=>$('modalNameInput').focus(),50);
  } else {
    if(confirm('共有を停止しますか？')) stopSharing();
  }
});

$('modalCancel').addEventListener('click',()=>{ $('shareModal').style.display='none'; });
$('modalConfirm').addEventListener('click',()=>{
  const name=$('modalNameInput').value.trim();
  if(!name){ alert('名前を入力してください'); return; }
  myName=name;
  myPlace=$('modalPlaceInput').value.trim();
  localStorage.setItem('myName', myName);
  localStorage.setItem('myPlace', myPlace);
  $('shareModal').style.display='none';
  startSharing();
});
$('modalNameInput').addEventListener('keydown',e=>{
  if(e.key==='Enter') $('modalPlaceInput').focus();
});
$('modalPlaceInput').addEventListener('keydown',e=>{
  if(e.key==='Enter') $('modalConfirm').click();
});

// v3.2: 観覧モード — Firebase が使える環境ならページロード時に常時購読
// v4.0: 起動時から常時購読。自分も sharedStudents に含む (filter しない) ので
//       同一ブラウザ2タブテストでも双方の波形が見える (studentId は sessionStorage で別)。
function subscribeToOthers(){
  if(!db || othersSubscribed) return;
  othersSubscribed=true;
  studentsRef=db.ref('sessions/'+SESSION_ID+'/students');
  studentsRef.on('value',snap=>{
    const all=snap.val()||{};
    sharedStudents = all || {};
    updateShareCounts();
    // 現在表示中のモードに応じて再描画 (即時反映)
    drawForCurrentMode();
  },err=>{
    console.warn('subscribeToOthers error:', err);
  });
}

function unsubscribeOthers(){
  if(studentsRef){ studentsRef.off(); studentsRef=null; }
  if(notesRef){ notesRef.off(); notesRef=null; }
  othersSubscribed=false;
}

// v4.0: shareArea / participantsList の概念は廃止。
//       後方互換用に空関数として残す (既存呼び出しを温存)。
function refreshShareAreaVisibility(){ /* v4.0: no-op */ }
function renderParticipants(){ /* v4.0: グリッドモードで自動描画されるため不要 */ }

function startSharing(){
  if(!db){ alert('Firebase に接続できません'); return; }
  shared=true;
  const sbtn=$('shareBtn');
  sbtn.textContent='✓ 共有中 (停止)';
  sbtn.classList.add('sharing');
  $('memoBox').style.display='';
  // v3.3: モーダルで入力した場所をフッター入力欄に反映 (同期)
  $('myMemo').value=myPlace;
  myMemo=myPlace;
  updateChartTitle();

  // v3.2: 自分のノードに onDisconnect ハンドラを仕込む
  // (ブラウザ閉じ / タブ閉じ / 通信断で自動的に sessions から削除)
  onDisconnectRef = db.ref('sessions/'+SESSION_ID+'/students/'+myId);
  onDisconnectRef.onDisconnect().remove();

  // 自分の直近60秒を初回 publish
  publishOwnRecent();
  pushInterval=setInterval(publishOwnRecent, FB_PUSH_INTERVAL_MS);

  // 他人購読は init() で常時起動済 (重複させない)
  if(!othersSubscribed) subscribeToOthers();

  updateModeBadge();
  // v4.0: 共有してもモード遷移しない。トーストで誘導のみ。
  if(currentMode==='my-wave'){
    showToast('共有を開始しました。「🔲 グリッド」「🔀 重ね合わせ」タブで全員の波形が見えます');
  }
}

function publishOwnRecent(){
  if(!shared || !db) return;
  // v3.3: localHistory は既に直近60秒分しかない (trimToWindow で管理)
  db.ref('sessions/'+SESSION_ID+'/students/'+myId).set({
    name: myName,
    place: myPlace,
    memo: myMemo,
    startedAt: connectStartedAt,    // 起点 (絶対時刻ms)
    recent: localHistory.slice(),    // [{e, v}] 経過秒+値
    updatedAt: Date.now()
  });
}

function stopSharing(){
  shared=false;
  if(pushInterval){ clearInterval(pushInterval); pushInterval=null; }
  const sbtn=$('shareBtn');
  sbtn.textContent='👥 共有する';
  sbtn.classList.remove('sharing');
  $('memoBox').style.display='none';
  // v3.2: onDisconnect 解除 + 自分のノードを明示的に削除
  if(onDisconnectRef){ onDisconnectRef.onDisconnect().cancel().catch(()=>{}); onDisconnectRef=null; }
  if(db) db.ref('sessions/'+SESSION_ID+'/students/'+myId).remove().catch(()=>{});
  // v4.0: 他人の購読は維持 (常時観覧)。モード遷移もしない。
  updateChartTitle();
  updateModeBadge();
  updateSummary();
}

// memo / place input — v3.3 はメモ欄を「場所」の同期欄として使う (モーダルと連動)
$('myMemo').addEventListener('input',e=>{
  myMemo=e.target.value;
  myPlace=e.target.value;  // v3.3: メモ欄 = 場所欄 (UI簡素化)
  localStorage.setItem('myPlace', myPlace);
});

// v4.0: 詳細表示オーバーレイ用のクローズハンドラ
$('detailClose').addEventListener('click', closeDetail);

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('detailOverlay').style.display==='flex'){ closeDetail(); }
    else if($('shareModal').style.display==='flex'){ $('modalCancel').click(); }
  }
});

// =============== Notes ===============
// v4.0: ノート機能は v3.x の遺物。HTML から削除済み。renderNotes は空関数で残置。
function renderNotes(obj){ /* v4.0: no-op (notes UI removed) */ }

// =============== CSV ===============
$('csvBtn').addEventListener('click',()=>{
  // v4.0: 重ね合わせモードの CSV — sharedStudents 全員 (自分含む) を出力
  let csv='﻿名前,場所,経過秒,raw値\n';
  const entries = Object.entries(sharedStudents);
  if(entries.length===0){
    // sharedStudents が空でも自分の localHistory があれば出力
    if(localHistory.length){
      const myLabel=myName||'自分';
      const myPlaceLabel=myPlace||'';
      for(const p of localHistory){
        csv += `"${myLabel}","${myPlaceLabel}",${(p.e||0).toFixed(3)},${p.v}\n`;
      }
    } else {
      alert('共有データがありません');
      return;
    }
  }
  for(const [id,o] of entries){
    const placeLabel = o.place || o.memo || '';
    for(const p of (o.recent||[])){
      csv += `"${o.name||'名前なし'}","${placeLabel}",${(p.e||0).toFixed(3)},${p.v}\n`;
    }
  }
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  const d=new Date();
  const ds=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'_'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0');
  a.href=URL.createObjectURL(blob);
  a.download=`light-compare-${ds}.csv`;
  a.click();
});

// =============== Demo Mode ===============
const DEMO_GROUPS=[
  {name:'窓際チーム',    memo:'窓際・直射日光',  base:2840},
  {name:'廊下チーム',    memo:'廊下・蛍光灯',    base:1950},
  {name:'教室中央チーム',memo:'教室中央',        base:1280},
  {name:'机の下チーム',  memo:'机の下',          base:890},
  {name:'カバンの中チーム',memo:'カバンの中',    base:420},
  {name:'引き出しチーム',memo:'引き出しの中',    base:193}
];

function jitter(base){ return Math.max(0, base + Math.floor((Math.random()-0.5)*base*0.10)); }

$('demoBtn').addEventListener('click',()=>{
  if(demoMode){ stopDemo(); } else { startDemo(); }
});

function startDemo(){
  if(connected){ alert('シリアル接続中はデモを開始できません'); return; }
  demoMode=true;
  $('demoBadge').style.display='';
  $('demoBtn').textContent='デモ停止';
  $('demoBtn').classList.add('active');
  setStatusPill('デモ実行中', true);

  // デモ用に自分の名前/場所を仮設定 (LocalStorage は触らない)
  demoRestoreName=myName;
  myName='教室中央チーム';
  myPlace='教室中央';
  myMemo='教室中央';

  // v3.3: 自分の履歴を経過秒で初期化 (0..60 の 60 点)
  connectStartedAt = Date.now() - 60*1000; // 60秒前から接続中とみなす
  localHistory=[];
  rawBuffer=[];
  lastPushAt=0;
  for(let i=0;i<=60;i++) localHistory.push({e: i, v: jitter(1280)});

  // v4.0: shared フラグだけ立てる (Firebase は使わない / shareArea も無い)
  shared=true;
  $('shareBtn').style.display='';
  $('shareBtn').textContent='✓ 共有中 (停止)';
  $('shareBtn').classList.add('sharing');
  $('memoBox').style.display='';
  $('myMemo').value=myPlace;
  updateChartTitle();

  // 自分を sharedStudents に入れる (v4.0: 自分も含めて描画)
  sharedStudents={};
  sharedStudents[myId]={name:myName, place:myPlace, recent:localHistory.slice(), startedAt:connectStartedAt, updatedAt:Date.now()};
  // 他チームの履歴 (経過秒 0..60、すこしずつズラして変化感を出す)
  DEMO_GROUPS.forEach((g,i)=>{
    if(g.name==='教室中央チーム') return;
    const recent=[];
    for(let k=0;k<=60;k++) recent.push({e: k, v: jitter(g.base)});
    sharedStudents['demo-'+i]={name:g.name, place:g.memo, recent:recent, startedAt:connectStartedAt, updatedAt:Date.now()};
  });

  updateShareCounts();
  $('myVal').textContent=localHistory[localHistory.length-1].v;

  updateModeBadge();
  drawForCurrentMode();
  // 連続更新 (300ms ごと、経過秒を増やしながら追加)
  demoIntervals.push(setInterval(()=>{
    const e = currentElapsed();
    localHistory.push({e, v: jitter(1280)});
    trimToWindow(localHistory);
    $('myVal').textContent=localHistory[localHistory.length-1].v;
    // 自分の recent も更新
    if(sharedStudents[myId]){
      sharedStudents[myId].recent = localHistory.slice();
      sharedStudents[myId].updatedAt = Date.now();
    }
    DEMO_GROUPS.forEach((g,i)=>{
      if(g.name==='教室中央チーム') return;
      const k='demo-'+i;
      if(!sharedStudents[k]) return;
      sharedStudents[k].recent.push({e, v: jitter(g.base)});
      // 直近60秒に絞る (e基準)
      const cutoff = e - 60 - 5;
      while(sharedStudents[k].recent.length>0 && sharedStudents[k].recent[0].e<cutoff) sharedStudents[k].recent.shift();
      sharedStudents[k].updatedAt=Date.now();
    });
  }, 300));
}

function stopDemo(){
  demoMode=false;
  demoIntervals.forEach(clearInterval);
  demoIntervals=[];
  if(demoRestoreName!==null){ myName=demoRestoreName; demoRestoreName=null; }

  $('demoBadge').style.display='none';
  $('demoBtn').textContent='デモ';
  $('demoBtn').classList.remove('active');
  setStatusPill('観覧中', false);
  shared=false;
  $('shareBtn').style.display='none';
  $('shareBtn').classList.remove('sharing');
  $('shareBtn').textContent='👥 共有する';
  $('memoBox').style.display='none';
  $('myMemo').value='';
  myMemo='';
  myPlace=localStorage.getItem('myPlace')||'';
  $('myVal').textContent='--';
  localHistory=[];
  rawBuffer=[];
  lastPushAt=0;
  connectStartedAt=null;  // v3.3: 経過秒の起点をリセット
  // v3.2: デモ用に詰めた擬似 sharedStudents を消去。Firebase 由来の本物は購読が継続更新する。
  sharedStudents={};
  focusedId=null;
  $('detailOverlay').style.display='none';
  updateShareCounts();
  updateChartTitle();
  updateModeBadge();
  updateSummary();
  drawForCurrentMode(true);
}

// =============== Init ===============
// v4.0: モードタブのクリックハンドラ
document.querySelectorAll('.mode-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>setMode(btn.dataset.mode));
});

ensureChart();
updateSummary();
updateModeBadge();
updateChartTitle();
updateShareCounts();
setStatusPill('観覧中', false);
setMode(currentMode);
// v3.2/4.0: ページロード時に観覧モードを開始 (誰かが共有していれば波形が見える)
subscribeToOthers();
drawForCurrentMode(true);
tick();
