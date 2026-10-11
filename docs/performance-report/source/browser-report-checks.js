(() => {
 const checks=[];
 const check=(name,passed,detail='')=>checks.push({name,passed:!!passed,detail});
 const select=(id,value)=>{const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));};
 check('HTML initialized',document.documentElement.dataset.reportReady==='true');
 check('All eleven sections rendered',document.querySelectorAll('main section').length===11);
 check('All API routes visible',document.querySelectorAll('#api-table tbody tr').length===59);
 let stageCount=0;
 for(const [kind,count] of [['turn',7],['setup',4],['avatar',4]]){
  select('stage-kind',kind);
  check(kind+' sample count',document.getElementById('stage-sample').options.length===count);
  for(let i=0;i<count;i++){
   select('stage-sample',String(i));
   const text=document.getElementById('stage-content').innerText;
   const bars=[...document.querySelectorAll('#stage-content .bar')];
   check(kind+' '+(i+1)+' rendered',bars.length>=5&&!/NaN|undefined|Infinity/.test(text));stageCount++;
  }
 }
 for(const b of document.querySelectorAll('[data-protocol]')){b.click();check('Protocol '+b.dataset.protocol,document.getElementById('protocol-description').textContent.length>100&&b.getAttribute('aria-pressed')==='true');}
 for(const o of document.getElementById('operation-select').options){
  select('operation-select',o.value);check('Operation '+o.value.slice(0,8),document.getElementById('operation-content').innerText.includes(o.value)&&document.querySelectorAll('#operation-timeline .timeline-row').length>0);
  const e=document.getElementById('trace-lifecycle');e.checked=true;e.dispatchEvent(new Event('change'));check('Lifecycle toggle '+o.value.slice(0,8),document.querySelectorAll('#operation-timeline .timeline-row').length>0);e.checked=false;e.dispatchEvent(new Event('change'));
 }
 for(const o of document.getElementById('media-select').options){for(const k of ['delay','loss','video','bitrate']){select('media-select',o.value);select('media-metric',k);check('Media '+o.value.slice(0,8)+' '+k,!!document.querySelector('#media-chart svg')&&!/NaN|undefined|Infinity/.test(document.getElementById('media-chart').innerHTML));}}
 const search=document.getElementById('api-search');search.value='answer';search.dispatchEvent(new Event('input'));check('API text filter',document.querySelectorAll('#api-table tbody tr').length===1&&document.getElementById('api-table').textContent.includes('58.5'));
 search.value='no_matching_route';search.dispatchEvent(new Event('input'));check('API empty result',document.getElementById('api-table').textContent.includes('没有匹配'));
 search.value='';search.dispatchEvent(new Event('input'));select('api-category','报告生成');check('API category filter',document.querySelectorAll('#api-table tbody tr').length===2);select('api-category','');
 for(const k of ['cpu','memory','pgcpu','pgconn']){select('infra-metric',k);check('Infra '+k,!!document.querySelector('#infra-chart svg')&&!/NaN|undefined|Infinity/.test(document.getElementById('infra-chart').innerHTML));}
 check('Scoring cases rendered',document.querySelectorAll('#scoring-cases article').length===2);
 check('Primary deployment evidence points to original snapshot',document.querySelector('#deployment-table tr:last-child a').getAttribute('href')==='evidence/backend-runtime.json');
 check('No undefined visible text',!/NaN|undefined|Infinity/.test(document.body.innerText));
 check('No page horizontal overflow',document.documentElement.scrollWidth<=innerWidth+1,document.documentElement.scrollWidth+' / '+innerWidth);
 document.querySelector('[data-protocol="avatar"]').click();select('stage-kind','turn');select('operation-select','7bff59c8010e4069bc39b9067ea3e42d');select('media-select','08c066f9-a113-4b33-b36a-996fdde0c132');select('media-metric','delay');select('infra-metric','cpu');
 window.scrollTo({top:0,behavior:'instant'});
 return {total:checks.length,passed:checks.filter(c=>c.passed).length,stageSamplesChecked:stageCount,viewport:{width:innerWidth,height:innerHeight},checks};
})()
