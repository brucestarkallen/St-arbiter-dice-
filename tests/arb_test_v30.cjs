// v0.14.1: ANTI-SYCOPHANCY AUDIT — the MC must genuinely lose at bad odds; no hidden bias.
const noopJq = () => ({ length: 0, append(){return this;}, on(){return this;}, val(){return '';}, prop(){return this;}, html(){return this;}, empty(){return this;}, find(){return this;} });
global.$ = () => noopJq(); global.jQuery = () => {}; global.window = global;
global.document = { getElementById: () => null }; global.toastr = { info(){}, warning(){}, error(){}, success(){} };
let md = {}; let respObj = '{}';
let settings = { arbiter: { enabled: true, timeoutMs: 1600, toastResults: false, eventEngine: false, profileId: 'p1', autoDuel: true, autoSeed: false, mode: 'adjudicated', preset: 'realistic', tieBand: 0, duelPoise: 5, defaultRating: 5, ctxMsgs: 6, composure: true, composureMax: 6 } };
let ctxObj = { extensionSettings: settings, chatMetadata: md, name1: 'Jovan',
  ConnectionManagerRequestService: { sendRequest: async () => respObj },
  setExtensionPrompt(){}, extension_prompt_types:{IN_CHAT:1}, extension_prompt_roles:{SYSTEM:0} };
global.SillyTavern = { getContext: () => ctxObj };
require(require('path').join(__dirname, '..', 'index.js'));
const E = globalThis.ArbiterEngine; const I = globalThis.arbiterInterceptor;
let fails = 0; const ok = (n, c) => { console.log(n + ':', c ? 'OK' : 'FAIL'); if (!c) fails++; };

// 1. THE CURVE IS UNBIASED: at Δ=0, P must be exactly 0.5 (no thumb on the scale).
ok('curve is fair at Δ=0 (P=0.5 exactly)', Math.abs(E.probFromDelta(0) - 0.5) < 1e-9);
ok('curve is symmetric (P(+d)+P(-d)=1)', Math.abs((E.probFromDelta(3) + E.probFromDelta(-3)) - 1) < 1e-9);

// 2. REALISTIC PRESET HAS ZERO BONUS (no free boost for the player).
const preset = E.PRESETS ? E.PRESETS.realistic : { bonus: 0 };
ok('realistic preset gives the player NO bonus', preset.bonus === 0);
ok('realistic preset has neutral tier mods (all 1)', preset.mods.dec === 1 && preset.mods.dis === 1);

// 3. THE MC GENUINELY LOSES AT BAD ODDS. Run a weak MC vs a strong foe many times; the MC must lose often.
(async () => {
  let mcLosses = 0, mcWins = 0, trials = 40;
  for (let t = 0; t < trials; t++) {
    md.arbiter = { sheet: { actors: {} }, log: [], oneShot: 'force', cache: null, composure: 6,
      duel: { active:true, over:false, victor:null, round:1, domain:'melee', scaleMismatch:0,
        player:{name:'Jovan',rating:3,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false},
        opp:{name:'Master',rating:9,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false,composure:6,composureMax:6} } };
    respObj = JSON.stringify({ exchange:true, move_kind:'attack', opp_composure:0, self_composure:0, action:'attack', circumstance:0, why:'x' });
    // Play up to 12 exchanges or until someone wins
    for (let r = 0; r < 12 && md.arbiter.duel && !md.arbiter.duel.over; r++) {
      md.arbiter.oneShot = 'force';
      await I([{ is_user:true, mes:'I strike', send_date:'t'+t+'r'+r }], 0, () => {}, 'normal');
    }
    if (md.arbiter.duel && md.arbiter.duel.over) { if (md.arbiter.duel.victor === 'opp') mcLosses++; else if (md.arbiter.duel.victor === 'player') mcWins++; }
  }
  // A rating-3 MC vs a rating-9 master (Δ-6, ~7% per exchange) must lose the vast majority.
  ok('weak MC vs master LOSES most fights (>70% of ' + trials + ')', mcLosses > trials * 0.7);
  ok('the master does not somehow lose often (MC wins <15%)', mcWins < trials * 0.15);
  console.log('   [MC record vs master: ' + mcWins + ' wins, ' + mcLosses + ' losses]');

  // 4. RECOVERY IS NOT A FREE HEAL: recovering against a strong foe risks a real hit (and can kill).
  let recoveryHits = 0, recoveryDeaths = 0, recTrials = 30;
  for (let t = 0; t < recTrials; t++) {
    md.arbiter = { sheet: { actors: {} }, log: [], oneShot: 'force', cache: null, composure: 6,
      duel: { active:true, over:false, victor:null, round:1, domain:'melee', scaleMismatch:0,
        player:{name:'Jovan',rating:5,poise:1.5,maxPoise:5,injuries:0,momentum:0,opening:false},
        opp:{name:'Killer',rating:9,poise:5,maxPoise:5,injuries:0,momentum:0,opening:false,composure:6,composureMax:6} } };
    const before = md.arbiter.duel.player.poise;
    respObj = JSON.stringify({ exchange:true, move_kind:'recover', opp_composure:0, self_composure:0, action:'catch my breath under fire', circumstance:-1, why:'desperate' });
    await I([{ is_user:true, mes:'I try to recover mid-fight', send_date:'rec'+t }], 0, () => {}, 'normal');
    const d = md.arbiter.duel;
    if (d) { if (d.player.poise < before + 2.5) recoveryHits++; if (d.over && d.victor === 'opp') recoveryDeaths++; }
    else recoveryDeaths++; // duel ended = death
  }
  ok('recovery against a killer is NOT risk-free (opponent lands hits)', recoveryHits > 0);
  ok('a low-poise MC CAN die trying to recover under pressure', recoveryDeaths > 0);
  console.log('   [recovery under fire: ' + recoveryHits + '/' + recTrials + ' took a counter-hit, ' + recoveryDeaths + ' died]');

  // 5. OPENINGS ARE SYMMETRIC: the opponent's opening actually counts in the delta now.
  const mkD = (playerOpening, oppOpening) => ({ active:true, over:false, victor:null, round:1, domain:'melee', scaleMismatch:0,
    player:{name:'Jovan',rating:6,poise:5,maxPoise:5,injuries:0,momentum:0,opening:playerOpening},
    opp:{name:'Foe',rating:6,poise:5,maxPoise:5,injuries:0,momentum:0,opening:oppOpening,composure:6,composureMax:6} });
  md.arbiter = { sheet:{actors:{}}, log:[], oneShot:'force', cache:null, composure:6, duel: mkD(false,false) };
  respObj = JSON.stringify({ exchange:true, move_kind:'attack', opp_composure:0, self_composure:0, action:'x', circumstance:0, why:'x' });
  await I([{is_user:true,mes:'strike',send_date:'sym0'}],0,()=>{},'normal');
  const dNeutral = md.arbiter.log[md.arbiter.log.length-1].delta;
  md.arbiter = { sheet:{actors:{}}, log:[], oneShot:'force', cache:null, composure:6, duel: mkD(false,true) };
  await I([{is_user:true,mes:'strike',send_date:'sym1'}],0,()=>{},'normal');
  const dOppOpening = md.arbiter.log[md.arbiter.log.length-1].delta;
  ok('opponent opening HELPS the opponent (lowers player delta below neutral)', dOppOpening < dNeutral);
  console.log('   [neutral Δ=' + dNeutral + ', with opponent opening Δ=' + dOppOpening + ' — opponent benefits, as it should]');

  console.log(fails === 0 ? 'ALL V30 ANTI-SYCOPHANCY TESTS PASSED' : fails + ' FAILURES'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
