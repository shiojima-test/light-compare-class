// Firebase config
const FIREBASE_CONFIG={apiKey:"REPLACE_ME",authDomain:"REPLACE_ME",databaseURL:"REPLACE_ME",projectId:"REPLACE_ME",storageBucket:"REPLACE_ME",messagingSenderId:"REPLACE_ME",appId:"REPLACE_ME"};
firebase.initializeApp(FIREBASE_CONFIG);
const db=firebase.database();

let studentId=localStorage.getItem('studentId');
if(!studentId){studentId=crypto.randomUUID();localStorage.setItem('studentId',studentId)}
let currentSessionId=null,joined=false,serialPort=null,serialReader=null,latestValue=null,serialWriteInterval=null,historyInterval=null,studentsRef=null,notesRef=null,demoMode=false,demoIntervals=[],barChart=null,lineChart=null,studentsData={};
const PALETTE=['#3AABA8','#E88A0A','#2E8EC4','#F5E4C4','#5cc8c5','#f5a830','#4aaee0','#e8d09e','#c8a030','#7ab5b3'];
const NOTE_COLORS=['#E88A0A','#3AABA8','#2E8EC4','#F5E4C4','#5cc8c5','#f5a830'];

function updateClock(){document.getElementById('clock').textContent=new Date().toLocaleTimeString('ja-JP')}
setInterval(updateClock,1000);updateClock();

const mySessionInput=document.getElementById('mySession');
const joinBtn=document.getElementById('joinBtn');
mySessionInput.addEventListener('input',()=>{joinBtn.disabled=!mySessionInput.value.trim()});

joinBtn.addEventListener('click',()=>{
  const name=document.getElementById('myName').value.trim()||'名無し';
  const sessionId=mySessionInput.value.trim();
  const memo=document.getElementById('myMemo').value.trim();
  if(!sessionId)return;
  currentSessionId=sessionId;joined=true;
  document.getElementById('sessionCodeDisp').textContent=sessionId;
  document.getElementById('noteAuthor').value=name;
  db.ref('sessions/'+sessionId+'/students/'+studentId).set({name,memo,current:0,updatedAt:Date.now(),history:[]});
  const pill=document.getElementById('statusPill');
  pill.classList.add('live');pill.querySelector('.pulse').classList.add('live');
  document.getElementById('statusText').textContent='接続中';
  subscribeToSession(sessionId);
});

function subscribeToSession(sid){
  if(studentsRef)studentsRef.off();if(notesRef)notesRef.off();
  studentsRef=db.ref('sessions/'+sid+'/students');
  notesRef=db.ref('sessions/'+sid+'/notes');
  studentsRef.on('value',s=>{studentsData=s.val()||{};renderAll()});
  notesRef.orderByChild('createdAt').limitToLast(10).on('value',s=>{renderNotes(s.val()||{})});
}

function renderAll(){
  const entries=Object.entries(studentsData).map(([id,d])=>({id,...d}));
  entries.sort((a,b)=>(b.current||0)-(a.current||0));
  renderSummary(entries);renderBarChart(entries);renderTable(entries);renderLineChart(entries);
}

function renderSummary(entries){
  if(!entries.length){
    document.getElementById('sumMax').innerHTML='--<span class="summary-unit">raw</span>';
    document.getElementById('sumAvg').innerHTML='--<span class="summary-unit">raw</span>';
    document.getElementById('sumMin').innerHTML='--<span class="summary-unit">raw</span>';
    document.getElementById('sumCount').innerHTML='0<span class="summary-unit">人</span>';
    document.getElementById('sumMaxWho').textContent='';
    document.getElementById('sumMinWho').textContent='';
    document.getElementById('sumUpdated').textContent='最終更新: --';return;
  }
  const mx=entries[0],mn=entries[entries.length-1];
  const avg=Math.floor(entries.reduce((s,e)=>s+(e.current||0),0)/entries.length);
  const lt=Math.max(...entries.map(e=>e.updatedAt||0));
  document.getElementById('sumMax').innerHTML=(mx.current||0)+'<span class="summary-unit">raw</span>';
  document.getElementById('sumMaxWho').innerHTML='<span>'+mx.name+'</span>';
  document.getElementById('sumAvg').innerHTML=avg+'<span class="summary-unit">raw</span>';
  document.getElementById('sumAvgWho').textContent=entries.length+'人の平均';
  document.getElementById('sumMin').innerHTML=(mn.current||0)+'<span class="summary-unit">raw</span>';
  document.getElementById('sumMinWho').innerHTML='<span>'+mn.name+'</span>';
  document.getElementById('sumCount').innerHTML=entries.length+'<span class="summary-unit">人</span>';
  document.getElementById('sumUpdated').textContent='最終更新: '+(lt?new Date(lt).toLocaleTimeString('ja-JP'):'--');
}

