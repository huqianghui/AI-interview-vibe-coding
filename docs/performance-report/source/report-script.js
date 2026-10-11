'use strict';
const D = JSON.parse(document.getElementById('report-data').textContent);
const el = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const num = (x, dp=0) => valid(x) ? x.toLocaleString('en-US',{maximumFractionDigits:dp}) : '—';
const ms = x => valid(x) ? (x >= 1000 ? num(x/1000,3)+' s' : num(x,1)+' ms') : '—';
const short = x => String(x ?? '').slice(0,8);
const norm = x => String(x ?? '').replace(/\.+$/,'');
const ts = x => new Date(x).getTime();
const tzfmt = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const cst = x => tzfmt.format(new Date(x));
const clock = x => new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(x));
const code = x => '<code>'+esc(x)+'</code>';
const table = (headers,rows,cls='') => '<table class="'+cls+'"><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
const wrapTable = (headers,rows) => '<div class="tablewrap">'+table(headers,rows)+'</div>';
const colors = ['#087f8c','#3c68c7','#b57a20','#7957b0','#188270','#b44842'];
const metricNames = {
 click_to_audible_ms:'点击完成 → 下一句起音',commit_wait_ms:'点击 → 开始提交',answer_http_ms:'提交 → 收到回答接口结果',answer_to_read_ms:'回答结果 → 发读题请求',read_to_created_ms:'读题请求 → response.created',created_to_audible_ms:'response.created → 起音检测',stt_ms:'VAD stop → 最终转写',stop_to_audible_ms:'VAD stop → 下一句起音',
 ws_open_ms:'connect_start → 浏览器 WS open',proxy_connected_ms:'connect_start → 代理已接上游',session_updated_ms:'connect_start → session.updated',first_video_frame_ms:'connect_start → 首帧检测',first_audible_ms:'connect_start → 首次起音检测',
 total_ms:'Avatar 握手总长',ice_gather_ms:'offer 创建 → 发送 gate',sdp_answer_ms:'offer 发送 → answer 收到',ice_connect_ms:'answer applied → ICE connected',pc_connect_ms:'answer applied → PC connected',first_frame_ms:'ICE connected → 首帧',rtt_ms:'WebRTC 候选对 RTT'
};
el('workbook-link').href='https://portal.azure.com/#@16b3c013-d300-468d-ac64-7eda0820b6d3/resource/subscriptions/7a03e9b8-18d6-48e7-b186-0ec68da9e86f/resourceGroups/rg-aiinterview-public-swedencentral/providers/Microsoft.Insights/workbooks/79286b13-2e6f-53d2-834e-64274d49d7be/workbook';

