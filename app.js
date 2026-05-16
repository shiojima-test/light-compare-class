// SchooMy 明るさ比較システム v3.2
// 個人モード中心。共有モードで送受信。観覧モード(接続せず購読のみ)も常時アクティブ。
// 描画方針 (wave-gear / wave-lab 準拠):
//   - シリアル受信 → ローカル配列に即時 push
//   - requestAnimationFrame ループで chart.data 差し替え + chart.update('none')
//   - Chart.js インスタンスは destroy せず使い回し (チラつき防止)
//
// v3.2 変更点:
//   - 「観覧モード」追加: ページを開いた時点で自動的に他人を購読開始
//     接続も共有もしていない PC でも、誰かが共有していれば波形が見える
//   - onDisconnect().remove() で、ブラウザを閉じたら自動的に sessions から消える
//   - ヘッダーに状態バッジ (観覧中 / 個人モード / 共有中) を追加

// =============== Firebase ===============
const FIREBASE_CONFIG={apiKey:"AIzaSyAJsJ2gLDgAuvfowjuaRwz9HBLm1s05IP4",authDomain:"schoomy-sensor.firebaseapp.com",databaseURL:"https://schoomy-sensor-default-rtdb.asia-southeast1.firebasedatabase.app",projectId:"schoomy-sensor",storageBucket:"schoomy-sensor.firebasestorage.app",messagingSenderId:"885079688723",appId:"1:885079688723:web:62e5c1a86206914fe921e6"};
let db=null;
try{firebase.initializeApp(FIREBASE_CONFIG);db=firebase.database()}catch(e){console.warn('Firebase init skipped:',e.message)}

// =============== 定数 ===============
const SESSION_ID='light-class';                 // 共有時は全員ここに集まる
const KEEP_DURATION_MS=60*1000;                  // 60秒保持
const FB_PUSH_INTERVAL_MS=1000;                  // 1秒ごとに Firebase へ
const MIN_Y_MAX=100;                             // Y軸 max の下限
const PALETTE=['#E88A0A','#2E8EC4','#c8a030','#5cc8c5','#f5a830','#4aaee0','#a05ec2','#e35c5c','#6dbf6d','#a36df0'];
const MY_COLOR='#3AABA8';

// =============== State ===============
let myId=localStorage.getItem('studentId');
if(!myId){myId=crypto.randomUUID();localStorage.setItem('studentId',myId)}
let myName=localStorage.getItem('myName')||'';
let myMemo='';

let connected=false;
let shared=false;
let demoMode=false;
let serialPort=null, serialReader=null;
let demoIntervals=[];
let demoRestoreName=null;

let localHistory=[];        // [{t, v}] 直近 ~60秒分
let latestValue=null;
let pushInterval=null;      // 共有モード時の FB 書き込みタイマー

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