function renderBarChart(entries){
  const ctx=document.getElementById('barChart');
  const labels=entries.map(e=>e.name),data=entries.map(e=>e.current||0),memos=entries.map(e=>e.memo||'');
  const colors=entries.map((_,i)=>{if(i===0)return'#E88A0A';if(i<=2)return'#3AABA8';if(i===entries.length-1&&entries.length>3)return'#2E8EC4';return'#8DC8C6'});
  if(barChart)barChart.destroy();
  barChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[{data,backgroundColor:colors,borderRadius:4,maxBarThickness:40}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:c=>memos[c.dataIndex]?'条件: '+memos[c.dataIndex]:''}}},
    scales:{x:{ticks:{color:'#6B8180',font:{size:11}},grid:{display:false}},y:{ticks:{color:'#6B8180'},grid:{color:'rgba(58,171,168,0.1)'}}}}});
  ctx.parentElement.style.background='#F5F2EC';ctx.parentElement.style.borderRadius='8px';
}

function renderTable(entries){
  document.getElementById('participantBody').innerHTML=entries.map((e,i)=>{
    const r=i+1,rc=r===1?'rank-1-text':r===2?'rank-2-text':r===3?'rank-3-text':'';
    const ago=e.updatedAt?Math.floor((Date.now()-e.updatedAt)/1000)+'秒前':'--';
    return'<tr><td class="p-rank '+rc+'">'+r+'</td><td class="p-name">'+e.name+'</td><td class="p-current">'+(e.current||0)+' <span class="p-unit">raw</span></td><td><span class="p-memo">'+(e.memo||'')+'</span></td><td class="p-time">'+ago+'</td></tr>';
  }).join('');
}

function renderLineChart(entries){
  const ctx=document.getElementById('lineChart');
  const t0=Date.now()-5*60*1000;
  const datasets=entries.map((e,i)=>{
    const h=Array.isArray(e.history)?e.history.filter(h=>h.t>=t0):[];
    return{label:e.name,data:h.map(h=>({x:h.t,y:h.v})),borderColor:PALETTE[i%PALETTE.length],backgroundColor:'transparent',borderWidth:2,pointRadius:0,tension:.3};
  });
  if(lineChart)lineChart.destroy();
  lineChart=new Chart(ctx,{type:'line',data:{datasets},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#6B8180',font:{size:10}}}},
    scales:{x:{type:'linear',min:t0,max:Date.now(),ticks:{color:'#6B8180',callback:v=>new Date(v).toLocaleTimeString('ja-JP'),maxTicksLimit:6},grid:{color:'rgba(58,171,168,0.1)'}},
    y:{ticks:{color:'#6B8180'},grid:{color:'rgba(58,171,168,0.1)'}}}}});
}

function renderNotes(obj){
  const list=document.getElementById('notesList');
  const notes=Object.values(obj).sort((a,b)=>b.createdAt-a.createdAt);
  const ac={};let ci=0;
  list.innerHTML=notes.map(n=>{
    if(!ac[n.name]){ac[n.name]=NOTE_COLORS[ci%NOTE_COLORS.length];ci++}
    return'<div class="note-item" style="border-left-color:'+ac[n.name]+'"><div class="note-meta"><span class="note-author">'+n.name+'</span><span>'+new Date(n.createdAt).toLocaleTimeString('ja-JP')+'</span></div><div class="note-text">'+n.text+'</div></div>';
  }).join('');
}

document.getElementById('noteSubmit').addEventListener('click',()=>{
  if(!currentSessionId)return;
  const a=document.getElementById('noteAuthor').value.trim()||'名無し';
  const t=document.getElementById('noteText').value.trim();
  if(!t)return;
  db.ref('sessions/'+currentSessionId+'/notes').push({name:a,text:t,createdAt:Date.now()});
  document.getElementById('noteText').value='';
});

document.getElementById('serialBtn').addEventListener('click',async()=>{
  if(!joined){alert('先にセッションに参加してください');return}
  if(serialPort)return;
  try{
    serialPort=await navigator.serial.requestPort();
    await serialPort.open({baudRate:9600});
    const btn=document.getElementById('serialBtn');btn.textContent='🔗 接続中';btn.classList.add('connected');
    const dec=new TextDecoderStream();serialPort.readable.pipeTo(dec.writable);
    const reader=dec.readable.getReader();serialReader=reader;let buf='';
    (async()=>{while(true){const{value,done}=await reader.read();if(done)break;buf+=value;const lines=buf.split('\n');buf=lines.pop();for(const l of lines){const n=parseInt(l.trim(),10);if(!isNaN(n)){latestValue=n;document.getElementById('myVal').textContent=n}}}})();
    serialWriteInterval=setInterval(()=>{if(latestValue!==null&&currentSessionId){db.ref('sessions/'+currentSessionId+'/students/'+studentId+'/current').set(latestValue);db.ref('sessions/'+currentSessionId+'/students/'+studentId+'/updatedAt').set(Date.now())}},1000);
    historyInterval=setInterval(()=>{if(latestValue!==null&&currentSessionId){const hr=db.ref('sessions/'+currentSessionId+'/students/'+studentId+'/history');hr.once('value',s=>{let h=s.val()||[];if(!Array.isArray(h))h=Object.values(h);h.push({t:Date.now(),v:latestValue});if(h.length>300)h=h.slice(h.length-300);hr.set(h)})}},10000);
  }catch(e){console.error('Serial error:',e)}
});

