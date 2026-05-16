// SchooMy 明るさ比較システム v3.5
// 個人モード中心。共有モードで送受信。観覧モード(接続せず購読のみ)も常時アクティブ。
// 描画方針 (wave-gear / wave-lab 準拠):
//   - シリアル受信 → rawBuffer に蓄積 → 移動平均 → 50ms throttle で localHistory に push
//   - requestAnimationFrame ループ内で 50ms throttle 描画 (チラつき/重さ防止)
//   - Chart.js インスタンスは destroy せず使い回し
//
// v3.5 変更点:
//   - 移動平均フィルタ追加 (SMOOTHING_WINDOW=10) — ESP32 側 delay なしでも波形を滑らかに
//   - 描画スロットル追加 (50ms = 20fps) — 受信頻度とは独立して描画
//   - localHistory への push も 50ms throttle (ストレージ節約)
//   - Chart.js datasets: tension 0.4 + cubicInterpolationMode 'monotone' でなめらか
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
let myId=localStorage.getItem('studentId');
if(!myId){myId=crypto.randomUUID();localStorage.setItem('studentId',myId)}
let myName=localStorage.getItem('myName')||'';
let myPlace=localStorage.getItem('myPlace')||'';
let myMemo='';

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

let othersData={};          // {studentId: {name, memo, recent, updatedAt}}
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
    else { name=othersData[focusedId]?.name||'名前なし'; place=othersData[focusedId]?.place||othersData[focusedId]?.memo||''; }
    title = place ? `時系列グラフ — ${name} (${place}) の波形` : `時系列グラフ — ${name} の波形`;
  } else if(reviewMode){
    const dur = Math.max(0, reviewEndElapsed).toFixed(0);
    title = `時系列グラフ — 記録レビュー (全 ${dur}秒)`;
  } else if(shared || demoMode){
    title = '時系列グラフ — リアルタイム (全員)';
  } else if(connected){
    title = '時系列グラフ — リアルタイム (直近10秒)';
  } else {
    title = (Object.keys(othersData).length>0) ? '時系列グラフ — みんなの波形 (観覧中)' : '時系列グラフ — 自分の明るさ波形';
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
  for(const o of Object.values(othersData)){
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

function computeDatasets(){
  // v3.3: 全点を経過時間 e で渡す。Chart.js が x 範囲 (chartXRange) で自動クリップ。
  // 詳細表示: 1人だけ
  if(focusedId){
    if(focusedId===myId){
      return [{label:(myName||'自分'),data:localHistory.map(p=>({x:p.e,y:p.v})),
        borderColor:MY_COLOR,backgroundColor:MY_COLOR+'22',borderWidth:2.5,pointRadius:0,tension:0.4,cubicInterpolationMode:'monotone',fill:false}];
    } else {
      const o=othersData[focusedId];
      if(!o) return [];
      const c=colorFor(focusedId);
      return [{label:o.name||'名前なし',data:(o.recent||[]).map(p=>({x:p.e,y:p.v})),
        borderColor:c,backgroundColor:c+'22',borderWidth:2.5,pointRadius:0,tension:0.4,cubicInterpolationMode:'monotone',fill:false}];
    }
  }

  // v3.2: 全モード共通で「自分(あれば) + 他人」を重ねる
  // 観覧中(!connected): 他人のみ
  // 個人モード(connected, !shared): 自分 + 他人 (背景に薄く)
  // 共有中: 自分(太線) + 他人
  const datasets=[];
  if(connected || demoMode){
    const myBorder = shared ? 3 : 2.5;
    datasets.push({label:(myName||'自分')+(shared?' (自分)':''),data:localHistory.map(p=>({x:p.e,y:p.v})),
      borderColor:MY_COLOR,backgroundColor:MY_COLOR+'22',borderWidth:myBorder,pointRadius:0,tension:0.4,cubicInterpolationMode:'monotone',fill:false});
  }
  for(const [id,o] of Object.entries(othersData)){
    if(id===myId) continue;
    const c=colorFor(id);
    // 個人モード(接続中だが未共有)では他人を半透明で背景に
    const isBackground = connected && !shared;
    datasets.push({label:(o.name||'名前なし'),data:(o.recent||[]).map(p=>({x:p.e,y:p.v})),
      borderColor: isBackground ? c+'88' : c, backgroundColor:c+'22',
      borderWidth: isBackground ? 1.5 : 2, pointRadius:0,tension:0.4,cubicInterpolationMode:'monotone',fill:false});
  }
  return datasets;
}

function updateChart(){
  const ch=ensureChart();
  const datasets=computeDatasets();
  ch.data.datasets=datasets;
  // v3.4: X軸は直近10秒スライド (レビュー時は全範囲)
  const {xMin, xMax} = chartXRange();
  ch.options.scales.x.min = xMin;
  ch.options.scales.x.max = xMax;
  // v3.4: Y軸は max を実データに自動追従 + ヒステリシス
  ch.options.scales.y.max = computeYMax(datasets);
  ch.update('none');
}

// =============== Summary ===============
function updateSummary(){
  let targetHistory=null;
  if(focusedId && focusedId!==myId){
    targetHistory = othersData[focusedId]?.recent || [];
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
    const totalCount=myCount + Object.keys(othersData).length;
    $('sumCount').innerHTML=totalCount+'<span class="summary-unit">チーム</span>';
    $('sumCountLabel').textContent='チーム数';
    $('sumCountSub').textContent='共有中';
  } else {
    $('sumCount').innerHTML=cur+'<span class="summary-unit">raw</span>';
    $('sumCountLabel').textContent='現在値';
    $('sumCountSub').textContent = (focusedId && focusedId!==myId) ? (othersData[focusedId]?.name||'') : (myName||'自分');
  }
}

// =============== rAF loop ===============
// v3.5: rAF で 60fps で起こされるが、実際の描画は RENDER_INTERVAL (50ms = 20fps) に間引く
let rafId=null;
function tick(){
  const now = performance.now();
  if(now - lastRenderAt >= RENDER_INTERVAL){
    if(connected || demoMode || reviewMode || Object.keys(othersData).length>0){
      updateChart();
      updateSummary();
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
  refreshShareAreaVisibility();
  updateModeBadge();
  updateChart();
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
  updateChart();
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
function subscribeToOthers(){
  if(!db || othersSubscribed) return;
  othersSubscribed=true;
  studentsRef=db.ref('sessions/'+SESSION_ID+'/students');
  studentsRef.on('value',snap=>{
    const all=snap.val()||{};
    const next={};
    for(const [id,d] of Object.entries(all)){
      if(id===myId) continue;
      next[id]=d;
    }
    othersData=next;
    // 観覧中も含めて他人がいたら参加者エリアを開示
    refreshShareAreaVisibility();
    renderParticipants();
  });
  notesRef=db.ref('sessions/'+SESSION_ID+'/notes');
  notesRef.orderByChild('createdAt').limitToLast(10).on('value',s=>renderNotes(s.val()||{}));
}

function unsubscribeOthers(){
  if(studentsRef){ studentsRef.off(); studentsRef=null; }
  if(notesRef){ notesRef.off(); notesRef=null; }
  othersSubscribed=false;
}

// v3.2: 観覧中でも他人がいたら shareArea を表示。誰もいなければ畳む。
function refreshShareAreaVisibility(){
  const hasOthers = Object.keys(othersData).length > 0;
  const showArea = shared || demoMode || hasOthers;
  $('shareArea').style.display = showArea ? '' : 'none';
}

function startSharing(){
  if(!db){ alert('Firebase に接続できません'); return; }
  shared=true;
  const sbtn=$('shareBtn');
  sbtn.textContent='✓ 共有中 (タップで停止)';
  sbtn.classList.add('sharing');
  $('shareArea').style.display='';
  $('memoBox').style.display='';
  // v3.3: モーダルで入力した場所をフッター入力欄に反映 (同期)
  $('myMemo').value=myPlace;
  myMemo=myPlace;
  $('noteAuthor').value=myName;
  updateChartTitle();

  // v3.2: 自分のノードに onDisconnect ハンドラを仕込む
  // (ブラウザ閉じ / タブ閉じ / 通信断で自動的に sessions から削除)
  onDisconnectRef = db.ref('sessions/'+SESSION_ID+'/students/'+myId);
  onDisconnectRef.onDisconnect().remove();

  // 自分の直近60秒を初回 publish
  publishOwnRecent();
  pushInterval=setInterval(publishOwnRecent, FB_PUSH_INTERVAL_MS);

  // 他人購読は subscribeToOthers() で既に開始済 (重複させない)
  if(!othersSubscribed) subscribeToOthers();

  updateModeBadge();
  renderParticipants();
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
  // v3.2: 他人の購読は維持 (観覧モードに戻る)。停止しない。
  focusedId=null;
  $('backToAllBtn').style.display='none';
  updateChartTitle();
  refreshShareAreaVisibility();
  updateModeBadge();
  updateSummary();
}

// memo / place input — v3.3 はメモ欄を「場所」の同期欄として使う (モーダルと連動)
$('myMemo').addEventListener('input',e=>{
  myMemo=e.target.value;
  myPlace=e.target.value;  // v3.3: メモ欄 = 場所欄 (UI簡素化)
  localStorage.setItem('myPlace', myPlace);
});

// =============== Participants ===============
function renderParticipants(){
  const cards=$('participantCards');
  if(!cards) return;
  const items=[];
  if(connected || demoMode){
    items.push({id:myId, name:(myName||'自分'), suffix:' (自分)', place:myPlace, recent:localHistory, color:MY_COLOR, isMe:true});
  }
  for(const [id,o] of Object.entries(othersData)){
    // v3.3: place を優先、無ければ memo を表示 (旧クライアント互換)
    const placeText = o.place || o.memo || '';
    items.push({id, name:(o.name||'名前なし'), suffix:'', place:placeText, recent:(o.recent||[]), color:colorFor(id), isMe:false});
  }
  if(items.length===0){
    cards.innerHTML='<div class="empty-hint">まだ誰も共有していません</div>';
    return;
  }
  cards.innerHTML='';
  for(const it of items){
    const last = it.recent.length ? it.recent[it.recent.length-1].v : '--';
    const card=document.createElement('div');
    card.className='participant-card' + (focusedId===it.id?' focused':'');
    card.style.borderLeftColor=it.color;
    card.innerHTML=`
      <div class="pc-row">
        <div class="pc-dot" style="background:${it.color}"></div>
        <div class="pc-name">${escapeHtml(it.name)}<span class="pc-suffix">${escapeHtml(it.suffix)}</span></div>
      </div>
      <div class="pc-val">${last}<span class="pc-unit">raw</span></div>
      ${it.place?`<div class="pc-memo">📍 ${escapeHtml(it.place)}</div>`:''}
    `;
    card.onclick=()=>focusOn(it.id);
    cards.appendChild(card);
  }
}

function focusOn(id){
  focusedId=id;
  let name, place;
  if(id===myId){ name = myName||'自分'; place = myPlace; }
  else { name = othersData[id]?.name||'名前なし'; place = othersData[id]?.place || othersData[id]?.memo || ''; }
  // v3.3: タイトルに 場所 を含める
  updateChartTitle();
  $('backToAllBtn').style.display='';
  renderParticipants();
}

$('backToAllBtn').addEventListener('click',()=>{
  focusedId=null;
  updateChartTitle();
  $('backToAllBtn').style.display='none';
  renderParticipants();
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if(focusedId!==null){ $('backToAllBtn').click(); }
    else if($('shareModal').style.display==='flex'){ $('modalCancel').click(); }
  }
});

// =============== Notes ===============
function renderNotes(obj){
  const list=$('notesList');
  if(!list) return;
  const notes=Object.values(obj).sort((a,b)=>b.createdAt-a.createdAt);
  list.innerHTML=notes.map(n=>{
    return `<div class="note-item">
      <div class="note-meta"><span class="note-author">${escapeHtml(n.name)}</span><span>${new Date(n.createdAt).toLocaleTimeString('ja-JP')}</span></div>
      <div class="note-text">${escapeHtml(n.text)}</div>
    </div>`;
  }).join('');
}

$('noteSubmit').addEventListener('click',()=>{
  if(!shared || !db) return;
  const a=$('noteAuthor').value.trim() || myName || '名前なし';
  const t=$('noteText').value.trim();
  if(!t) return;
  db.ref('sessions/'+SESSION_ID+'/notes').push({name:a, text:t, createdAt:Date.now()});
  $('noteText').value='';
});

// =============== CSV ===============
$('csvBtn').addEventListener('click',()=>{
  // v3.3: CSV は経過秒で出力 (各人の起点からの相対時間で比較可能)
  let csv='﻿名前,場所,経過秒,raw値\n';
  if(connected || demoMode){
    const myLabel=myName||'自分';
    const myPlaceLabel=myPlace||'';
    for(const p of localHistory){
      csv += `"${myLabel}","${myPlaceLabel}",${(p.e||0).toFixed(3)},${p.v}\n`;
    }
  }
  for(const [id,o] of Object.entries(othersData)){
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

  // 共有エリアを擬似的に表示 (Firebase は使わない)
  shared=true;
  $('shareArea').style.display='';
  $('shareBtn').style.display='';
  $('shareBtn').textContent='✓ 共有中 (タップで停止)';
  $('shareBtn').classList.add('sharing');
  $('memoBox').style.display='';
  $('myMemo').value=myPlace;
  $('noteAuthor').value=myName;
  updateChartTitle();

  // 他チームの履歴 (経過秒 0..60、すこしずつズラして変化感を出す)
  othersData={};
  DEMO_GROUPS.forEach((g,i)=>{
    if(g.name==='教室中央チーム') return;
    const recent=[];
    for(let k=0;k<=60;k++) recent.push({e: k, v: jitter(g.base)});
    othersData['demo-'+i]={name:g.name, place:g.memo, recent:recent, startedAt:connectStartedAt, updatedAt:Date.now()};
  });

  renderParticipants();
  renderNotes({demo1:{name:'教室中央チーム', text:'窓際チームは引き出しチームの約15倍明るかった！', createdAt:Date.now()}});
  $('myVal').textContent=localHistory[localHistory.length-1].v;

  updateModeBadge();
  // 連続更新 (300ms ごと、経過秒を増やしながら追加)
  demoIntervals.push(setInterval(()=>{
    const e = currentElapsed();
    localHistory.push({e, v: jitter(1280)});
    trimToWindow(localHistory);
    $('myVal').textContent=localHistory[localHistory.length-1].v;
    DEMO_GROUPS.forEach((g,i)=>{
      if(g.name==='教室中央チーム') return;
      const k='demo-'+i;
      if(!othersData[k]) return;
      othersData[k].recent.push({e, v: jitter(g.base)});
      // 直近60秒に絞る (e基準)
      const cutoff = e - 60 - 5;
      while(othersData[k].recent.length>0 && othersData[k].recent[0].e<cutoff) othersData[k].recent.shift();
      othersData[k].updatedAt=Date.now();
    });
    renderParticipants();
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
  // v3.2: デモ用に詰めた擬似 othersData を消去。Firebase 由来の本物は購読が継続更新する。
  othersData={};
  focusedId=null;
  $('backToAllBtn').style.display='none';
  updateChartTitle();
  refreshShareAreaVisibility();
  updateModeBadge();
  updateSummary();
  updateChart();
}

// =============== Init ===============
ensureChart();
updateChart();
updateSummary();
renderParticipants();
updateModeBadge();
// v3.2: ページロード時に観覧モードを開始 (誰かが共有していれば波形が見える)
setStatusPill('観覧中', false);
updateChartTitle();
subscribeToOthers();
tick();
