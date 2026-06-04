// Drive the running packaged app over the Chrome DevTools Protocol and screenshot each mode.
const fs = require('fs');

const OUT = 'C:/Users/tjjrj/build-out';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('app page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cmd = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: `(function(){${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) console.log('  JS ERROR:', JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (name) => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('  saved', name + '.png');
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');

  const helpers = `
    function tab(m){[...document.querySelectorAll('.tab')].find(t=>t.dataset.mode===m).click();}
    function setv(n,v,t){n.value=v;n.dispatchEvent(new Event(t||'input',{bubbles:true}));}
  `;

  console.log('PLANNER');
  await evalJs(`${helpers}
    tab('planner');
    setv(document.getElementById('targetItem'),'Reinforced Iron Plate','input');
    setv(document.getElementById('targetRate'),'30','input');
    return 'ok';`);
  await sleep(400); await shot('m-planner');

  console.log('OPTIMIZER');
  await evalJs(`${helpers}
    tab('optimize');
    setv(document.querySelector('#optOutputs .row-item'),'Reinforced Iron Plate','input');
    setv(document.querySelector('#optOutputs .row-rate'),'60','input');
    setv(document.getElementById('optObjective'),'raw','change');
    return 'ok';`);
  await sleep(400); await shot('m-optimize');

  console.log('MAX');
  await evalJs(`${helpers}
    tab('max');
    var sel=document.querySelector('#maxSupply .row-item');
    var opt=[...sel.options].find(o=>o.textContent==='Iron Ore'); if(opt) setv(sel,opt.value,'change');
    setv(document.querySelector('#maxSupply .row-rate'),'120','input');
    setv(document.getElementById('maxProduct'),'Reinforced Iron Plate','input');
    return 'ok';`);
  await sleep(400); await shot('m-max');

  ws.close();
  console.log('DONE');
}
main().catch((e) => { console.error(e); process.exit(1); });