// v3.2: モードバッジ (観覧中 / 個人モード / 共有中)
function updateModeBadge(){
  const badge=$('modeBadge');
  if(!badge) return;
  badge.classList.remove('viewing','personal','sharing');
  if(shared || demoMode){
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
function trimToWindow(arr){
  const cutoff=Date.now()-KEEP_DURATION_MS-5000;
  while(arr.length>0 && arr[0].t<cutoff) arr.shift();
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
          title:items=>items.length?new Date(items[0].parsed.x).toLocaleTimeString('ja-JP'):'',
          label:c=>c.dataset.label+': '+c.parsed.y+' raw'
        }}
      },
      scales:{
        x:{
          type:'linear',
          ticks:{color:'#6B8180',callback:v=>new Date(v).toLocaleTimeString('ja-JP'),maxTicksLimit:6,font:{size:11}},
          grid:{color:'rgba(58,171,168,0.1)'},
          title:{display:true,text:'時刻',color:'#6B8180',font:{size:11}}
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
  const cutoff=Date.now()-KEEP_DURATION_MS;

  // 詳細表示: 1人だけ
  if(focusedId){
    if(focusedId===myId){
      const pts=localHistory.filter(p=>p.t>=cutoff);
      return [{label:(myName||'自分'),data:pts.map(p=>({x:p.t,y:p.v})),
        borderColor:MY_COLOR,backgroundColor:MY_COLOR+'22',borderWidth:2.5,pointRadius:0,tension:0.25,fill:false}];
    } else {
      const o=othersData[focusedId];
      if(!o) return [];
      const c=colorFor(focusedId);
      const pts=(o.recent||[]).filter(p=>p.t>=cutoff);
      return [{label:o.name||'名前なし',data:pts.map(p=>({x:p.t,y:p.v})),
        borderColor:c,backgroundColor:c+'22',borderWidth:2.5,pointRadius:0,tension:0.25,fill:false}];
    }
  }

  // v3.2: 全モード共通で「自分(あれば) + 他人」を重ねる
  // 観覧中(!connected): 他人のみ
  // 個人モード(connected, !shared): 自分 + 他人 (背景に薄く)
  // 共有中: 自分(太線) + 他人
  const datasets=[];
  if(connected || demoMode){
    const myBorder = shared ? 3 : 2.5;
    datasets.push({label:(myName||'自分')+(shared?' (自分)':''),data:localHistory.filter(p=>p.t>=cutoff).map(p=>({x:p.t,y:p.v})),
      borderColor:MY_COLOR,backgroundColor:MY_COLOR+'22',borderWidth:myBorder,pointRadius:0,tension:0.25,fill:false});
  }
  for(const [id,o] of Object.entries(othersData)){
    if(id===myId) continue;
    const c=colorFor(id);
    // 個人モード(接続中だが未共有)では他人を半透明で背景に
    const isBackground = connected && !shared;
    datasets.push({label:(o.name||'名前なし'),data:(o.recent||[]).filter(p=>p.t>=cutoff).map(p=>({x:p.t,y:p.v})),
      borderColor: isBackground ? c+'88' : c, backgroundColor:c+'22',
      borderWidth: isBackground ? 1.5 : 2, pointRadius:0,tension:0.25,fill:false});
  }
  return datasets;
}

function updateChart(){
  const ch=ensureChart();
  const datasets=computeDatasets();
  ch.data.datasets=datasets;
  // Y軸 auto-scale (max + 20% 余白、最低 MIN_Y_MAX)
  let maxY=0;
  for(const ds of datasets){
    for(const pt of ds.data){
      if(pt.y>maxY) maxY=pt.y;
    }
  }
  const yMax = maxY > 0 ? Math.max(MIN_Y_MAX, Math.ceil(maxY*1.2/50)*50) : MIN_Y_MAX;
  ch.options.scales.y.max=yMax;
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
  const cutoff=Date.now()-KEEP_DURATION_MS;
  const pts=targetHistory.filter(p=>p.t>=cutoff);
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
  $('sumMax').innerHTML=mx+'<span class="summary-unit">raw</span>';
  $('sumAvg').innerHTML=avg+'<span class="summary-unit">raw</span>';
  $('sumMin').innerHTML=mn+'<span class="summary-unit">raw</span>';

  if(shared && focusedId===null){
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

// =============== rAF loop (高頻度描画) ===============
let rafId=null;
function tick(){
  // v3.2: 観覧モードでも他人がいれば描画。常時 update でもよいが負荷軽減のため条件継続。
  if(connected || demoMode || Object.keys(othersData).length>0){
    updateChart();
    updateSummary();
  }
  rafId=requestAnimationFrame(tick);
}

// =============== Serial ===============
async function disconnectSerial(){
  connected=false;
  try{ if(serialReader){ await serialReader.cancel().catch(()=>{}); try{serialReader.releaseLock()}catch(_){}; serialReader=null; } }catch(e){}
  try{ if(serialPort){ await serialPort.close().catch(()=>{}); } }catch(e){}
  serialPort=null;
  if(shared) stopSharing(); // 接続切れたら共有も自動停止
  setStatusPill('観覧中', false);
  const btn=$('serialBtn');
  btn.textContent='🔌 接続';
  btn.classList.remove('connected');
  $('shareBtn').style.display='none';
  $('myVal').textContent='--';
  latestValue=null;
  localHistory=[];
  // v3.2: タイトルを観覧モード文言に。shareArea は他人がいれば残す。
  $('lineChartTitle').textContent = (Object.keys(othersData).length>0) ? '時系列グラフ — みんなの波形 (観覧中)' : '時系列グラフ — 自分の明るさ波形';
  refreshShareAreaVisibility();
  updateModeBadge();
  updateChart();
  updateSummary();
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
    setStatusPill('接続中', true);
    const btn=$('serialBtn');
    btn.textContent='🔌 切断';
    btn.classList.add('connected');
    $('shareBtn').style.display='';
    // デモ中ならデモ停止
    if(demoMode) stopDemo();
    // v3.2: タイトルとバッジ更新
    $('lineChartTitle').textContent='時系列グラフ — 自分の明るさ波形';
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
            // v2.1 由来: 0〜4095 範囲チェック + 急変平滑化 (±50% / ±50 min)
            if(!isNaN(n) && n>=0 && n<=4095){
              if(latestValue===null || Math.abs(n-latestValue) < Math.max(50, latestValue*0.5+30)){
                latestValue=n;
                pushSample(n);
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

function pushSample(v){
  const t=Date.now();
  localHistory.push({t,v});
  trimToWindow(localHistory);
  $('myVal').textContent=v;
}

$('serialBtn').addEventListener('click',()=>{
  if(connected){ disconnectSerial(); }
  else { connectSerial(); }
});

// =============== Sharing ===============
$('shareBtn').addEventListener('click',()=>{
  if(!shared){
    $('modalNameInput').value=myName;
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
  localStorage.setItem('myName', myName);
  $('shareModal').style.display='none';
  startSharing();
});
$('modalNameInput').addEventListener('keydown',e=>{
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
  $('noteAuthor').value=myName;
  $('lineChartTitle').textContent='時系列グラフ — 全員の波形';

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
  const cutoff=Date.now()-KEEP_DURATION_MS;
  const recent=localHistory.filter(p=>p.t>=cutoff);
  db.ref('sessions/'+SESSION_ID+'/students/'+myId).set({
    name: myName,
    memo: myMemo,
    recent: recent,
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
  $('lineChartTitle').textContent = connected ? '時系列グラフ — 自分の明るさ波形' : '時系列グラフ — みんなの波形 (観覧中)';
  refreshShareAreaVisibility();
  updateModeBadge();
  updateSummary();
}

// memo input
$('myMemo').addEventListener('input',e=>{ myMemo=e.target.value; });

// =============== Participants ===============
function renderParticipants(){
  const cards=$('participantCards');
  if(!cards) return;
  const items=[];
  if(connected || demoMode){
    items.push({id:myId, name:(myName||'自分'), suffix:' (自分)', memo:myMemo, recent:localHistory, color:MY_COLOR, isMe:true});
  }
  for(const [id,o] of Object.entries(othersData)){
    items.push({id, name:(o.name||'名前なし'), suffix:'', memo:(o.memo||''), recent:(o.recent||[]), color:colorFor(id), isMe:false});
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
      ${it.memo?`<div class="pc-memo">${escapeHtml(it.memo)}</div>`:''}
    `;
    card.onclick=()=>focusOn(it.id);
    cards.appendChild(card);
  }
}

function focusOn(id){
  focusedId=id;
  let name = (id===myId) ? (myName||'自分') : (othersData[id]?.name||'名前なし');
  $('lineChartTitle').textContent=`${name} の波形`;
  $('backToAllBtn').style.display='';
  renderParticipants();
}

$('backToAllBtn').addEventListener('click',()=>{
  focusedId=null;
  $('lineChartTitle').textContent = shared ? '時系列グラフ — 全員の波形' : '時系列グラフ — 自分の明るさ波形';
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
  let csv='﻿名前,時刻,raw値,メモ\n';
  if(connected || demoMode){
    const myLabel=myName||'自分';
    for(const p of localHistory){
      csv += `"${myLabel}",${new Date(p.t).toISOString()},${p.v},"${myMemo||''}"\n`;
    }
  }
  for(const [id,o] of Object.entries(othersData)){
    for(const p of (o.recent||[])){
      csv += `"${o.name||'名前なし'}",${new Date(p.t).toISOString()},${p.v},"${o.memo||''}"\n`;
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

  // デモ用に自分の名前/メモを仮設定 (LocalStorage は触らない)
  demoRestoreName=myName;
  myName='教室中央チーム';
  myMemo='教室中央';

  // 自分の履歴を初期化
  const now=Date.now();
  localHistory=[];
  for(let i=60;i>=0;i--) localHistory.push({t:now-i*1000, v:jitter(1280)});

  // 共有エリアを擬似的に表示 (Firebase は使わない)
  shared=true;
  $('shareArea').style.display='';
  $('shareBtn').style.display='';
  $('shareBtn').textContent='✓ 共有中 (タップで停止)';
  $('shareBtn').classList.add('sharing');
  $('memoBox').style.display='';
  $('myMemo').value=myMemo;
  $('noteAuthor').value=myName;
  $('lineChartTitle').textContent='時系列グラフ — 全員の波形';

  // 他チームの履歴を生成
  othersData={};
  DEMO_GROUPS.forEach((g,i)=>{
    if(g.name==='教室中央チーム') return;
    const recent=[];
    for(let k=60;k>=0;k--) recent.push({t:now-k*1000, v:jitter(g.base)});
    othersData['demo-'+i]={name:g.name, memo:g.memo, recent:recent, updatedAt:now};
  });

  renderParticipants();
  renderNotes({demo1:{name:'教室中央チーム', text:'窓際チームは引き出しチームの約15倍明るかった！', createdAt:now}});
  $('myVal').textContent=localHistory[localHistory.length-1].v;

  updateModeBadge();
  // 連続更新 (300ms ごと)
  demoIntervals.push(setInterval(()=>{
    const n=Date.now();
    localHistory.push({t:n, v:jitter(1280)});
    trimToWindow(localHistory);
    $('myVal').textContent=localHistory[localHistory.length-1].v;
    DEMO_GROUPS.forEach((g,i)=>{
      if(g.name==='教室中央チーム') return;
      const k='demo-'+i;
      if(!othersData[k]) return;
      othersData[k].recent.push({t:n, v:jitter(g.base)});
      trimToWindow(othersData[k].recent);
      othersData[k].updatedAt=n;
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
  $('myVal').textContent='--';
  localHistory=[];
  // v3.2: デモ用に詰めた擬似 othersData を消去。Firebase 由来の本物は購読が継続更新する。
  othersData={};
  focusedId=null;
  $('backToAllBtn').style.display='none';
  $('lineChartTitle').textContent='時系列グラフ — 自分の明るさ波形';
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
$('lineChartTitle').textContent='時系列グラフ — 自分の明るさ波形';
subscribeToOthers();
tick();