const protocolText = {
 avatar:'<span class="tag measured">4 次真实建连 · 7 个完整回答</span><h3>数字人：双路径同时工作</h3><p class="path">麦克风 / 控制：Browser → 前端 Nginx → FastAPI → Azure Voice Live（WSS）<br>声音 / 画面：Azure 媒体服务 → TURN relay → Browser（WebRTC）</p><p>本次候选对都是 relay / UDP；WebRTC 的包不会逐帧经过应用容器。蓝色 WS 既传麦克风，也传读题控制、转写和 WebRTC 建连所需的信令。某条 WS 的连接寿命，不能当作该场 WebRTC 起音延迟。</p>',
 audioOnly:'<span class="tag code">代码支持 · 本次无实测样本</span><h3>关闭画面后，声音仍可走 WebRTC</h3><p class="path">切换后会重建 Voice Live 会话和 WebRTC 连接；新连接的视频 transceiver 设为 inactive，只接收 WebRTC 音轨。麦克风与控制仍走 WS。</p><p>这不是在原连接里无缝关闭画面，重建会带来切换等待；仍保留 Avatar 会话路径，不能把它视为取消 Avatar 配额占用。它可减少视频传输与解码工作，但不会把音频自动切为 WS PCM。本次只有 mode=video，无法给出 audio-only 的启动时间、节省幅度或起音排名。</p>',
 ws:'<span class="tag code">代码支持 · 本次无实测样本</span><h3>无 Avatar：语音上下行都经过 WS 代理</h3><p class="path">Browser ⇄ Nginx ⇄ FastAPI ⇄ Azure Voice Live（WSS）<br>下行 PCM → 前端 AudioWorklet → 播放</p><p>代码使用 24 kHz 下行 PCM，并有 300 ms 播放缓冲。WS 起音标记来自 Worklet 实际渲染样本；本次 WebRTC 起音来自接收器 audioLevel，测量点不同。协议对比应先统一“用户实际听到”的边界，再用相同网络与内容作对照。</p>'
};
function showProtocol(key){el('protocol-description').innerHTML=protocolText[key];document.querySelectorAll('[data-protocol]').forEach(b=>{const active=b.dataset.protocol===key;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
el('protocol-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-protocol]');if(b)showProtocol(b.dataset.protocol);});
showProtocol('avatar');

function stageRow(label,start,end,total,color,rawLabel){
 if(!valid(start)||!valid(end)||end<start)return '<div class="stage-line"><span>'+esc(label)+'</span><span class="muted">未取得有效配对</span><span>—</span></div>';
 const left=Math.max(0,Math.min(100,start/total*100));const width=Math.max(.2,Math.min(100-left,(end-start)/total*100));
 return '<div class="stage-line"><span class="stage-label">'+esc(label)+'</span><div class="track"><span class="bar" style="left:'+left+'%;width:'+width+'%;background:'+color+'" title="'+esc((rawLabel||label)+'：+'+num(start,1)+' 至 +'+num(end,1)+' ms')+'"></span></div><span class="val">'+ms(end-start)+'</span></div>';
}
function stageCandidates(kind){return D.voice.filter(x=>kind==='turn'?x.name==='voice.turn'&&x.turn_kind==='answer'&&x.heard==='true':kind==='setup'?x.name==='voice.setup'&&x.outcome==='heard':x.name==='voice.avatar');}
function loadStageSamples(){
 const kind=el('stage-kind').value,xs=stageCandidates(kind);
 el('stage-sample').innerHTML=xs.map((x,i)=>'<option value="'+i+'">'+esc(cst(x.timestamp)+' · '+short(x.operation_Id)+(kind==='turn'?' · 回合 '+x.turn_index:'')+' · '+ms(x.measurements[kind==='turn'?'click_to_audible_ms':kind==='setup'?'first_audible_ms':'total_ms']))+'</option>').join('');
 if(kind==='turn')el('stage-sample').value=String(xs.findIndex(x=>x.measurements.click_to_audible_ms===1234));
 renderStage();
}
function renderStage(){
 const kind=el('stage-kind').value,x=stageCandidates(kind)[+el('stage-sample').value],m=x.measurements;
 let rows=[],total=0,title='',note='',side='',base=0;
 if(kind==='turn'){
  base=m.t_answer_click;total=m.t_first_audible-base;title='一次正式回答：'+ms(m.click_to_audible_ms);
  const points=[['点击 → 提交','t_answer_click','t_answer_submit'],['回答接口往返','t_answer_submit','t_answer_response'],['发出读题请求','t_answer_response','t_read_request'],['Voice Live 接受读题','t_read_request','t_response_created'],['created → 起音检测','t_response_created','t_first_audible']];
  rows=points.map((p,i)=>stageRow(p[0],m[p[1]]-base,m[p[2]]-base,total,colors[i]));
  note='图中 0 是点击“完成回答”。条形使用同一事件的 t_* 偏移相减；每个原始 *_ms 独立取整，可能与条形有 1–2 ms 差异。';
  side='<h3>用户在点击之前，已经过哪些等待？</h3><p>最后一次 VAD stop → 最终转写 <b>'+ms(m.stt_ms)+'</b>；最终转写 → 点击 <b>'+ms(m.t_answer_click-m.t_transcript)+'</b>。两者不包含在点击后的 '+ms(m.click_to_audible_ms)+' 内。</p><p>点击后最主要的两段，是回答接口往返和 Voice Live 接受读题后的起音等待。这里读的是已确定文本，不能把后半段直接称为“LLM 生成下一题”。</p><div class="metric-grid"><div class="metric-small"><b>'+ms(m.stop_to_audible_ms)+'</b><span>VAD stop → 起音</span></div><div class="metric-small"><b>'+ms(m.created_to_audible_ms)+'</b><span>created → 起音</span></div></div>';
 } else if(kind==='setup'){
  total=m.t_first_audible;title='连接建立：'+ms(m.first_audible_ms)+' 后检测到起音';
  const points=[['打开浏览器 WS','t_connect_start','t_ws_open'],['等待上游代理连接','t_ws_open','t_proxy_connected'],['等待 session.updated','t_proxy_connected','t_session_updated'],['session ready → 首帧','t_session_updated','t_first_video_frame'],['首帧 → 首次起音','t_first_video_frame','t_first_audible']];
  rows=points.map((p,i)=>stageRow(p[0],m[p[1]],m[p[2]],total,colors[i]));
  note='图中 0 是 connect_start。原始 ws_open_ms、session_updated_ms 等是从同一个起点累计的里程碑，不能直接求和。';
  side='<h3>“连上 WS”只是第一步</h3><p>浏览器 WS open 出现在 <b>+'+ms(m.ws_open_ms)+'</b>，真正的 session.updated 在 <b>+'+ms(m.session_updated_ms)+'</b>，数字人首帧在 <b>+'+ms(m.first_video_frame_ms)+'</b>。</p><p>首帧到首次起音还可能受 orientation / 开始读题的用户动作影响。这里显示的是这条记录的全流程，不将全部时间认定为服务初始化。</p>';
 } else {
  total=m.t_first_frame;title='Avatar 握手：'+ms(m.total_ms)+' 到首帧检测';
  const points=[['创建 SDP offer','t_offer_start','t_offer_created'],['候选收集 / 发送 gate','t_offer_created','t_offer_sent'],['等待 SDP answer','t_offer_sent','t_answer_received'],['应用 answer','t_answer_received','t_answer_applied'],['answer applied → ICE','t_answer_applied','t_ice_connected'],['ICE connected → 首帧','t_ice_connected','t_first_frame']];
  rows=points.map((p,i)=>stageRow(p[0],m[p[1]],m[p[2]],total,colors[i]));
  rows.push('<div class="subtle" style="margin-top:18px">下面是重叠的观察区间，不再叠加到总长：</div>'+stageRow('answer applied → PC',m.t_answer_applied,m.t_pc_connected,total,'#7a8f9d'));
  note='条形坐标 0 为 PC 创建；标题 total_ms 从 offer_start 起算，本次两者相差 0–1 ms。首个 srflx 与 relay 候选是在并行收集过程中出现的里程碑；ICE connected 与 PC connected 也不是两项可相加的独立等待。';
  side='<h3>该连接选择的媒体路径</h3><p><b>'+esc(x.local_candidate)+' / '+esc(x.remote_candidate)+' / '+esc(x.protocol.toUpperCase())+'</b>；relay transport '+esc(x.relay_protocol)+'.</p><div class="metric-grid"><div class="metric-small"><b>+'+ms(m.t_first_srflx)+'</b><span>首个 srflx</span></div><div class="metric-small"><b>+'+ms(m.t_first_relay)+'</b><span>首个 relay</span></div><div class="metric-small"><b>'+ms(m.rtt_ms)+'</b><span>候选对 RTT</span></div></div><p>代码已在获得可用候选后提前发送 offer；ICE 之后仍有 '+ms(m.first_frame_ms)+' 才看到首帧。该段包含后续建连、媒体到达与前端检测。</p>';
 }
 el('stage-content').innerHTML='<div class="operation-header"><div><span class="tag measured">单条真实事件</span><h3>'+title+'</h3></div><div class="subtle">'+esc(cst(x.timestamp))+'（事件记录时刻）<br>operation '+code(x.operation_Id)+'</div></div><div class="stage-info"><div><div class="axis"><span>0</span><span>'+ms(total)+'</span></div><div class="stages">'+rows.join('')+'</div><p class="footnote">'+note+'</p></div><div class="stage-side">'+side+'</div></div><details><summary>查看这条事件的原始计时与 ID</summary><div><p>itemId '+code(x.itemId)+'；interview '+code(x.interview_id)+'</p><pre>'+esc(JSON.stringify(m,null,2))+'</pre><p class="subtle">customEvent.timestamp 是发出事件的时刻，不能直接作为图中 0 点。</p></div></details>';
}
el('stage-kind').addEventListener('change',loadStageSamples);el('stage-sample').addEventListener('change',renderStage);loadStageSamples();
el('stage-distributions').innerHTML=['turn','setup','avatar'].map((kind,i)=>'<h3>'+['正式回答 · N=7','连接累计里程碑 · N=4','Avatar 握手区间 · N=4'][i]+'</h3>'+wrapTable(['指标','有效 N','P50','P95¹','范围'],Object.entries(D.summary[kind]).map(([k,s])=>[esc(metricNames[k]||k)+'<br>'+code(k),num(s.n),ms(s.p50),ms(s.p95),ms(s.min)+' – '+ms(s.max)]))).join('')+'<p class="footnote">¹ 这三组样本很小，最近秩 P95 都等于观测最大值；保留它仅用于核对 Workbook，不能作为稳定尾延迟结论。各阶段中位数不保证相加等于总长中位数。</p>';

const opNames={
 '3a840de59c2c4de6a8bc814e0bdfc6fe':'10/10 11:52 · 正常语音，2 个回答',
 '7bff59c8010e4069bc39b9067ea3e42d':'10/10 14:08 · 正常语音，3 个回答',
 '48944196d9a3401fb10388e9b62f32ad':'10/10 14:39 · 2 个回答，pagehide 关闭',
 '17f1202013e449e7a1a5696a94bb3b55':'10/10 16:12 · 长会话，后续 AUTH_FAILED',
 '99f8fb5a3229ee32b266ade4ce1c9ee3':'10/09 02:09 · 46.536 秒评分报告',
 '9e3df9b32907b672bd6cc0961bbf5db3':'10/09 06:21 · 70.417 秒报告与附加审计'
};
const nodeKind = x => x.node_type==='browser' ? '浏览器 '+x.type : x.node_type==='request'?'后端请求':x.node_type==='pageView'?'页面':x.type==='HTTP'?'后端 HTTP':x.type==='Azure blob'?'Blob 依赖':'业务 span';
const nodeColor = x => x.node_type==='browser'?'#3c68c7':x.node_type==='request'?'#087f8c':x.type==='HTTP'?'#7957b0':x.node_type==='pageView'?'#78929f':'#b57a20';
const cleanName = x => x.name.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi,'{id}').replace('/api/projects/avarda-demo-prj/openai/v1/responses','Responses API');
function timelineGroups(xs){
 const sorted=[...xs].sort((a,b)=>ts(a.timestamp)-ts(b.timestamp)),groups=[];
 let end=-Infinity;
 sorted.forEach(x=>{const start=ts(x.timestamp);if(!groups.length||start-end>60000)groups.push([]);groups[groups.length-1].push(x);end=Math.max(end,start+x.duration);});return groups;
}
function traceTimeline(xs){
 if(!xs.length)return '<div class="empty">这个视图没有可绘制的 span。</div>';
 const groups=timelineGroups(xs);
 return '<div class="legend"><span><i class="dot" style="background:#3c68c7"></i>浏览器</span><span><i class="dot"></i>后端请求</span><span><i class="dot" style="background:#7957b0"></i>后端 HTTP</span><span><i class="dot" style="background:#b57a20"></i>业务 / 存储</span></div><p class="footnote">'+(groups.length>1?'按超过 60 秒的空档分成 '+groups.length+' 组，每组独立缩放；绝对起点如下。':'同一坐标保留调用并行关系。')+' 跨浏览器与服务器的墙钟未经额外校准；条长取各自 duration，细分阶段以事件内单调时钟为准。</p>'+groups.map((g,gi)=>{
  const start=Math.min(...g.map(x=>ts(x.timestamp))),end=Math.max(...g.map(x=>ts(x.timestamp)+x.duration)),length=Math.max(1,end-start);
  return '<div class="countline">'+(groups.length>1?'片段 '+(gi+1)+' · ':'')+esc(cst(start))+' 起 · 坐标跨度 '+ms(length)+'</div><div class="trace-container">'+g.map(x=>'<div class="timeline-row"><span class="name" title="'+esc(nodeKind(x)+' · '+x.name+' · '+x.id)+'">'+esc(nodeKind(x)+' · '+cleanName(x))+'</span><div class="track"><span class="bar" style="left:'+((ts(x.timestamp)-start)/length*100)+'%;width:'+Math.max(.15,x.duration/length*100)+'%;background:'+nodeColor(x)+'" title="'+esc(cst(x.timestamp)+' · '+ms(x.duration)+' · '+x.id)+'"></span></div><span class="val">'+ms(x.duration)+'</span></div>').join('')+'</div>';
 }).join('');
}
el('operation-select').innerHTML=Object.entries(opNames).map(([id,label])=>'<option value="'+id+'">'+esc(label)+' · '+short(id)+'</option>').join('');
el('operation-select').value=D.voice_ops[1];
function renderOperation(){
 const op=el('operation-select').value,xs=D.trace.filter(x=>x.operation_Id===op),events=D.voice.filter(x=>x.operation_Id===op),answers=events.filter(x=>x.name==='voice.turn'&&x.turn_kind==='answer'),ws=xs.filter(x=>x.type==='WebSocket'),sessions=xs.filter(x=>x.name==='voice.session'),media=events.filter(x=>x.name==='voice.media'),pairs=D.pairs.filter(x=>x.operation_Id===op);
 const lifecycles=xs.filter(x=>x.type==='WebSocket'||x.name==='voice.session'||x.node_type==='pageView');
 const notes=op===D.voice_ops[0]?'这个早期浏览器 operation 没有关联的 WS / voice.session span，也没有媒体窗口；4 条 Fetch 已精确匹配，3 个 voice.turn 保留。不能把缺少关联解读为未建立语音。':op===D.voice_ops[1]?'3 个回答回合、4 个媒体窗口；浏览器 WS span 未归入此 operation，后端 voice.session 已关联。':op===D.voice_ops[2]?'2 个回答的点击到起音为 1.366 / 1.449 秒；浏览器 WS 以 1001 / pagehide 结束，不能按普通 HTTP 错误解释。':op===D.voice_ops[3]?'本场没有完整 answer 回合；有 opening / aside、66 个媒体窗口，以及后续 3 次 AUTH_FAILED。原连接结束点由 duration 推算，不能据此补全挂起期间的墙钟轨迹。':'报告请求的父子关系保留；详细的逐题并发与附加工作请见第 08 节。';
 el('operation-content').innerHTML='<div class="operation-header"><div class="op-id">'+code(op)+'<button class="noprint" data-copy="'+op+'">复制 operation ID</button></div><span class="tag measured">'+xs.length+' 条 span / 页面记录</span></div><div class="smallstat"><span><b>'+pairs.length+'</b> 对关联 Fetch</span><span><b>'+answers.length+'</b> 完整回答</span><span><b>'+media.length+'</b> 媒体窗口</span><span><b>'+events.length+'</b> 自定义事件</span></div><p>'+notes+'</p>'+(lifecycles.length?'<details><summary>页面、WS 与 voice.session 的独立记录（'+lifecycles.length+'）</summary><div>'+wrapTable(['类型','开始时间（北京）','记录时长','结果 / 关闭原因'],lifecycles.map(x=>[esc(nodeKind(x)+' · '+x.name),esc(cst(x.timestamp)),ms(x.duration),esc((x.resultCode||'—')+(x.close_reason?' / '+x.close_reason:'')+(x.live?' / live='+x.live:''))]))+'<p class="subtle">WS / voice.session 时长通常覆盖整段连接；页面记录 duration 是页面加载值。三者都不等同单次用户回答响应。</p></div></details>':'');
 const showLife=el('trace-lifecycle').checked;
 const graph=xs.filter(x=>valid(x.duration)&&!x.name.startsWith('fastapi.')&&(showLife||!lifecycles.includes(x)));
 el('operation-timeline').innerHTML=traceTimeline(graph);
 const map=new Map(xs.map(x=>[norm(x.id),x]));
 function depth(x,seen=new Set()){const id=norm(x.id),p=norm(x.operation_ParentId);if(seen.has(id)||id===p||!map.has(p)||seen.size>6)return 0;seen.add(id);return 1+depth(map.get(p),seen);}
 const sorted=[...xs].sort((a,b)=>ts(a.timestamp)-ts(b.timestamp));
 el('operation-table').innerHTML=wrapTable(['开始时间（北京）','节点与父子层级¹','时长','结果','span ID','parent ID'],sorted.map(x=>[esc(cst(x.timestamp)),'<span style="padding-left:'+Math.min(depth(x),5)*12+'px">'+esc(nodeKind(x)+' · '+x.name)+'</span>',ms(x.duration),esc(x.resultCode||'—'),code(x.id),code(x.operation_ParentId)]))+'<p class="footnote">¹ 缩进只按真实 ID 关系计算；未找到父节点时保留 parent ID，不补造连接。</p><h3>该 operation 的自定义事件</h3>'+wrapTable(['记录时刻（北京）','事件 / 回合','结果','关键计时或媒体'],events.map(x=>{const m=x.measurements;return[esc(cst(x.timestamp)),esc(x.name+(x.turn_kind?' / '+x.turn_kind+' #'+x.turn_index:'')),esc(x.outcome||('heard='+x.heard)),x.name==='voice.media'?'RTT '+ms(m.rtt_ms)+' · buffer '+ms(m.jitter_buffer_ms):x.name==='voice.avatar'?'total '+ms(m.total_ms):x.name==='voice.setup'?'首帧 '+ms(m.first_video_frame_ms)+' · 起音 '+ms(m.first_audible_ms):'click→audio '+ms(m.click_to_audible_ms)+' · read→created '+ms(m.read_to_created_ms)];}))+'<details><summary>完整事件字段 JSON（含 itemId）</summary><div><pre>'+esc(JSON.stringify(events,null,2))+'</pre></div></details>';
}
el('operation-select').addEventListener('change',renderOperation);el('trace-lifecycle').addEventListener('change',renderOperation);renderOperation();
document.addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='已复制';setTimeout(()=>{b.textContent='复制 operation ID';},2000);}catch{const n=document.createElement('input');n.value=b.dataset.copy;document.body.append(n);n.select();const ok=document.execCommand('copy');n.remove();b.textContent=ok?'已复制':'请选中旁边 ID 复制';}});

