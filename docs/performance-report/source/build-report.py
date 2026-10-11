from pathlib import Path
from datetime import datetime
import json
import html
import sys

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'source'
D = json.loads((ROOT / 'report-data.json').read_text())
F = json.loads((ROOT / 'flow-data.json').read_text())

def embed(obj):
    return json.dumps(obj,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')

def n(x):
    return f'{x:,.1f}'.rstrip('0').rstrip('.') if x % 1 else f'{int(x):,}'

def milliseconds(x):
    return n(x)+' ms'

def tr(*cells):
    return '<tr>'+''.join('<td>'+str(c)+'</td>' for c in cells)+'</tr>'

fragment=(SRC/'flow-fragment.html').read_text().replace('__FLOW_DATA__',embed(F))
assert '__FLOW_DATA__' not in fragment
addition=(SRC/'flow-report-addition.html').read_text()
turns=[
    ('speaking_ms','讲话：VAD start → stop','用户讲话时长，音频上行与识别可交叠，不属于点击后的系统等待。'),
    ('stt_ms','VAD stop → 最终转写','转写收尾与回传的综合等待，不等于 Azure ASR 的纯计算时间。'),
    ('transcript_to_click_ms','最终转写 → 点击完成','包含用户确认和界面操作；本批样本转写均早于点击。'),
    ('commit_wait_ms','点击完成 → 发起 /answer','本地提交前等待；本批转写已到，等待很短。'),
    ('answer_http_ms','/answer 发起 → 返回','HTTP 请求整体，包含后端处理与请求往返。'),
    ('answer_to_read_ms','/answer 返回 → WS 读题请求','前端推进下一题并安排发出指令。'),
    ('read_to_created_ms','WS 读题请求 → response.created','经过应用代理和 Voice Live 接受处理，不是纯 WS ping RTT。'),
    ('created_to_audible_ms','response.created → 起音检测','综合音频生成、媒体传输、缓冲与浏览器检测。'),
    ('click_to_audible_ms','整体：点击完成 → 起音检测','从完整回合独立统计；不能用上面各阶段中位数之和替代。'),
    ('stop_to_audible_ms','整体：VAD stop → 起音检测','额外包含最终转写和点击前确认。'),
]
rows=[]
for key,label,meaning in turns:
    m=F['medians']['turn'][key]
    rows.append(tr(label,milliseconds(m['p50']),f'{n(m["min"])}–{n(m["max"])} ms / N{m["n"]}',meaning))
addition=addition.replace('__TURN_MEDIAN_ROWS__',''.join(rows))
addition=addition.replace('__SETUP_MEDIAN_ROWS__',''.join(tr(m['label'],milliseconds(m['p50']),f'{n(m["min"])}–{n(m["max"])} ms') for m in F['medians']['setup']))
avatar=[
    ('avatar','ice_gather_ms','候选收集门控：offer created → sent','包含候选发现及发送门控，不与 STUN / TURN 里程碑相加。'),
    ('avatar_candidates','stun_srflx_ms','offer 创建后 → 首个 srflx','STUN 候选在收集期间出现；N4。'),
    ('avatar_candidates','turn_relay_ms','offer 创建后 → 首个 relay','TURN 候选在同一收集期间出现；N4。'),
    ('avatar','sdp_answer_ms','offer sent → answer received','SDP 经 WS 信令路径交换；N4。'),
    ('avatar','ice_connect_ms','answer applied → ICE connected','与 PC connected 计时共享起点；N4。'),
    ('avatar','pc_connect_ms','answer applied → PC connected','覆盖部分 ICE 连通区间；N4。'),
    ('avatar','first_frame_ms','ICE connected → 首帧','与 PC 连接就绪阶段交叠；N4。'),
    ('avatar','total_ms','整体：offer start → 首帧','独立总耗时，范围 2,193–3,084 ms；N4。'),
]
addition=addition.replace('__AVATAR_MEDIAN_ROWS__',''.join(tr(label,milliseconds(F['medians'][group][key]['p50']),meaning) for group,key,label,meaning in avatar))
addition=addition.replace('__FLOW_FRAGMENT__',fragment)

questions=(SRC/'protocol-questions.html').read_text()
pairrows=[]
for p in F['pairs']:
    ts=datetime.fromisoformat(p['timestamp'].replace('Z','+00:00'))
    bj=ts.astimezone(__import__('datetime').timezone(__import__('datetime').timedelta(hours=8))).strftime('%H:%M:%S')
    pairrows.append(tr(bj+' / <code>'+p['operation_Id'][:8]+'</code>',milliseconds(p['browser_ms']),milliseconds(p['server_ms']),milliseconds(p['outside_server_ms'])))
questions=questions.replace('__PAIR_ROWS__',''.join(pairrows))

rttrows=[]
for c in F['media_comparison']:
    name={'2e59fd58-3f84-463e-b687-0a0fb6e31a3d':'10/10 14:08','7981e284-a5eb-408d-a35a-c90a0d9b3162':'10/10 14:39','08c066f9-a113-4b33-b36a-996fdde0c132':'10/10 16:12'}[c['interview_id']]
    r=c['rtt'];o=c['outside']
    rttrows.append(tr(name+'<br><code>'+c['operation_Id'][:8]+'</code>',milliseconds(r['p50']),f'{n(r["min"])}–{n(r["max"])} ms / N{r["n"]}',milliseconds(o['p50'])+' / N'+str(o['n']) if o else '无完整回答配对'))
rtt='''<div id="rtt-comparison"><h3>同一场面试：WebRTC RTT 与 HTTP 外部等待对照</h3>
<div class="tablewrap"><table><thead><tr><th>场次 · 北京时间</th><th>WebRTC RTT P50</th><th>RTT 范围 / 媒体窗口数</th><th>HTTP Fetch − Server P50</th></tr></thead><tbody>'''+''.join(rttrows)+'''</tbody></table></div>
<p><b>两列是不同路径、不同计时口径，也不是同一时刻的一一对应测量。</b> WebRTC <code>rtt_ms</code> 来自浏览器选中的媒体候选对，表示这条候选路径的往返时间；当前 4 次握手都为本地 <code>relay</code>、远端 <code>srflx</code>、UDP。它包括选定的中继路径，不能简单叫“浏览器直连媒体服务器的一跳”。中继的实际地域没有被当前证据确认。</p>
<p>HTTP 差额则来自浏览器 ↔ Nginx ↔ 应用后端的 <code>/answer</code> 请求，包含双向传输与其他未被后端计时覆盖的开销。WS 语音控制再延伸到 Azure Voice Live；最接近其一次业务往返的现有指标是 <code>read_to_created_ms</code>，P50 <b>259 ms</b>，范围 <b>257–274 ms</b>，N7，但它还包含服务端接受处理，不是 WS 网络 RTT。</p>
<p class="footnote">11:52 场次只有握手时的一次 RTT 251 ms，没有连续媒体窗口，因此未放进同口径的窗口统计。不能把 66 个窗口很多的长会话与 3–4 个窗口的小样本等权混算，也不能用这些数据给纯 WS 与 WebRTC 的整体体验排名。</p></div>'''

theme='''
.flow-report-block{margin:22px 0 34px}.flow-report-block h3{margin-top:25px}
#interview-flow-v2{--background:transparent;--foreground:var(--ink);--muted-foreground:#526775;--muted:#eaf0f3;--border:var(--line);--primary:var(--nav);--primary-foreground:#fff;--card-foreground:var(--ink);--popover:#fff;--popover-foreground:var(--ink);--accent:#eaf3f4;--accent-foreground:var(--ink);--viz-series-1:#087f8c;--viz-series-2:#3c68c7;--viz-series-3:#7957b0;--viz-series-4:#956611;--viz-series-5:#586978;--viz-series-6:#b44842;--font-size-base:14px;font-size:14px;line-height:1.65}
#interview-flow-v2 .viz-controls{display:flex;gap:12px;align-items:end;flex-wrap:wrap}
#interview-flow-v2 .form-label{display:grid;gap:5px;flex:1 1 240px;min-width:0;color:var(--foreground)}
#interview-flow-v2 .form-select{width:100%;max-width:100%;min-width:0;font-size:14px}
#interview-flow-v2 .btn{font-weight:500}
#interview-flow-v2 .btn-primary{background:var(--primary);color:var(--primary-foreground)}
#interview-flow-v2 .form-range{accent-color:var(--primary);margin:0;min-height:24px}
#interview-flow-v2 .text-small{font-size:12px}
#interview-flow-v2 .text-muted{color:var(--muted-foreground)}
#interview-flow-v2 .tabular-nums{font-variant-numeric:tabular-nums}
#interview-flow-v2 h3{font-weight:500;margin:0}
@media(pointer:coarse){#interview-flow-v2 button,#interview-flow-v2 select,#interview-flow-v2 input{min-height:44px}}
@media print{#interview-flow-v2 .flow-playback,#interview-flow-v2 .flow-selectors{display:none}}
'''

t=(SRC/'report-template.original.html').read_text()
t=t.replace('打开语音 WS → 数字人首帧检测','发起语音连接 → 数字人首帧检测').replace('17 分钟长连接之后，恢复卡在应用鉴权','一条长会话的恢复，卡在应用鉴权')
t=t.replace('<style>','<style>\n'+theme+'\n@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}} .card,.grid2>*,.grid3>*,.stage-info>*,.main,section{min-width:0}.tablewrap td{overflow-wrap:anywhere}.tablewrap code{font-size:11px}.timeline-row .val{white-space:nowrap}.source-list{overflow-wrap:anywhere}.casebox .timeline-row{grid-template-columns:250px minmax(100px,1fr) 85px}@media(max-width:800px){.casebox .timeline-row{grid-template-columns:160px minmax(80px,1fr) 70px}.casebox{overflow-x:auto}.cards{min-width:0}}\n',1)
t=t.replace('同一回答请求：后端计时之外','HTTP /answer：Fetch − 后端')
t=t.replace('7 对精确关联的请求，中位数<br>后端处理 56 ms；浏览器 Fetch 323 ms','先逐对相减，再取 7 对差额的中位数<br>Fetch P50 323 ms；后端 P50 56 ms<br><a href="#protocol-questions">为什么不是 267 ms？计时说明 →</a>')
t=t.replace('<a href="#stages">03 · 每一阶段花多久</a>','<a href="#stages">03 · 面试流程与动态回放</a>')
t=t.replace('<h2><span class="num">03 / ONE EVENT, ONE CLOCK</span>把一次真实事件拆成可理解的阶段</h2><p class="lead">下面不是把多条记录的 P95 拼起来，而是选定一条实际记录，沿它自己的单调时钟画出关键路径。切换“连接建立 / Avatar 握手 / 回答回合”可以看到不同层次。</p>','<h2><span class="num">03 / THE INTERVIEW, STEP BY STEP</span>一次面试怎么走，每一步花多久</h2>'+addition+'<h3>继续查看：单条事件的静态分解与完整分布</h3><p>以下原始阶段视图继续保留，可以按记录复核每一个观测点。</p>')
marker='<div class="card" style="margin-top:18px"><h3>完整 API 索引</h3>'
assert marker in t
t=t.replace(marker,questions+marker,1)
marker='<section id="media">'
i=t.index(marker);j=t.index('</p>',i)+4
t=t[:j]+rtt+t[j:]
t=t.replace('<a href="evidence/manifest.json">证据清单与 SHA-256</a>','<a href="evidence/manifest.json">证据清单与 SHA-256</a> · <a href="evidence/flow-derivation.json">动态流程统计口径</a> · <a href="flow.html">单独打开流程回放</a>')
t=t.replace('__REPORT_DATA__',embed(D)).replace('__REPORT_SCRIPT__',(SRC/'report-script.js').read_text())
for token in ['__REPORT_','__FLOW_','__TURN_MEDIAN','__SETUP_MEDIAN','__AVATAR_MEDIAN','__PAIR_ROWS']:
    assert token not in t,token
(ROOT/'index.html').write_text(t)

standalone='<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Interview · 面试流程回放</title><style>:root{--ink:#182b3d;--nav:#132b3a;--line:#dae3e8}*{box-sizing:border-box}body{margin:0;padding:24px;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#182b3d;background:#f4f7f8}main{max-width:1050px;margin:auto}a{color:#087f8c}button,select,input{font:inherit}button,select{border:1px solid #c8d5df;border-radius:7px;padding:8px 12px;background:#fff;color:#182b3d}button{cursor:pointer}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #ad801c;outline-offset:3px}h1{font-size:26px}p{margin:12px 0}.intro{color:#526775}@media(max-width:480px){body{padding:14px}}'+theme+'</style></head><body><main><p><a href="index.html#stages">← 完整性能报告</a> · <a href="index.html#protocol-questions">Fetch / RTT / 协议说明</a></p><p class="intro">整场图展示流程关系；其他视图使用单条实际记录的时间轴。播放速度经过缩放，实际耗时请读坐标。阶段中位数不能相加成整场面试总时长。</p>'+fragment+'<p class="intro">离线数据快照：Application Insights / Workbook · 2026-10-11 分析。初始图按逻辑步骤排列；真实记录保持各自计时起点。<a href="evidence/flow-derivation.json">查看派生方法</a></p></main></body></html>'
(ROOT/'flow.html').write_text(standalone)

if len(sys.argv)>1:
    inline=Path(sys.argv[1]);inline.parent.mkdir(parents=True,exist_ok=True);inline.write_text(fragment)
    assert len(fragment.encode())<1_000_000
print('Built index.html',len(t.encode()),'bytes; flow.html',len(standalone.encode()),'bytes; fragment',len(fragment.encode()),'bytes.')