const DEMO_PARTICIPANTS=[
  {name:'田中 あおい',memo:'窓際・直射日光',base:2840},
  {name:'山本 こうた',memo:'廊下・蛍光灯',base:1950},
  {name:'鈴木 はな',  memo:'教室中央',      base:1280},
  {name:'佐藤 りく',  memo:'机の下',        base:890},
  {name:'高橋 みなと',memo:'カバンの中',    base:420},
  {name:'中村 さら',  memo:'引き出しの中',  base:193}
];
const DEMO_TIMELINE_NAMES=['田中 あおい','鈴木 はな','中村 さら'];

document.getElementById('demoBtn').addEventListener('click',()=>{demoMode?stopDemo():startDemo()});

function jitter(base){return Math.max(0,base+Math.floor((Math.random()-0.5)*base*0.06))}

function buildDemoHistory(base){
  const now=Date.now(),pts=[];
  for(let i=30;i>=0;i--){pts.push({t:now-i*10000,v:jitter(base)})}
  return pts;
}

function startDemo(){
  demoMode=true;currentSessionId='CLASS-2025-B';
  // Header
  document.getElementById('mySession').value='CLASS-2025-B';
  document.getElementById('sessionCodeDisp').textContent='CLASS-2025-B';
  document.getElementById('demoBadge').style.display='';
  const btn=document.getElementById('demoBtn');btn.classList.add('active');btn.textContent='デモ停止';
  const pill=document.getElementById('statusPill');pill.classList.add('live');pill.querySelector('.pulse').classList.add('live');
  document.getElementById('statusText').textContent='接続中';
  // MY DEVICE
  document.getElementById('myName').value='鈴木 はな';
  document.getElementById('myMemo').value='教室中央';
  document.getElementById('myVal').textContent='1280';
  document.getElementById('noteAuthor').value='鈴木 はな';
  // Build studentsData locally (no Firebase)
  const now=Date.now();
  studentsData={};
  DEMO_PARTICIPANTS.forEach((p,i)=>{
    const hasTimeline=DEMO_TIMELINE_NAMES.includes(p.name);
    studentsData['demo-'+i]={name:p.name,memo:p.memo,current:p.base,updatedAt:now,history:hasTimeline?buildDemoHistory(p.base):[]};
  });
  renderAll();
  // Notes
  renderNotes({'demo-note-1':{name:'鈴木 はな',text:'窓際は引き出しの中の約15倍明るかった！',createdAt:now}});
  // Jitter interval — fluctuate values every 1.5s
  demoIntervals.push(setInterval(()=>{
    DEMO_PARTICIPANTS.forEach((p,i)=>{
      const d=studentsData['demo-'+i];if(!d)return;
      d.current=jitter(p.base);d.updatedAt=Date.now();
      if(DEMO_TIMELINE_NAMES.includes(p.name)){d.history.push({t:Date.now(),v:d.current});if(d.history.length>300)d.history=d.history.slice(-300)}
    });
    // MY DEVICE value
    const me=studentsData['demo-2'];if(me)document.getElementById('myVal').textContent=me.current;
    renderAll();
  },1500));
}

function stopDemo(){
  demoMode=false;demoIntervals.forEach(clearInterval);demoIntervals=[];
  document.getElementById('demoBadge').style.display='none';
  const btn=document.getElementById('demoBtn');btn.classList.remove('active');btn.textContent='デモ';
  const pill=document.getElementById('statusPill');pill.classList.remove('live');pill.querySelector('.pulse').classList.remove('live');
  document.getElementById('statusText').textContent='待機中';
  document.getElementById('sessionCodeDisp').textContent='---';
  document.getElementById('myName').value='';document.getElementById('myMemo').value='';
  document.getElementById('myVal').textContent='--';document.getElementById('noteAuthor').value='';
  document.getElementById('notesList').innerHTML='';
  currentSessionId=null;studentsData={};renderAll();
}

document.getElementById('csvBtn').addEventListener('click',()=>{
  if(!currentSessionId)return;
  const entries=Object.values(studentsData);
  let csv='\uFEFF名前,時刻,センサー値,条件メモ\n';
  entries.forEach(e=>{const h=Array.isArray(e.history)?e.history:(e.history?Object.values(e.history):[]);h.forEach(p=>{csv+='"'+e.name+'",'+new Date(p.t).toISOString()+','+p.v+',"'+(e.memo||'')+'"\n'})});
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const a=document.createElement('a');
  const d=new Date(),ds=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  a.href=URL.createObjectURL(blob);a.download='light-compare-'+currentSessionId+'-'+ds+'.csv';a.click();
});