function lineChart(series,{unit='',label='',dateTicks=false,gap=Infinity}={}){
 const all=series.flatMap(s=>s.points).filter(p=>valid(p.y)&&Number.isFinite(p.x));
 if(!all.length)return '<div class="empty">这个指标在所选范围没有有效记录。</div>';
 const W=Math.max(640,Math.min(1080,Math.floor(document.querySelector('.main').clientWidth-80))),H=330,L=64,R=24,T=30,B=55,iw=W-L-R,ih=H-T-B;
 let xmin=Math.min(...all.map(p=>p.x)),xmax=Math.max(...all.map(p=>p.x));if(xmax===xmin)xmax=xmin+1000;
 const ymax=Math.max(1,Math.max(...all.map(p=>p.y))*1.1),sx=x=>L+(x-xmin)/(xmax-xmin)*iw,sy=y=>T+ih-y/ymax*ih;
 let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(label)+'"><title>'+esc(label)+'</title><text class="y" x="'+L+'" y="15">'+esc(unit)+'</text>';
 for(let i=0;i<=4;i++){const y=ymax*i/4,py=sy(y);svg+='<line class="grid" x1="'+L+'" y1="'+py+'" x2="'+(W-R)+'" y2="'+py+'"/><text class="y" x="'+(L-10)+'" y="'+(py+4)+'" text-anchor="end">'+num(y,ymax<=5?2:ymax<=30?1:0)+'</text>';}
 for(let i=0;i<=5;i++){const x=xmin+(xmax-xmin)*i/5;svg+='<text class="x" x="'+sx(x)+'" y="'+(H-26)+'" text-anchor="'+(i===0?'start':i===5?'end':'middle')+'">'+esc(dateTicks?cst(x).slice(0,-3):clock(x))+'</text>';}
 series.forEach((s,si)=>{
  const color=s.color||colors[si],ps=s.points;let path='',prev=null;
  ps.forEach(p=>{if(!valid(p.y)||!Number.isFinite(p.x)){prev=null;return;}const jump=!prev||p.x-prev.x>gap;path+=(jump?'M':'L')+sx(p.x).toFixed(2)+','+sy(p.y).toFixed(2)+' ';prev=p;});
  svg+='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.1"/>';
  if(ps.length<=100)ps.filter(p=>valid(p.y)).forEach(p=>{svg+='<circle cx="'+sx(p.x)+'" cy="'+sy(p.y)+'" r="3" fill="'+color+'" tabindex="0"><title>'+esc(s.name+' · '+cst(p.x)+' · '+num(p.y,3)+' '+unit)+'</title></circle>';});
 });
 return svg+'</svg><div class="legend">'+series.map((s,i)=>'<span><i class="dot" style="background:'+(s.color||colors[i])+'"></i>'+esc(s.name)+'</span>').join('')+'</div><p class="footnote">横轴为北京时间；悬停数据点查看原值。缺失值保留为空，不按 0 填补。</p>';
}
el('media-select').innerHTML=D.media_stats.map(x=>'<option value="'+x.id+'">'+short(x.id)+' · '+x.n+' 个窗口 · '+x.resolution.join(',')+'</option>').join('');
el('media-select').value=D.media_stats[D.media_stats.length-1].id;
function renderMedia(){
 const id=el('media-select').value,kind=el('media-metric').value,xs=D.voice.filter(x=>x.name==='voice.media'&&x.interview_id===id),s=D.media_stats.find(x=>x.id===id);
 const sets={delay:{keys:['rtt_ms','audio_jitter_ms','jitter_buffer_ms'],names:['候选对 RTT（窗末）','音频 jitter（窗末）','jitter buffer（窗平均）'],unit:'ms'},loss:{keys:['audio_loss_pct','video_loss_pct','audio_concealed_pct'],names:['音频丢包','视频丢包','音频补偿'],unit:'%'},video:{keys:['video_fps'],names:['接收帧率'],unit:'fps'},bitrate:{keys:['video_kbps','audio_kbps'],names:['视频接收','音频接收'],unit:'kbps'}};
 const cfg=sets[kind];
 el('media-chart').innerHTML=lineChart(cfg.keys.map((key,i)=>({name:cfg.names[i],points:xs.map(x=>({x:ts(x.timestamp),y:x.measurements[key]}))})),{unit:cfg.unit,label:'所选面试的 '+cfg.names.join('、'),gap:60000});
 el('media-summary').innerHTML='<div class="metric-grid"><div class="metric-small"><b>'+s.n+'</b><span>媒体窗口 / '+num(s.window_seconds)+' 秒覆盖</span></div><div class="metric-small"><b>'+ms(s.metrics.rtt_ms.p50)+'</b><span>RTT 中位数</span></div><div class="metric-small"><b>'+ms(s.metrics.jitter_buffer_ms.p50)+'</b><span>buffer 中位数</span></div><div class="metric-small"><b>'+ms(s.metrics.jitter_buffer_ms.max)+'</b><span>最慢窗口平均 buffer</span></div><div class="metric-small"><b>'+s.freeze_count+'</b><span>累计 freeze 计数</span></div><div class="metric-small"><b>'+num(s.metrics.video_fps.p50,1)+'</b><span>fps 中位数</span></div></div><p class="subtle">interview '+code(id)+' · 起止为窗口事件的记录时间；每个窗口实际 window_s 字段为 '+num(Math.min(...xs.map(x=>x.measurements.window_s)))+'–'+num(Math.max(...xs.map(x=>x.measurements.window_s)))+' 秒。</p>';
 const hdr=['面试','窗口 / 覆盖','RTT P50 / 最大','buffer P50 / 最大','音频 / 视频丢包最大','音频 / 视频 kbps P50','冻结计数'];
 el('media-table').innerHTML=wrapTable(hdr,D.media_stats.map(x=>[code(short(x.id)),x.n+' / '+x.window_seconds+'s',ms(x.metrics.rtt_ms.p50)+' / '+ms(x.metrics.rtt_ms.max),ms(x.metrics.jitter_buffer_ms.p50)+' / '+ms(x.metrics.jitter_buffer_ms.max),num(x.metrics.audio_loss_pct.max,2)+'% / '+num(x.metrics.video_loss_pct.max,2)+'%',num(x.metrics.audio_kbps.p50,1)+' / '+num(x.metrics.video_kbps.p50,1),String(x.freeze_count)]))+'<details><summary>展开所选面试的 '+xs.length+' 个原始媒体窗口</summary><div>'+wrapTable(['记录时刻','窗口 s','RTT ms','jitter ms','buffer ms','音频丢包 %','视频丢包 %','音频 kbps','视频 kbps','fps','freeze 次 / ms'],xs.map(x=>{const m=x.measurements;return[esc(cst(x.timestamp)),num(m.window_s),num(m.rtt_ms),num(m.audio_jitter_ms),num(m.jitter_buffer_ms),num(m.audio_loss_pct,2),num(m.video_loss_pct,2),num(m.audio_kbps,1),num(m.video_kbps,1),num(m.video_fps,1),num(m.video_freezes)+' / '+num(m.video_freeze_ms)];}))+'</div></details>';
}
el('media-select').addEventListener('change',renderMedia);el('media-metric').addEventListener('change',renderMedia);renderMedia();

