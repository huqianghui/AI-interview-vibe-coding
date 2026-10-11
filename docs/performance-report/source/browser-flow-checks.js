(() => {
  const root=document.getElementById('interview-flow-v2');
  const checks=[];
  const check=(name,passed,detail='')=>checks.push({name,passed:!!passed,detail});
  const q=k=>root.querySelector('[data-flow="'+k+'"]');
  const choose=(key,value)=>{q(key).value=value;q(key).dispatchEvent(new Event('change',{bubbles:true}));};
  const seek=v=>{q('progress').value=String(v);q('progress').dispatchEvent(new Event('input',{bubbles:true}));};
  check('Flow initialized',root.dataset.ready==='true');
  choose('view','overview');
  check('Eight complete logical stages',root.querySelectorAll('[data-phase]').length===8);
  check('Overview explicitly not a proportional clock',q('meta').textContent.includes('不代表耗时'));
  for(const [view,count] of [['turn',7],['speaking',7],['setup',4],['avatar',4],['judge',7],['score',2]]){
    choose('view',view);check(view+' sample count',q('sample').options.length===count);
    for(let i=0;i<count;i++){
      choose('sample',String(i));
      const rows=[...root.querySelectorAll('[data-row]')];
      const allValid=rows.length>0&&rows.every(r=>Number(r.dataset.start)>=0&&Number(r.dataset.end)>=Number(r.dataset.start));
      check(view+' sample '+i+' valid measured coordinates',allValid&&!/NaN|undefined|Infinity/.test(root.innerText));
      if(view==='avatar')check(view+' sample '+i+' shared ICE/PC start',rows[5].dataset.start===rows[6].dataset.start&&Number(rows[7].dataset.start)<Number(rows[6].dataset.end));
      if(view==='judge')check(view+' sample '+i+' answer within Judge',Number(rows[1].dataset.start)>Number(rows[0].dataset.start)&&Number(rows[1].dataset.end)<Number(rows[0].dataset.end));
    }
  }
  choose('view','turn');choose('sample','3');
  check('Measured turn uses named HTTP duration 303 ms',root.querySelector('[data-row="3"]').dataset.duration==='303');
  check('Measured turn final audible 3056 ms from stop',root.querySelector('[data-row="6"]').dataset.end==='3056');
  seek(750);check('Scrub updates clock',Number(root.dataset.position)===.75&&q('clock').textContent.startsWith('2.29'));
  seek(1000);check('End state detected',q('current').textContent.includes('结束'));
  q('play').click();q('play').click();check('Replay resets cursor',Number(root.dataset.position)===0);
  q('play').click();choose('view','judge');check('View switch pauses playback',root.dataset.playing==='false'&&root.dataset.position==='0');
  choose('sample','3');seek(360);check('Overlapping work announced',q('current').textContent.includes('∥'));
  choose('view','score');choose('sample','1');check('Scoring 9 plus 9 and containing request',root.querySelectorAll('[data-row]').length===19);
  const overflow=[],overlap=[];
  for(const view of ['overview','turn','speaking','setup','avatar','judge','score']){
    choose('view',view);
    const svg=root.querySelector('.flow-svg'),bounds=svg.getBoundingClientRect();
    for(const e of svg.querySelectorAll('text')){const b=e.getBoundingClientRect();if(b.left<bounds.left-1||b.right>bounds.right+1)overflow.push({view,text:e.textContent,left:b.left-bounds.left,right:b.right-bounds.right});}
    const texts=[...svg.querySelectorAll('text')].map(e=>({text:e.textContent,b:e.getBoundingClientRect()}));
    for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){const a=texts[i],b=texts[j];if(Math.min(a.b.right,b.b.right)-Math.max(a.b.left,b.b.left)>2&&Math.min(a.b.bottom,b.b.bottom)-Math.max(a.b.top,b.b.top)>2)overlap.push({view,a:a.text,b:b.text});}
    check(view+' chart sized from actual width',Math.abs(svg.viewBox.baseVal.width-bounds.width)<2);
  }
  check('No SVG text clipped horizontally',overflow.length===0,JSON.stringify(overflow.slice(0,10)));
  check('SVG labels do not overlap',overlap.length===0,JSON.stringify(overlap.slice(0,10)));
  check('No document horizontal overflow',document.documentElement.scrollWidth<=innerWidth+1,document.documentElement.scrollWidth+' / '+innerWidth);
  choose('view','overview');seek(480);
  return {total:checks.length,passed:checks.filter(c=>c.passed).length,viewport:{width:innerWidth,height:innerHeight},checks};
})()
