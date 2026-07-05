const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ id:'', style:{ cssText:'' }, _h:'', set innerHTML(v){this._h=v;}, get innerHTML(){return this._h;}, appendChild(){}, remove(){}, querySelector(){return {onclick:null,ontouchend:null,textContent:''};} }), body: { appendChild(){} } };
global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let settings = { arbiter: { enabled: true } };
let ctxObj = { extensionSettings: settings, chatMetadata: {}, name1: 'X', setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };
// hasWorkingRoute is module-scoped; validate through seedSheet behavior instead.
// Case 1: no profile, no generateRaw, no onlineStatus -> seed must NOT call, must warn.
let warned = '';
global.toastr = { info(){}, warning(){}, error(m){ warned = m; }, success(){} };
ctxObj.chat = [{ is_user: true, mes: 'hi', name: 'X' }];
// seedSheet isn't exported; drive via the /arbseed-equivalent path through the interceptor's auto-seed?
// Simplest reliable check: confirm the guard strings + defaults exist (structural), plus that a
// profile+service DOES enable a call by capturing sendRequest.
let called = false;
ctxObj.ConnectionManagerRequestService = { sendRequest: async () => { called = true; return '{"actors":{}}'; } };
settings.arbiter.profileId = 'p1';
(async () => {
  // Trigger an adjudication (uses the same callLLM route) on a risky message
  ctxObj.chatMetadata = {};
  await globalThis.arbiterInterceptor([{ is_user: true, mes: 'I attack the guard with my sword', send_date: 'z1' }], 0, () => {}, 'normal');
  ok('with a profile + service, the route is used (adjudication called the model)', called === true);
  // Now remove the route entirely: no profile, no service, no generateRaw
  called = false;
  ctxObj.ConnectionManagerRequestService = undefined;
  settings.arbiter.profileId = '';
  delete ctxObj.generateRaw;
  await globalThis.arbiterInterceptor([{ is_user: true, mes: 'I attack again', send_date: 'z2' }], 0, () => {}, 'normal');
  ok('with no route, nothing crashes and no call is made', called === false);
  console.log(fails === 0 ? 'ALL V14 TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