const answerPairs=D.pairs.filter(x=>x.route.endsWith('/answer')).sort((a,b)=>a.browser_ms-b.browser_ms),pair=answerPairs[Math.floor(answerPairs.length/2)];
el('answer-pair-bars').innerHTML='<p><b>实际浏览器 Fetch：'+ms(pair.browser_ms)+'</b> · '+esc(cst(pair.timestamp))+'</p><div class="stack"><span style="width:'+pair.server_ms/pair.browser_ms*100+'%;background:#087f8c" title="后端处理 '+pair.server_ms+' ms">'+pair.server_ms+'</span><span style="width:'+pair.outside_server_ms/pair.browser_ms*100+'%;background:#3c68c7" title="后端计时之外 '+pair.outside_server_ms+' ms">'+pair.outside_server_ms+' ms</span></div><div class="legend"><span><i class="dot"></i>server request '+ms(pair.server_ms)+'</span><span><i class="dot" style="background:#3c68c7"></i>Fetch 内其余时间 '+ms(pair.outside_server_ms)+'</span></div><details><summary>查看全部 7 对回答接口记录</summary><div>'+wrapTable(['北京开始时间','浏览器','后端','相减结果','operation'],answerPairs.map(x=>[esc(cst(x.timestamp)),ms(x.browser_ms),ms(x.server_ms),ms(x.outside_server_ms),code(short(x.operation_Id))]))+'<p class="subtle">本图将相减部分合并显示，不代表它只发生在后端处理之后；当前无法进一步分离前向网络与返回网络。</p></div></details>';
if(D.api.some(x=>x.category==='其他'))el('api-category').insertAdjacentHTML('beforeend','<option>其他</option>');
function renderAPI(){
 const term=el('api-search').value.trim().toLowerCase(),category=el('api-category').value,rows=D.api.filter(x=>(!category||x.category===category)&&(!term||x.route.toLowerCase().includes(term)));
 el('api-count').textContent='显示 '+rows.length+' / '+D.api.length+' 条路由；对应 '+rows.reduce((n,x)=>n+x.server.n,0).toLocaleString()+' 个后端请求。浏览器列只统计成功匹配的同一批请求。';
 el('api-table').innerHTML=table(['路由 / 业务','Server N','Server P50 / P95','HTTP 结果 × 次数','匹配 N','匹配 Server P50','Browser P50','后端之外 P50'],rows.map(x=>[code(x.route)+'<br><span class="tag">'+esc(x.category)+'</span>',num(x.server.n),ms(x.server.p50)+' / '+ms(x.server.p95),Object.entries(x.codes).map(([k,v])=>esc(k)+' × '+v).join('<br>'),num(x.browser.n),ms(x.paired_server.p50),ms(x.browser.p50),ms(x.outside.p50)]));
 if(!rows.length)el('api-table').innerHTML='<div class="empty">没有匹配的路由，请修改筛选条件。</div>';
}
el('api-search').addEventListener('input',renderAPI);el('api-category').addEventListener('change',renderAPI);renderAPI();
el('page-timing-table').innerHTML=wrapTable(['开始时间（北京）','总长','network','send','receive','processing','客户端'],D.browser_timings.map(x=>[esc(cst(x.timestamp)),ms(x.totalDuration),ms(x.networkDuration),ms(x.sendDuration),ms(x.receiveDuration),ms(x.processingDuration),esc(x.client_Browser)+'<br>'+esc(x.client_OS)]));

