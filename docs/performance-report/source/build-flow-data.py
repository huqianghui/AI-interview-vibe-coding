from pathlib import Path
from datetime import datetime, timezone, timedelta
from statistics import median
import json

ROOT = Path(__file__).resolve().parent.parent
D = json.loads((ROOT / 'report-data.json').read_text())

def stats(values):
    v = sorted(x for x in values if isinstance(x, (int, float)) and x >= 0)
    return dict(n=len(v), p50=median(v), min=min(v), max=max(v))

def bj(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%m/%d %H:%M:%S')

def slim(e):
    return {k:e[k] for k in ['timestamp','itemId','operation_Id','interview_id','turn_index','measurements']}

setups = [slim(e) for e in D['voice'] if e['name']=='voice.setup' and e['outcome']=='heard']
avatars = [slim(e) | {k:e[k] for k in ['local_candidate','remote_candidate','protocol','relay_protocol']} for e in D['voice'] if e['name']=='voice.avatar' and e['outcome']=='frame']
turns = [slim(e) for e in D['voice'] if e['name']=='voice.turn' and e['turn_kind']=='answer' and e['heard']=='true']
for group in [setups, avatars, turns]:
    for e in group:
        e['label'] = bj(e['timestamp']) + (f' · 回合 {e["turn_index"]}' if e['turn_index'] is not None else '') + ' · ' + e['operation_Id'][:8]

setup_steps = [
    ('start_to_ws', '发起连接 → 浏览器 WS open', 't_connect_start', 't_ws_open'),
    ('ws_to_proxy', 'WS open → proxy.connected', 't_ws_open', 't_proxy_connected'),
    ('proxy_to_updated', 'proxy.connected → session.updated', 't_proxy_connected', 't_session_updated'),
    ('updated_to_frame', 'session.updated → 数字人首帧', 't_session_updated', 't_first_video_frame'),
    ('frame_to_audible', '首帧 → 首次起音检测', 't_first_video_frame', 't_first_audible'),
]
setup_metrics = [{'key':key,'label':label,'start':a,'end':b,**stats([e['measurements'][b]-e['measurements'][a] for e in setups])} for key,label,a,b in setup_steps]
turn_extra = {
    'speaking_ms':stats([e['measurements']['speaking_ms'] for e in turns]),
    'transcript_to_click_ms':stats([e['measurements']['t_answer_click']-e['measurements']['t_transcript'] for e in turns])
}
pairs = [e for e in D['pairs'] if e['route'].endswith('/answer')]
judges = [e for e in D['business'] if e['name']=='judge.call']
overlaps = []
for pair in pairs:
    answer = next(e for e in D['trace'] if e['node_type']=='request' and e['id']==pair['server_id'])
    a0=datetime.fromisoformat(answer['timestamp'].replace('Z','+00:00'))
    for judge in judges:
        if judge['operation_Id'] != answer['operation_Id']:
            continue
        j0=datetime.fromisoformat(judge['timestamp'].replace('Z','+00:00'))
        offset=(a0-j0).total_seconds()*1000
        if 0 <= offset and offset+answer['duration'] <= judge['duration']:
            overlaps.append(dict(operation_Id=answer['operation_Id'],judge_id=judge['id'],answer_id=answer['id'],judge_timestamp=judge['timestamp'],answer_timestamp=answer['timestamp'],judge_ms=judge['duration'],answer_offset_ms=round(offset,3),answer_ms=answer['duration'],label=bj(answer['timestamp'])+' · '+answer['operation_Id'][:8]))
            break

media_comparison=[]
for v in D['media_stats']:
    op=next(e['operation_Id'] for e in D['voice'] if e['interview_id']==v['id'])
    ps=[e for e in pairs if e['operation_Id']==op]
    setup=next(e for e in setups if e['operation_Id']==op)
    media_comparison.append(dict(interview_id=v['id'],operation_Id=op,label=setup['label'],rtt=v['metrics']['rtt_ms'],outside=stats([e['outside_server_ms'] for e in ps]) if ps else None))

scores=[]
for s in D['score']:
    scores.append(dict(request={k:s['request'][k] for k in ['timestamp','id','operation_Id','duration','name']},tasks=s['tasks'],extra_http=[{k:e[k] for k in ['id','offset_ms','duration']} for e in s['extra_http']],last_scoring_ms=s['last_scoring_ms'],extra_span_ms=s['extra_span_ms'],label=bj(s['request']['timestamp'])+' · '+str(s['request']['duration']/1000)+' s · '+('含第二批外呼' if s['extra_http'] else '单批评分')))

out=dict(version=2,scope=D['scope'],baseline='dc17e27cb823d59b43c64b0b1abb1b5b36402358',setups=setups,avatars=avatars,turns=turns,pairs=pairs,judge_overlaps=overlaps,scores=scores,medians=dict(setup=setup_metrics,setup_cumulative=D['summary']['setup'],avatar=D['summary']['avatar'],avatar_candidates={k:stats([e['measurements'][k] for e in avatars]) for k in ['stun_srflx_ms','turn_relay_ms','create_offer_ms']},turn=D['summary']['turn']|turn_extra,judge=stats([e['duration'] for e in judges]),http={k:stats([e[k] for e in pairs]) for k in ['browser_ms','server_ms','outside_server_ms']}),media_comparison=media_comparison)
assert len(setups)==4 and len(avatars)==4 and len(turns)==7 and len(overlaps)==7
assert median([e['outside_server_ms'] for e in pairs])==263
assert sum(D['summary']['turn'][k]['p50'] for k in ['commit_wait_ms','answer_http_ms','answer_to_read_ms','read_to_created_ms','created_to_audible_ms'])==1217
(ROOT/'flow-data.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))

method=dict(created_at_utc=datetime.now(timezone.utc).isoformat(),input='report-data.json',source_data_changed=False,new_cloud_queries=False,code_baseline=out['baseline'],cohorts=dict(setup=4,avatar=4,complete_answer=7,exact_answer_pairs=7,judge_calls=11,judge_answer_overlaps=7,score_operations=2),clocks={
    'overview':'Logical sequence only. Column or row distance is not elapsed time; stage medians come from independent cohorts.',
    'setup':'One voice.setup event, origin t_connect_start. Mic permission/preparation is not fully covered by this timer.',
    'avatar':'One voice.avatar event, origin t_pc_created. total_ms starts at offer_start; differences of up to 1 ms are expected.',
    'turn':'One voice.turn event, origin t_speech_stopped by default; optional full speaking interval uses t_speech_started. Named *_ms fields retain original high-resolution derived durations; endpoints t_* are rounded independently.',
    'judge':'One backend clock: /answer start and duration lie within judge.call in the same operation. No alignment to browser monotonic offsets is claimed.',
    'score':'One backend request clock. 10/09 samples are distinct from the 10/10 voice sessions; no synthetic full-interview latency is produced.'
},statistics={
    'stage_p50':'Median of the named nonnegative duration field when available; setup adjacent intervals and transcript-to-click are differences within each event before median.',
    'http_outside':'median_i(Fetch_i - Server_i) = 263 ms. median(Fetch)=323; median(Server)=56; subtraction of these medians gives 267 ms and is a different statistic.',
    'click_total':'P50 of click_to_audible_ms = 1234 ms; sum of the five separate stage medians = 1217 ms. Never label the latter as an observed whole-turn median.',
    'rtt':'Compare same-interview WebRTC candidate-pair RTT windows with matched HTTP residuals, without claiming equal endpoints, instants, clocks or sample counts.'
},code_supported_dependencies=[
    'Microphone preparation and WebSocket opening run in parallel; recording requires micReady and session.updated.',
    'Avatar starts after a session.updated frame supplies ICE servers; first read waits for media ready or the first-read timeout fallback.',
    'Microphone upload and partial ASR output can overlap; no packet-level upload or ASR compute duration is reconstructed.',
    'All seven observed final transcripts precede click; code also supports click then waiting for final transcript.',
    'BANK /answer does not await Judge; stale Judge results can be discarded using draft/submit generation guards.',
    '/answer completes before the next read request; response.created precedes first audible detection.',
    'response.done is not playback completion.',
    'After final question: disconnect voice, review answers, user submits review, generate report.'
],limitations=[
    'No complete independently instrumented microphone-init, per-hop, answer-review or same-session final-score timing.',
    'The cause of 8+1 outbound scheduling is not established by the traces; no fixed worker limit is asserted.',
    'All measured voice records use Avatar + WebRTC. No pure WS or audio-only performance comparison is inferred.',
    'First audible is the browser detector, not physical speaker output; response playback end and user comprehension are unmeasured.'
])
(ROOT/'evidence'/'flow-derivation.json').write_text(json.dumps(method,ensure_ascii=False,indent=2))
print('Flow data ready:',len(json.dumps(out,ensure_ascii=False).encode()),'bytes; 4 setup, 4 avatar, 7 answer, 7 overlap, 2 scoring records.')
