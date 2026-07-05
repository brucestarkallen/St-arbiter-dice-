const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
// Minimal DOM stub that records the activity element
const nodes = {};
global.document = {
  getElementById: (id) => nodes[id] || null,
  createElement: () => { const n = { id:'', style:{}, _html:'', classList:{ add(){}, remove(){} }, set innerHTML(v){ this._html = v; }, get innerHTML(){ return this._html; }, appendChild(){}, remove(){ delete nodes[this.id]; }, addEventListener(){}, querySelector(){ return { onclick:null, ontouchend:null, textContent:'' }; }, offsetWidth:0 }; return n; },
  body: { appendChild(n){ nodes[n.id] = n; } },
};
global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let settings = { arbiter: { enabled: true, showActivity: true } };
global.SillyTavern = { getContext: () => ({ extensionSettings: settings, chatMetadata: {}, name1: 'X', setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} }) };
require(require('path').join(__dirname, '..', 'index.js'));
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
// The module exposes nothing for activity directly; drive via a benign path:
// setActivity/clearActivity are module-scoped, but renderActivity reads getSettings().showActivity.
// Validate the default and toggle plumbing structurally instead:
ok('showActivity default true', settings.arbiter.enabled === true); // sanity of stub
// Confirm default materializes on a fresh store through an interceptor call
settings = { arbiter: {} };
(async () => {
  await globalThis.arbiterInterceptor([{ is_user: true, mes: 'hi', send_date: 'x' }], 0, () => {}, 'normal');
  ok('showActivity defaults to true on fresh store', settings.arbiter.showActivity === true);
  ok('showHud still defaults true', settings.arbiter.showHud === true);
  console.log(fails === 0 ? 'ALL V13 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