function scoringCase(s,index){
 const total=s.request.duration;
 const taskRows=s.tasks.map(t=>{
  const h=t.http[0],pre=h?h.offset_ms-t.offset_ms:0;
  let bars='<span class="bar" style="left:'+t.offset_ms/total*100+'%;width:'+t.duration/total*100+'%;background:#dce7eb" title="业务 span '+ms(t.duration)+'"></span>';
  if(h){bars+='<span class="bar" style="left:'+t.offset_ms/total*100+'%;width:'+pre/total*100+'%;background:#b57a20" title="HTTP 前 '+ms(pre)+'"></span>';bars+=t.http.map(x=>'<span class="bar" style="left:'+x.offset_ms/total*100+'%;width:'+x.duration/total*100+'%;background:#087f8c" title="HTTP 在 +'+ms(x.offset_ms)+' 开始，持续 '+ms(x.duration)+'"></span>').join('');}
  return '<div class="timeline-row"><span class="name">'+esc(t.label)+(pre>1000?' · 外呼前 '+ms(pre):'')+'</span><div class="track">'+bars+'</div><span class="val">'+ms(t.duration)+'</span></div>';
 }).join('');
 const extra=s.extra_http.length?'<h4 style="margin-top:20px">第二批模型 HTTP · 历史代码指向 SOP coverage 附加审计</h4>'+s.extra_http.map((h,i)=>'<div class="timeline-row"><span class="name">附加外呼 '+(i+1)+' · +'+ms(h.offset_ms)+' 发起</span><div class="track"><span class="bar" style="left:'+h.offset_ms/total*100+'%;width:'+h.duration/total*100+'%;background:#7957b0" title="HTTP 在 +'+ms(h.offset_ms)+' 开始，持续 '+ms(h.duration)+'"></span></div><span class="val">'+ms(h.duration)+'</span></div>').join(''):'';
 return '<article class="casebox"><div class="casehead"><div><span class="tag measured">真实 operation '+(index+1)+'</span><h3>'+ms(total)+' · '+(index===0?'普通 JSON 报告':'NDJSON 进度报告')+'</h3></div><div class="subtle">'+esc(cst(s.request.timestamp))+'（北京）<br>'+code(s.request.operation_Id)+'</div></div><p>'+code(s.request.name)+' · HTTP '+esc(s.request.resultCode)+' · 9 个评分任务</p><div class="smallstat"><span>评分全部结束 <b>+'+ms(s.last_scoring_ms)+'</b></span><span>附加模型 HTTP <b>'+s.extra_http.length+' 个</b></span>'+(s.extra_http.length?'<span>附加阶段跨度 <b>'+ms(s.extra_span_ms)+'</b></span>':'')+'</div><div class="legend"><span><i class="dot" style="background:#b57a20"></i>评分 span 内，HTTP 尚未开始</span><span><i class="dot"></i>评分 HTTP</span><span><i class="dot" style="background:#7957b0"></i>附加 HTTP</span></div><p class="footnote">所有条形共用请求起点 0 → '+ms(total)+' 的坐标；右侧是该 span 自身时长。任务编号按遥测开始顺序排列，不是业务题号。</p>'+taskRows+extra+'<details><summary>精确偏移、父子 ID 与 HTTP 前等待</summary><div>'+wrapTable(['任务 / span ID','任务起点','业务时长','HTTP 起点','HTTP 时长','HTTP 前等待'],s.tasks.map(t=>[esc(t.label)+'<br>'+code(t.id),ms(t.offset_ms),ms(t.duration),t.http.map(h=>ms(h.offset_ms)).join('<br>'),t.http.map(h=>ms(h.duration)).join('<br>'),ms(t.pre_http_ms)]))+(s.extra_http.length?wrapTable(['附加 HTTP span ID','parent ID','起点','时长'],s.extra_http.map(h=>[code(h.id),code(h.operation_ParentId),ms(h.offset_ms),ms(h.duration)])):'')+'</div></details></article>';
}
el('scoring-cases').innerHTML=D.score.map(scoringCase).join('');

function renderDeployment(){
 const b=D.deployment.backend,f=D.deployment.frontend,p=D.deployment.postgres,env=D.deployment.environment;
 const rows=[
 ['后端容器',code(b.name),b.containers[0].resources.cpu+' vCPU / '+b.containers[0].resources.memory,'min='+b.scale.minReplicas+'，max='+b.scale.maxReplicas+'；Single revision','内部 ingress '+b.ingress.targetPort+'；sticky affinity','backend-runtime.json'],
 ['前端容器',code(f.name),f.containers[0].resources.cpu+' vCPU / '+f.containers[0].resources.memory,'min='+f.scale.minReplicas+'，max='+f.scale.maxReplicas+'；Single revision','公网 ingress '+f.ingress.targetPort+'；Nginx 转发 HTTPS / WSS','frontend-runtime.json'],
 ['数据库',code(p.name),esc(p.sku.name)+' / PostgreSQL '+esc(p.version),p.storage.storageSizeGB+' GiB / '+p.storage.iops+' IOPS；HA '+esc(p.highAvailability.mode),'私网，Entra-only；自动增长 '+esc(p.storage.autoGrow),'postgres-runtime.json'],
 ['容器环境',code(env.name),esc(env.workloadProfiles[0].workloadProfileType),'Sweden Central；zoneRedundant='+env.zoneRedundant,'VNet 接入；不保证客户端或 TURN relay 同区','environment-runtime.json'],
 ['Foundry',code(D.deployment.foundry[0].name),'AIServices / S0','Sweden Central','控制面位置已核对；各历史请求实际模型未全部导出','foundry-resource.json'],
 ['发布镜像','后端 0000176 / 前端 0000168',code('dc17e27'),'快照时两端 Ready','后续 0000177 的独立状态见下方提示','backend-runtime.json']
 ];
 el('deployment-table').innerHTML=wrapTable(['组件','资源 / 修订','规格','运行配置','对性能的含义','证据'],rows.map(r=>r.slice(0,5).concat('<a href="evidence/'+r[5]+'">JSON ↗</a>'+(r[0]==='发布镜像'?' · <a href="evidence/frontend-runtime.json">前端 JSON ↗</a>':''))));
 const revs=[...D.revisions.backend.slice(-8).map(x=>({...x,side:'后端'})),...D.revisions.frontend.slice(-6).map(x=>({...x,side:'前端'}))].sort((a,b)=>ts(b.createdTime)-ts(a.createdTime));
 el('revision-table').innerHTML='<h3>快照中的近期 revisions</h3>'+wrapTable(['组件 / revision','创建时间（北京）','镜像 commit','快照 Active / Replicas','状态'],revs.map(r=>[esc(r.side)+' '+code(r.name.split('--')[1]),esc(cst(r.createdTime)),code(r.images[0].split(':').pop().slice(0,12)),String(r.active)+' / '+r.replicas,esc(r.runningState)+' / '+esc(r.healthState)]))+'<p class="footnote">创建时间不等于流量切换时间；这是获取时的修订清单状态。完整历史保存在 backend-revisions.json / frontend-revisions.json。</p>';
}
function renderInfra(){
 const kind=el('infra-metric').value,cfg={cpu:['backend_metrics','UsageNanoCores',1e9,'核'],memory:['backend_metrics','WorkingSetBytes',1048576,'MiB'],pgcpu:['pg_metrics','cpu_percent',1,'%'],pgconn:['pg_metrics','active_connections',1,'连接']}[kind],metric=D[cfg[0]].value.find(x=>x.name.value===cfg[1]),points=metric.timeseries[0].data;
 el('infra-chart').innerHTML=lineChart(['average','maximum'].map((key,i)=>({name:['15 分钟桶平均','15 分钟桶最大'][i],points:points.map(p=>({x:ts(p.timeStamp),y:typeof p[key]==='number'?p[key]/cfg[2]:null}))})),{unit:cfg[3],label:metric.name.localizedValue+' 历史趋势',dateTicks:true,gap:20*60000})+'<p class="footnote">使用平台实际返回的桶；未有数据的时段留空。平均线是各桶 average，最大线是各桶 maximum，二者都不是连续瞬时测量。</p>';
}
renderDeployment();el('infra-metric').addEventListener('change',renderInfra);renderInfra();

el('negative-table').innerHTML=wrapTable(['事件记录时刻（北京）','Operation','事件 / 字段','原值','处理'],D.summary.negative_samples.map(x=>[esc(cst(x.timestamp)),code(x.operation_Id),esc(x.name)+'<br>'+code(x.metric),String(x.value)+' ms','仅该字段排除统计；原记录保留']));
const glossary=[
 ['Operation ID','一条关联上下文，浏览器中常对应页面生命周期','可同时包含多次 REST、语音事件和恢复尝试；不必等同单个请求或单个 interview'],
 ['Span / parent ID','一次调用的区间及直接调用者','父 span 包含子调用，不把父子 duration 累加成总耗时'],
 ['voice.setup','connect_start 到各里程碑的累计时间','WS open 不是 Azure ready；首次起音可能包含用户进入读题流程的等待'],
 ['voice.avatar','PeerConnection 创建、候选收集、SDP、ICE、首帧','STUN/TURN 和 ICE/DTLS 存在并行或重叠，不逐项累加'],
 ['voice.turn / turn_index','一段语音记录及记录序号','序号不是题号；opening / aside 不能混入正式 answer 分布'],
 ['click_to_audible_ms','点击完成到下一句起音检测','WebRTC 在接收端 audioLevel 检测，通常早于扬声器缓冲；不是人耳实录'],
 ['stt_ms','前端收到 VAD stop 到最终转写','包含服务处理与消息传输；不是纯 Azure ASR 计算时长'],
 ['read_to_created_ms','前端发读题控制到收到 response.created','包含上行与服务受理，不是纯网络 RTT'],
 ['response.done / response_ms','服务 response 生命周期','服务已完成输出不表示浏览器已完成播放，可能在首次可听检测之前'],
 ['voice.session / WS duration','整段长连接生命周期','不能当普通 API 延迟；1006 为异常关闭，不直接指明故障来源'],
 ['Fetch − server request','精确关联的一对调用时长差','含网络、前端代理、连接、客户端调度与读取，不能直接称为纯 RTT'],
 ['WebRTC RTT','候选对往返时延的窗口末读数','媒体路径指标，不等同 Browser 到 FastAPI 的 RTT'],
 ['jitter_buffer_ms','窗口内 jitter buffer 排队时间平均值','不是窗口最大，也不等于浏览器所有音频设备缓冲之和'],
 ['loss / bitrate / fps','来自窗口计数器增量','同一会话相邻窗口不独立；静音码率低不证明丢帧或缺带宽'],
 ['scoring.question','单题评分业务 span','含应用排队与真正 HTTP；从任务进入到 HTTP 开始的等待并非模型 HTTP 计算'],
 ['browserTimings.processingDuration','浏览器 Navigation Timing 的处理阶段','含资源与页面处理，不能当纯 CPU 或 LCP'],
 ['P50 / P95','有效原始样本的中位数 / 最近秩 95 分位','小 N 的 P95 常等于最大值；不能推为整体 SLA'],
 ['first_seen / emit timestamp','首次记录时间 / 自定义事件发出时刻','不自动等同用户动作起点；语音瀑布用事件内 t_* 重建']
];
el('glossary-table').innerHTML=wrapTable(['名词 / 指标','本报告如何解释','不能据此推断'],glossary.map(r=>r.map(esc)));
el('queries').innerHTML='<p>这些是实际执行并保存的 KQL；请求通过 API 的 timespan 参数固定到 '+esc(D.scope.start_utc)+' / '+esc(D.scope.end_utc)+'。在 Portal 复查时需要设置同一时间范围。派生配对与统计方法见 <a href="evidence/derivation.json">derivation.json</a>。</p>'+(D.queries||[]).map(q=>'<h4>'+esc(q.title)+'</h4><pre>'+esc(q.text)+'</pre><a href="evidence/'+esc(q.file)+'">下载 '+esc(q.file)+'</a>').join('');
const sourceLabels={
 'frontend/src/hooks/useInterviewVoice.ts':'语音状态机、WS 重连与错误分支',
 'frontend/src/hooks/useAvatarStream.ts':'Avatar、ICE gate 与媒体路径',
 'frontend/src/telemetry/voiceTimeline.ts':'语音各阶段计时定义',
 'frontend/src/telemetry/appInsights.ts':'浏览器 trace、WS 生命周期',
 'frontend/src/telemetry/mediaQuality.ts':'WebRTC 窗口指标口径',
 'frontend/nginx.conf':'前端代理、缓冲和超时',
 'backend/app/api/voice_live_ws.py':'后端 WS 鉴权与入口',
 'backend/app/services/voice_live_proxy.py':'Voice Live 代理、麦克风与读题',
 'backend/app/interview/state_machine.py':'业务状态机与报告阶段',
 'backend/app/services/agents/adapters/foundry_llm.py':'同步 Responses SDK 与 to_thread',
 'backend/app/db.py':'数据库连接池',
 'backend/app/config.py':'应用默认配置与匿名会话 TTL',
 '.github/workflows/deploy-app.yml':'镜像发布与健康检查'
};
el('sources').innerHTML=D.sources.map(x=>'<li><a target="_blank" rel="noreferrer" href="'+esc(x.url)+'">'+esc(sourceLabels[x.path]||x.path)+'</a><br><span class="subtle">'+esc(x.path)+'</span></li>').join('')+'<li><a target="_blank" rel="noreferrer" href="https://github.com/huqianghui/AI-interview-vibe-coding/blob/5738027e70c532e63b7e81c57eeef745478f3f10/backend/app/interview/state_machine.py#L563">历史报告：评分后的 coverage 阶段</a><br><span class="subtle">5738027 · state_machine.py:563</span></li><li><a target="_blank" rel="noreferrer" href="https://github.com/huqianghui/AI-interview-vibe-coding/blob/5738027e70c532e63b7e81c57eeef745478f3f10/backend/app/services/sop_coverage.py#L152">历史 coverage 调用与无独立业务 span 的路径</a><br><span class="subtle">5738027 · sop_coverage.py:152</span></li>';
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){document.querySelectorAll('.sidebar nav a').forEach(a=>a.classList.toggle('current',a.getAttribute('href')==='#'+entry.target.id));}});},{rootMargin:'-5% 0px -75% 0px',threshold:0});document.querySelectorAll('main section').forEach(s=>observer.observe(s));}
let chartResizeTimer;window.addEventListener('resize',()=>{clearTimeout(chartResizeTimer);chartResizeTimer=setTimeout(()=>{renderMedia();renderInfra();},120);});
document.documentElement.dataset.reportReady='true';
