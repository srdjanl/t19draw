/**
 * T19 DRAW — Server v5
 * Zabava za Trepcu
 */
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const fp  = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  fs.readFile(fp, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(e ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(e ? '404' : d);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

const wss     = new WebSocket.Server({ server, perMessageDeflate: false });
const rooms   = new Map();
const clients = new Map();

// ── helpers ──────────────────────────────────────────────────────
const uid    = () => crypto.randomBytes(8).toString('hex');
const roomId = () => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
};
const shuffle = a => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const mask = w => w.split('').map(c => c === ' ' ? ' ' : '_').join('');
const lev  = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
};

// ── Room ─────────────────────────────────────────────────────────
class Room {
  constructor(id, hostId) {
    this.id          = id;
    this.hostId      = hostId;
    this.players     = new Map();
    this.phase       = 'lobby';
    this.round       = 0;
    this.totalRounds = 8;
    this.roundTime   = 90;
    this.drawerId    = null;
    this.word        = null;
    this.hint        = null;
    this.cat         = null;
    this.maskArr     = null;
    this.timer       = null;
    this.choiceTimer = null;
    this.timeLeft    = 0;
    this.guessed     = new Set();
    this.drawQueue   = [];
    this.drawData    = [];
    this.chat        = [];
  }

  pub() {
    return [...this.players.values()].map(p => ({
      id:        p.id,
      name:      p.name,
      avatar:    p.avatar,
      score:     p.score || 0,
      isHost:    p.id === this.hostId,
      isDrawing: p.id === this.drawerId,
      guessed:   this.guessed.has(p.id),
      connected: p.connected !== false
    }));
  }

  bcast(data, excl = null) {
    const m = JSON.stringify(data);
    this.players.forEach((p, id) => {
      if (id !== excl && p.ws && p.ws.readyState === WebSocket.OPEN)
        p.ws.send(m);
    });
  }

  send(id, data) {
    const p = this.players.get(id);
    if (p && p.ws && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(JSON.stringify(data));
  }

  transferHost(leavingId) {
    if (this.hostId !== leavingId) return;
    const next = [...this.players.values()].find(p => p.id !== leavingId && p.connected !== false);
    if (next) {
      this.hostId = next.id;
      this.bcast({ type: 'hostChanged', newHostId: next.id, newHostName: next.name });
    }
  }

  startGame() {
    const active = [...this.players.values()].filter(p => p.connected !== false);
    if (active.length < 2) return false;
    this.phase = 'playing';
    this.round = 0;
    this.drawQueue = shuffle(active.map(p => p.id));
    this.players.forEach(p => { p.score = 0; });
    this.bcast({ type: 'gameStart', totalRounds: this.totalRounds, roundTime: this.roundTime });
    this.nextRound();
    return true;
  }

  nextRound() {
    this.round++;
    if (this.round > this.totalRounds || this.drawQueue.length === 0) {
      this.endGame(); return;
    }
    while (this.drawQueue.length > 0 && this.players.get(this.drawQueue[0])?.connected === false) {
      this.drawQueue.shift();
    }
    if (this.drawQueue.length === 0) { this.endGame(); return; }

    this.drawerId = this.drawQueue.shift();
    this.guessed.clear();
    this.drawData  = [];
    this.maskArr   = null;
    const choices  = pickWords();
    this.phase     = 'choosing';

    this.bcast({
      type: 'roundStart', round: this.round, totalRounds: this.totalRounds,
      drawerId: this.drawerId, drawerName: this.players.get(this.drawerId)?.name || '?',
      players: this.pub()
    });
    this.send(this.drawerId, { type: 'chooseWord', choices });

    let t = 12;
    clearInterval(this.choiceTimer);
    this.choiceTimer = setInterval(() => {
      t--;
      this.send(this.drawerId, { type: 'choiceCountdown', t });
      if (t <= 0) {
        clearInterval(this.choiceTimer);
        const pick = choices[Math.floor(Math.random() * choices.length)];
        this.wordChosen(this.drawerId, pick.w, pick.h, pick.cat);
      }
    }, 1000);
  }

  wordChosen(pid, word, hint, cat) {
    if (pid !== this.drawerId) return;
    clearInterval(this.choiceTimer);
    this.word     = word;
    this.hint     = hint;
    this.cat      = cat;
    this.phase    = 'drawing';
    this.timeLeft = this.roundTime;
    this.maskArr  = mask(word).split('');

    this.bcast({
      type: 'drawingStart', drawerId: this.drawerId,
      maskedWord: this.maskArr.join(''), wordLength: word.length,
      category: cat, timeLeft: this.timeLeft
    }, this.drawerId);

    this.send(this.drawerId, {
      type: 'drawingStart', drawerId: this.drawerId,
      word, maskedWord: word, wordLength: word.length,
      category: cat, timeLeft: this.timeLeft, isDrawer: true
    });

    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.bcast({ type: 'tick', t: this.timeLeft });
      if (this.timeLeft === Math.floor(this.roundTime * 0.5)) this.reveal();
      if (this.timeLeft === Math.floor(this.roundTime * 0.25)) this.reveal();
      if (this.timeLeft <= 0) { clearInterval(this.timer); this.endRound(false); }
    }, 1000);
  }

  reveal() {
    if (!this.maskArr || !this.word) return;
    const hidden = this.maskArr.reduce((a, c, i) => c === '_' ? [...a, i] : a, []);
    if (!hidden.length) return;
    const idx = hidden[Math.floor(Math.random() * hidden.length)];
    this.maskArr[idx] = this.word[idx];
    this.bcast({ type: 'letterReveal', mask: this.maskArr.join(''), idx, letter: this.word[idx] });
  }

  guess(pid, text) {
    if (pid === this.drawerId || this.guessed.has(pid) || this.phase !== 'drawing') return;
    const target  = this.word.toLowerCase();
    const attempt = text.toLowerCase().trim();
    const correct = attempt === target;
    const close   = !correct && (target.includes(attempt) && attempt.length >= 3 || lev(attempt, target) <= 1);
    const player  = this.players.get(pid);
    if (!player) return;

    if (correct) {
      this.guessed.add(pid);
      const bonus = Math.max(50, Math.round((this.timeLeft / this.roundTime) * 500));
      player.score = (player.score || 0) + bonus;
      const drawer = this.players.get(this.drawerId);
      if (drawer) drawer.score = (drawer.score || 0) + Math.round(bonus * 0.3);
      this.bcast({ type: 'correctGuess', playerId: pid, name: player.name, bonus, players: this.pub() });
      this.send(pid, { type: 'youGuessed', bonus });
      const active = [...this.players.keys()].filter(id => id !== this.drawerId && this.players.get(id)?.connected !== false);
      if (this.guessed.size >= active.length) {
        clearInterval(this.timer);
        setTimeout(() => this.endRound(true), 1500);
      }
    } else {
      const msg = { type: 'chat', playerId: pid, name: player.name, avatar: player.avatar || '', text, isClose: close, ts: Date.now() };
      this.bcast(msg);
      if (close) this.send(pid, { type: 'closeGuess' });
    }
  }

  endRound(allGuessed) {
    clearInterval(this.timer);
    this.phase = 'roundEnd';
    this.bcast({ type: 'roundEnd', word: this.word, allGuessed, players: this.pub(), nextIn: 4000 });
    setTimeout(() => this.nextRound(), 4000);
  }

  endGame() {
    clearInterval(this.timer);
    this.phase = 'gameEnd';
    const sorted = [...this.players.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
    this.bcast({
      type: 'gameEnd',
      winner: sorted[0] ? { name: sorted[0].name, score: sorted[0].score, avatar: sorted[0].avatar } : null,
      players: this.pub().sort((a, b) => b.score - a.score)
    });
    this.phase = 'lobby';
    this.round = 0;
  }

  addDraw(d) { this.drawData.push(d); if (this.drawData.length > 8000) this.drawData.shift(); }
}

// ── WebSocket ────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } handle(ws, m); });
  ws.on('close', () => disconnect(ws));
  ws.on('error', () => disconnect(ws));
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

function handle(ws, msg) {
  const { type } = msg;

  if (type === 'reconnect') {
    const room = rooms.get(msg.roomId);
    const p    = room?.players.get(msg.playerId);
    if (p) {
      p.ws = ws; p.connected = true;
      clients.set(ws, { playerId: p.id, roomId: room.id });
      ws.send(JSON.stringify({
        type: 'reconnected', playerId: p.id, roomId: room.id,
        isHost: room.hostId === p.id, players: room.pub(),
        phase: room.phase, round: room.round,
        totalRounds: room.totalRounds, roundTime: room.roundTime,
        drawData: room.drawData, drawerId: room.drawerId,
        maskedWord: room.phase === 'drawing'
          ? (p.id === room.drawerId ? room.word : (room.maskArr ? room.maskArr.join('') : ''))
          : null,
        timeLeft: room.timeLeft
      }));
      room.bcast({ type: 'playerReconnected', playerId: p.id, name: p.name, players: room.pub() }, p.id);
    } else {
      ws.send(JSON.stringify({ type: 'reconnectFailed' }));
    }
    return;
  }

  if (type === 'createRoom') {
    const rid = roomId(); const pid = uid();
    const room = new Room(rid, pid);
    rooms.set(rid, room);
    const p = { id: pid, ws, name: msg.name || 'Igrac', avatar: msg.avatar || '', score: 0, connected: true };
    room.players.set(pid, p);
    clients.set(ws, { playerId: pid, roomId: rid });
    ws.send(JSON.stringify({ type: 'roomCreated', roomId: rid, playerId: pid, players: room.pub(), totalRounds: room.totalRounds, roundTime: room.roundTime }));
    return;
  }

  if (type === 'joinRoom') {
    const room = rooms.get((msg.roomId || '').toUpperCase());
    if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Soba ne postoji. Proveri kod.' })); return; }
    const pid = uid();
    clients.set(ws, { playerId: pid, roomId: room.id });
    const p = { id: pid, ws, name: msg.name || 'Igrac', avatar: msg.avatar || '', score: 0, connected: true };
    room.players.set(pid, p);
    room.bcast({ type: 'playerJoined', player: { id: pid, name: msg.name, avatar: msg.avatar, score: 0 }, players: room.pub() });
    ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, playerId: pid, isHost: room.hostId === pid, players: room.pub(), phase: room.phase, round: room.round, totalRounds: room.totalRounds, roundTime: room.roundTime, drawData: room.drawData }));
    return;
  }

  const client = clients.get(ws);
  if (!client) return;
  const { playerId, roomId: rid } = client;
  const room = rooms.get(rid);
  if (!room) return;

  switch (type) {
    case 'startGame':
      if (playerId !== room.hostId) { ws.send(JSON.stringify({ type: 'error', msg: 'Samo domacin moze pokrenuti.' })); return; }
      if (!room.startGame()) ws.send(JSON.stringify({ type: 'error', msg: 'Potrebna su najmanje 2 igraca.' }));
      break;
    case 'updateSettings':
      if (playerId !== room.hostId) return;
      if (msg.totalRounds) room.totalRounds = Math.min(20, Math.max(3, +msg.totalRounds));
      if (msg.roundTime)   room.roundTime   = Math.min(180, Math.max(30, +msg.roundTime));
      room.bcast({ type: 'settingsUpdated', totalRounds: room.totalRounds, roundTime: room.roundTime });
      break;
    case 'chooseWord': room.wordChosen(playerId, msg.word, msg.hint, msg.cat); break;
    case 'draw':
      if (playerId !== room.drawerId) return;
      room.addDraw(msg); room.bcast({ ...msg, type: 'draw' }, playerId);
      break;
    case 'clearCanvas':
      if (playerId !== room.drawerId) return;
      room.drawData = []; room.bcast({ type: 'clearCanvas' }, playerId);
      break;
    case 'undoCanvas':
      if (playerId !== room.drawerId) return;
      if (room.drawData.length > 0) room.drawData.pop();
      room.bcast({ type: 'undoCanvas' }, playerId);
      break;
    case 'chat':
      if (room.phase === 'drawing' && playerId !== room.drawerId) {
        room.guess(playerId, msg.text);
      } else {
        const p = room.players.get(playerId);
        const cm = { type: 'chat', playerId, name: p?.name || '?', avatar: p?.avatar || '', text: msg.text, ts: Date.now() };
        room.bcast(cm);
      }
      break;
    case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
    case 'playAgain':
      if (playerId === room.hostId && (room.phase === 'lobby' || room.phase === 'gameEnd')) room.startGame();
      break;
  }
}

function disconnect(ws) {
  const client = clients.get(ws);
  if (!client) return;
  clients.delete(ws);
  const { playerId, roomId: rid } = client;
  const room = rooms.get(rid);
  if (!room) return;

  const p = room.players.get(playerId);
  if (p) { p.connected = false; p.ws = null; }

  room.transferHost(playerId);

  if ((room.phase === 'drawing' || room.phase === 'choosing') && room.drawerId === playerId) {
    clearInterval(room.timer);
    clearInterval(room.choiceTimer);
    room.bcast({ type: 'drawerLeft', players: room.pub() });
    setTimeout(() => { if (rooms.has(rid)) room.nextRound(); }, 2500);
  } else {
    room.bcast({ type: 'playerDisconnected', playerId, players: room.pub() });
  }

  setTimeout(() => {
    const r = rooms.get(rid);
    if (!r) return;
    const pl = r.players.get(playerId);
    if (pl && pl.connected === false) {
      r.players.delete(playerId);
      r.bcast({ type: 'playerRemoved', playerId, players: r.pub() });
    }
    if (r.players.size === 0) rooms.delete(rid);
  }, 60000);
}

// ── Word database ─────────────────────────────────────────────────
// Samo latinicom, samo nacrtljive reci, ispravljeno
const WORDS = [
  // ZIVOTINJE
  {w:'macka',h:'Kaze mjau',cat:'Zivotinje'},
  {w:'pas',h:'Covekov prijatelj',cat:'Zivotinje'},
  {w:'konj',h:'Jede seno',cat:'Zivotinje'},
  {w:'krava',h:'Daje mleko',cat:'Zivotinje'},
  {w:'ovca',h:'Daje vunu',cat:'Zivotinje'},
  {w:'svinja',h:'Voli blato',cat:'Zivotinje'},
  {w:'kokos',h:'Nosi jaja',cat:'Zivotinje'},
  {w:'patka',h:'Pliva i kvaca',cat:'Zivotinje'},
  {w:'zec',h:'Duge usi, brz',cat:'Zivotinje'},
  {w:'vuk',h:'Vije u sumi',cat:'Zivotinje'},
  {w:'medved',h:'Voli med',cat:'Zivotinje'},
  {w:'lisica',h:'Lukava zver',cat:'Zivotinje'},
  {w:'srna',h:'Sumska lepotica',cat:'Zivotinje'},
  {w:'jelen',h:'Ima rogove',cat:'Zivotinje'},
  {w:'jazavac',h:'Kopa rupe',cat:'Zivotinje'},
  {w:'dabar',h:'Gradi brane',cat:'Zivotinje'},
  {w:'veverica',h:'Skuplja lesnjike',cat:'Zivotinje'},
  {w:'jez',h:'Bodljikav',cat:'Zivotinje'},
  {w:'mis',h:'Mali glodavac',cat:'Zivotinje'},
  {w:'lav',h:'Kralj dzungle',cat:'Zivotinje'},
  {w:'tigar',h:'Prugasto mace',cat:'Zivotinje'},
  {w:'slon',h:'Dugacak nos',cat:'Zivotinje'},
  {w:'zirafa',h:'Najduzi vrat',cat:'Zivotinje'},
  {w:'zebra',h:'Crno-bele pruge',cat:'Zivotinje'},
  {w:'gorila',h:'Veliki majmun',cat:'Zivotinje'},
  {w:'kengur',h:'Ima dzepeove',cat:'Zivotinje'},
  {w:'koala',h:'Voli eukaliptus',cat:'Zivotinje'},
  {w:'pingvin',h:'Ne leti',cat:'Zivotinje'},
  {w:'delfin',h:'Pametna morska zivotinja',cat:'Zivotinje'},
  {w:'kit',h:'Najveci sisavac',cat:'Zivotinje'},
  {w:'ajkula',h:'Opasna morska riba',cat:'Zivotinje'},
  {w:'hobotnica',h:'8 krakova',cat:'Zivotinje'},
  {w:'krokodil',h:'Zeleni guster',cat:'Zivotinje'},
  {w:'kameleon',h:'Menja boju',cat:'Zivotinje'},
  {w:'zmija',h:'Nema nogu',cat:'Zivotinje'},
  {w:'zaba',h:'Skakuce i kvakuce',cat:'Zivotinje'},
  {w:'kornjaca',h:'Nosi kucu na ledima',cat:'Zivotinje'},
  {w:'sova',h:'Nocna ptica',cat:'Zivotinje'},
  {w:'orao',h:'Leti visoko',cat:'Zivotinje'},
  {w:'papagaj',h:'Govori',cat:'Zivotinje'},
  {w:'leptir',h:'Sarena krila',cat:'Zivotinje'},
  {w:'pcela',h:'Pravi med',cat:'Zivotinje'},
  {w:'mrav',h:'Vredan insekt',cat:'Zivotinje'},
  {w:'pauk',h:'8 nogu',cat:'Zivotinje'},
  {w:'puz',h:'Nosi kucu',cat:'Zivotinje'},
  {w:'labud',h:'Bela ptica na jezeru',cat:'Zivotinje'},
  {w:'flamingo',h:'Ruzicastia ptica',cat:'Zivotinje'},
  {w:'panda',h:'Crno-beli medved',cat:'Zivotinje'},
  {w:'kamila',h:'Grba na ledima',cat:'Zivotinje'},
  {w:'lama',h:'Pljuje',cat:'Zivotinje'},
  {w:'gepard',h:'Najbrzta zivotinja',cat:'Zivotinje'},
  {w:'leopard',h:'Tackasta macka',cat:'Zivotinje'},
  {w:'nosorog',h:'Rog na nosu',cat:'Zivotinje'},
  {w:'nilski konj',h:'Debeo u vodi',cat:'Zivotinje'},
  {w:'noj',h:'Velika ptica ne leti',cat:'Zivotinje'},
  {w:'los',h:'Ogromni rogovi',cat:'Zivotinje'},
  {w:'rakun',h:'Maska na licu',cat:'Zivotinje'},
  {w:'koza',h:'Pase na livadi',cat:'Zivotinje'},
  {w:'magarac',h:'Nosi teret',cat:'Zivotinje'},
  {w:'bik',h:'Muska krava sa rogovima',cat:'Zivotinje'},
  {w:'skunk',h:'Ima jak miris',cat:'Zivotinje'},
  {w:'jastog',h:'Crveni morski rak',cat:'Zivotinje'},
  {w:'caplja',h:'Dugacak vrat u vodi',cat:'Zivotinje'},
  {w:'orka',h:'Crno-beli kit',cat:'Zivotinje'},
  {w:'aligator',h:'Americki krokodil',cat:'Zivotinje'},
  {w:'iguana',h:'Tropski guster',cat:'Zivotinje'},
  {w:'morska zvezda',h:'Zivi u moru',cat:'Zivotinje'},
  {w:'bivo',h:'Divlji bik',cat:'Zivotinje'},
  {w:'alpaka',h:'Slatka vunena lama',cat:'Zivotinje'},
  {w:'tukan',h:'Saren kljun',cat:'Zivotinje'},
  {w:'pelikan',h:'Kljun-torba',cat:'Zivotinje'},
  {w:'rode',h:'Stork ptica na dimnjaku',cat:'Zivotinje'},
  {w:'fazan',h:'Sarena lovacka ptica',cat:'Zivotinje'},
  {w:'roda',h:'Bijela ptica na dimnjaku',cat:'Zivotinje'},
  // HRANA
  {w:'pica',h:'Talijanska hrana',cat:'Hrana'},
  {w:'hamburger',h:'Americki fast food',cat:'Hrana'},
  {w:'supa',h:'Topla tecna hrana',cat:'Hrana'},
  {w:'corba',h:'Nase toplo jelo',cat:'Hrana'},
  {w:'cevapi',h:'Balkanski specijalitet',cat:'Hrana'},
  {w:'burek',h:'Sa sirom ili mesom',cat:'Hrana'},
  {w:'gibanica',h:'Pita sa sirom',cat:'Hrana'},
  {w:'sarma',h:'Meso u kiselom kupusu',cat:'Hrana'},
  {w:'musaka',h:'Sa krompirima i mesom',cat:'Hrana'},
  {w:'pasulj',h:'Bob u corbi',cat:'Hrana'},
  {w:'hleb',h:'Osnovna hrana',cat:'Hrana'},
  {w:'kifla',h:'Okruglo pecivo',cat:'Hrana'},
  {w:'torta',h:'Za rodendane',cat:'Hrana'},
  {w:'sladoled',h:'Hladno i slatko',cat:'Hrana'},
  {w:'cokolada',h:'Kakaova slatkica',cat:'Hrana'},
  {w:'jabuka',h:'Crveno voce',cat:'Hrana'},
  {w:'banana',h:'Zuto voce',cat:'Hrana'},
  {w:'grozdze',h:'Sitni plodovi za vino',cat:'Hrana'},
  {w:'lubenica',h:'Zelena spolja crvena iznutra',cat:'Hrana'},
  {w:'jagoda',h:'Crvena sitna',cat:'Hrana'},
  {w:'malina',h:'Sumska jagoda',cat:'Hrana'},
  {w:'paradajz',h:'Crveno povrce',cat:'Hrana'},
  {w:'krastavac',h:'Zeleno povrce',cat:'Hrana'},
  {w:'paprika',h:'Crvena ili zelena',cat:'Hrana'},
  {w:'luk',h:'Cini te plakati',cat:'Hrana'},
  {w:'beli luk',h:'Vampiri ga mrze',cat:'Hrana'},
  {w:'krompir',h:'Pecen ili kuvan',cat:'Hrana'},
  {w:'sargarepa',h:'Narancasto povrce',cat:'Hrana'},
  {w:'jaje',h:'Koke ga nose',cat:'Hrana'},
  {w:'sir',h:'Od mleka',cat:'Hrana'},
  {w:'mleko',h:'Bela tecnost',cat:'Hrana'},
  {w:'med',h:'Pcele ga prave',cat:'Hrana'},
  {w:'kafa',h:'Jutarnji napitak',cat:'Hrana'},
  {w:'caj',h:'Sa limunom',cat:'Hrana'},
  {w:'limun',h:'Kiselo zuto voce',cat:'Hrana'},
  {w:'narandza',h:'Narancasto okruglo voce',cat:'Hrana'},
  {w:'avokado',h:'Zeleni kremasti plod',cat:'Hrana'},
  {w:'ananas',h:'Bodljikav sa krunom',cat:'Hrana'},
  {w:'cips',h:'Iz kese slano',cat:'Hrana'},
  {w:'kokice',h:'Iz bioskopa',cat:'Hrana'},
  {w:'krofna',h:'Okrugla masna',cat:'Hrana'},
  {w:'kobasica',h:'U crevu',cat:'Hrana'},
  {w:'rostilj',h:'Meso na vatri',cat:'Hrana'},
  {w:'raznjic',h:'Meso na stapicu',cat:'Hrana'},
  {w:'pljeskavica',h:'Srpski hamburger',cat:'Hrana'},
  {w:'knedle',h:'Sa sljivom',cat:'Hrana'},
  {w:'strudla',h:'Sa jabukama',cat:'Hrana'},
  {w:'baklava',h:'Sa orasima i medom',cat:'Hrana'},
  {w:'dzem',h:'Vocni namaz',cat:'Hrana'},
  {w:'pekmez',h:'Kuvana sljiva',cat:'Hrana'},
  {w:'ajvar',h:'Srpski namaz od paprike',cat:'Hrana'},
  {w:'kajmak',h:'Kremasta srpska pavlaka',cat:'Hrana'},
  {w:'proja',h:'Kukuruzni hleb',cat:'Hrana'},
  {w:'krempita',h:'Sa kremom i korama',cat:'Hrana'},
  {w:'palacinka',h:'Sa dzemom',cat:'Hrana'},
  {w:'jogurt',h:'Kiselo mleko',cat:'Hrana'},
  {w:'puter',h:'Zuti namaz od mleka',cat:'Hrana'},
  {w:'sljivovica',h:'Srpska rakija',cat:'Hrana'},
  {w:'boranija',h:'Zeleni pasulj',cat:'Hrana'},
  {w:'bundeva',h:'Narandzasta tikva',cat:'Hrana'},
  {w:'kupus',h:'Zelena glava',cat:'Hrana'},
  {w:'spanak',h:'Zeleno lisnato povrce',cat:'Hrana'},
  {w:'praz',h:'Duguljasti luk',cat:'Hrana'},
  {w:'smokva',h:'Slatka i mekana',cat:'Hrana'},
  {w:'nar',h:'Crveni plod sa semenima',cat:'Hrana'},
  {w:'kivi',h:'Zelen iznutra',cat:'Hrana'},
  {w:'mango',h:'Tropski slatki plod',cat:'Hrana'},
  // SPORT
  {w:'fudbal',h:'11 igraca gol',cat:'Sport'},
  {w:'kosarka',h:'Kos i lopta',cat:'Sport'},
  {w:'tenis',h:'Reket i loptica',cat:'Sport'},
  {w:'odbojka',h:'Mreza i sest igraca',cat:'Sport'},
  {w:'rukomet',h:'Baca se rukom',cat:'Sport'},
  {w:'vaterpolo',h:'Fudbal u vodi',cat:'Sport'},
  {w:'plivanje',h:'U bazenu',cat:'Sport'},
  {w:'atletika',h:'Trcanje i skakanje',cat:'Sport'},
  {w:'gimnastika',h:'Okretnost',cat:'Sport'},
  {w:'boks',h:'Sa rukavicama',cat:'Sport'},
  {w:'rvanje',h:'Na stunjaci',cat:'Sport'},
  {w:'dzudo',h:'Japanska borba',cat:'Sport'},
  {w:'karate',h:'Hija!',cat:'Sport'},
  {w:'macevanje',h:'Sa macem',cat:'Sport'},
  {w:'biciklizam',h:'Na dva tocka',cat:'Sport'},
  {w:'skijanje',h:'Na snegu',cat:'Sport'},
  {w:'klizanje',h:'Na ledu',cat:'Sport'},
  {w:'hokej',h:'Na ledu sa palicom',cat:'Sport'},
  {w:'golf',h:'Mala lopta rupa',cat:'Sport'},
  {w:'ragbi',h:'Ovalna lopta',cat:'Sport'},
  {w:'surfovanje',h:'Na talasima',cat:'Sport'},
  {w:'jedrenje',h:'Sa jedrom',cat:'Sport'},
  {w:'penjanje',h:'Na stenu',cat:'Sport'},
  {w:'padobranstvo',h:'Sa aviona',cat:'Sport'},
  {w:'stoni tenis',h:'Mali reket',cat:'Sport'},
  {w:'badminton',h:'Sa perusaricom',cat:'Sport'},
  {w:'formula 1',h:'Brzi automobili',cat:'Sport'},
  {w:'maraton',h:'42 km trcanje',cat:'Sport'},
  {w:'sprint',h:'Brzo kratko trcanje',cat:'Sport'},
  {w:'sah',h:'Figura i tabla',cat:'Sport'},
  {w:'bocanje',h:'Bacanje lopti',cat:'Sport'},
  {w:'pikado',h:'Gadanje table',cat:'Sport'},
  {w:'kuglanje',h:'Rusi cunjeve',cat:'Sport'},
  {w:'skateboard',h:'Daska sa tockovima',cat:'Sport'},
  {w:'triatlon',h:'Tri sporta u jednom',cat:'Sport'},
  {w:'veslanje',h:'U cunu',cat:'Sport'},
  {w:'ronjenje',h:'Pod vodom',cat:'Sport'},
  {w:'paraglajding',h:'Sa krilima',cat:'Sport'},
  {w:'kickboxing',h:'Boks sa nogama',cat:'Sport'},
  {w:'streljastvo',h:'Luk i strelica',cat:'Sport'},
  {w:'reli',h:'Auto trke po putu',cat:'Sport'},
  {w:'motociklizam',h:'Trke motora',cat:'Sport'},
  {w:'bejzbol',h:'Palica i lopta',cat:'Sport'},
  {w:'polo',h:'Na konjima sa maljem',cat:'Sport'},
  {w:'sumo',h:'Japansko rvanje',cat:'Sport'},
  {w:'yoga',h:'Stretching i meditacija',cat:'Sport'},
  // PRIRODA
  {w:'planina',h:'Visoka i strma',cat:'Priroda'},
  {w:'reka',h:'Tece prema moru',cat:'Priroda'},
  {w:'jezero',h:'Mirna voda okruzena kopnom',cat:'Priroda'},
  {w:'more',h:'Slana voda',cat:'Priroda'},
  {w:'okean',h:'Ogromna slana voda',cat:'Priroda'},
  {w:'suma',h:'Mnogo drveca',cat:'Priroda'},
  {w:'livada',h:'Zelena trava',cat:'Priroda'},
  {w:'polje',h:'Ravnica',cat:'Priroda'},
  {w:'pustinja',h:'Suva i vruca',cat:'Priroda'},
  {w:'vulkan',h:'Izbacuje lavu',cat:'Priroda'},
  {w:'pecina',h:'Rupa u planini',cat:'Priroda'},
  {w:'slap',h:'Voda pada sa visine',cat:'Priroda'},
  {w:'duga',h:'Posle kise sarena',cat:'Priroda'},
  {w:'sneg',h:'Beli i hladan',cat:'Priroda'},
  {w:'led',h:'Zamrznuta voda',cat:'Priroda'},
  {w:'tornado',h:'Vrteci vihor',cat:'Priroda'},
  {w:'cunami',h:'Dzinovski talas',cat:'Priroda'},
  {w:'cvet',h:'Lepo mirisi',cat:'Priroda'},
  {w:'drvo',h:'Sa granama i listovima',cat:'Priroda'},
  {w:'sunce',h:'Zvezda dnevne svetlosti',cat:'Priroda'},
  {w:'mesec',h:'Nocno svetlo',cat:'Priroda'},
  {w:'zvezda',h:'Svetli na nebu',cat:'Priroda'},
  {w:'oblak',h:'Beli na nebu',cat:'Priroda'},
  {w:'kisa',h:'Pada s neba',cat:'Priroda'},
  {w:'dolina',h:'Izmedju planina',cat:'Priroda'},
  {w:'ostrvo',h:'Kopno usred mora',cat:'Priroda'},
  {w:'kaktus',h:'Bodljikava biljka',cat:'Priroda'},
  {w:'palma',h:'Tropsko drvo',cat:'Priroda'},
  {w:'bambus',h:'Brzo rastuci stap',cat:'Priroda'},
  {w:'pecurka',h:'Jesenja gljiva',cat:'Priroda'},
  {w:'ruza',h:'Crveni cvet sa trnjem',cat:'Priroda'},
  {w:'lala',h:'Prolecni cvet',cat:'Priroda'},
  {w:'suncokret',h:'Zuti cvet raste visoko',cat:'Priroda'},
  {w:'hrast',h:'Staro jako drvo',cat:'Priroda'},
  {w:'bor',h:'Zimzeleno drvo',cat:'Priroda'},
  {w:'jelka',h:'Bozicno drvo',cat:'Priroda'},
  {w:'kesten',h:'Jesen bode',cat:'Priroda'},
  {w:'orah',h:'Tvrdi omotac',cat:'Priroda'},
  {w:'magla',h:'Ne vidi se daleko',cat:'Priroda'},
  {w:'mraz',h:'Bela tanka korica',cat:'Priroda'},
  {w:'poplava',h:'Previse vode',cat:'Priroda'},
  {w:'oluja',h:'Jak vetar i kisa',cat:'Priroda'},
  {w:'vetar',h:'Vazduh koji se krece',cat:'Priroda'},
  {w:'potres',h:'Trese se zemlja',cat:'Priroda'},
  {w:'grmljavina',h:'Munja i grom',cat:'Priroda'},
  {w:'aurora',h:'Severna svetlost',cat:'Priroda'},
  // PROFESIJE
  {w:'lekar',h:'Leci bolesne',cat:'Profesije'},
  {w:'hirurg',h:'Operacije',cat:'Profesije'},
  {w:'zubar',h:'Brine o zubima',cat:'Profesije'},
  {w:'vatrogasac',h:'Gasi pozare',cat:'Profesije'},
  {w:'policajac',h:'Cuva red',cat:'Profesije'},
  {w:'vojnik',h:'Brani zemlju',cat:'Profesije'},
  {w:'pilot',h:'Vodi avion',cat:'Profesije'},
  {w:'mornar',h:'Na brodu',cat:'Profesije'},
  {w:'kapetan',h:'Vodi brod',cat:'Profesije'},
  {w:'profesor',h:'Predaje u skoli',cat:'Profesije'},
  {w:'ucitelj',h:'Osnovna skola',cat:'Profesije'},
  {w:'advokat',h:'Brani na sudu',cat:'Profesije'},
  {w:'sudija',h:'Sudi',cat:'Profesije'},
  {w:'arhitekta',h:'Projektuje zgrade',cat:'Profesije'},
  {w:'inzenjer',h:'Gradi i projektuje',cat:'Profesije'},
  {w:'programer',h:'Pise kod',cat:'Profesije'},
  {w:'naucnik',h:'Istrazuje',cat:'Profesije'},
  {w:'astronaut',h:'Ide u svemir',cat:'Profesije'},
  {w:'kuvar',h:'Sprema hranu',cat:'Profesije'},
  {w:'konobar',h:'Posluzuje hranu',cat:'Profesije'},
  {w:'frizer',h:'Sisa kosu',cat:'Profesije'},
  {w:'zidar',h:'Gradi zidove',cat:'Profesije'},
  {w:'mehanicar',h:'Popravlja auta',cat:'Profesije'},
  {w:'taksista',h:'Vozi ljude',cat:'Profesije'},
  {w:'farmer',h:'Uzgaja hranu',cat:'Profesije'},
  {w:'ribar',h:'Peca ribu',cat:'Profesije'},
  {w:'slikar',h:'Slika slike',cat:'Profesije'},
  {w:'muzictar',h:'Svira instrument',cat:'Profesije'},
  {w:'pevac',h:'Peva pesme',cat:'Profesije'},
  {w:'glumac',h:'Igra u filmovima',cat:'Profesije'},
  {w:'novinar',h:'Pise vesti',cat:'Profesije'},
  {w:'fotograf',h:'Pravi fotografije',cat:'Profesije'},
  {w:'farmaceut',h:'Daje lekove',cat:'Profesije'},
  {w:'veterinar',h:'Lekar za zivotinje',cat:'Profesije'},
  {w:'psiholog',h:'Leci um',cat:'Profesije'},
  {w:'dizajner',h:'Stvara vizuelno',cat:'Profesije'},
  {w:'pisac',h:'Pise knjige',cat:'Profesije'},
  {w:'prevodilac',h:'Prevodi jezike',cat:'Profesije'},
  {w:'direktor',h:'Vodi firmu',cat:'Profesije'},
  {w:'menazer',h:'Organizuje tim',cat:'Profesije'},
  {w:'geolog',h:'Proucava stene',cat:'Profesije'},
  {w:'meteorolog',h:'Predvidja vreme',cat:'Profesije'},
  {w:'arheolog',h:'Iskopava starine',cat:'Profesije'},
  {w:'spasilac',h:'Spasava ljude',cat:'Profesije'},
  {w:'ronilac',h:'Roni pod vodom',cat:'Profesije'},
  {w:'tesar',h:'Radi s drvetom',cat:'Profesije'},
  {w:'elektricar',h:'Radi sa strujom',cat:'Profesije'},
  {w:'vodoinstalater',h:'Radi sa cevima',cat:'Profesije'},
  {w:'pekar',h:'Pece hleb',cat:'Profesije'},
  {w:'mesar',h:'Prodaje meso',cat:'Profesije'},
  // PREVOZ
  {w:'auto',h:'Cetiri tocka motor',cat:'Prevoz'},
  {w:'motocikl',h:'Dva tocka brz',cat:'Prevoz'},
  {w:'bicikl',h:'Pedalira',cat:'Prevoz'},
  {w:'autobus',h:'Mnogo putnika',cat:'Prevoz'},
  {w:'tramvaj',h:'Na sinama u gradu',cat:'Prevoz'},
  {w:'metro',h:'Podzemna voznja',cat:'Prevoz'},
  {w:'voz',h:'Na sinama',cat:'Prevoz'},
  {w:'brod',h:'Na vodi',cat:'Prevoz'},
  {w:'jahta',h:'Luksuzni brod',cat:'Prevoz'},
  {w:'avion',h:'Leti na nebu',cat:'Prevoz'},
  {w:'helikopter',h:'Vertikalno uzlijece',cat:'Prevoz'},
  {w:'raketa',h:'Ide u svemir',cat:'Prevoz'},
  {w:'kamion',h:'Prevozi teret',cat:'Prevoz'},
  {w:'traktor',h:'Na farmi',cat:'Prevoz'},
  {w:'buldozer',h:'Gura zemlju',cat:'Prevoz'},
  {w:'kran',h:'Podize terete',cat:'Prevoz'},
  {w:'taksi',h:'Prevozi ljude za novac',cat:'Prevoz'},
  {w:'limuzina',h:'Dugacak auto',cat:'Prevoz'},
  {w:'trotinet',h:'Stoji i vozi',cat:'Prevoz'},
  {w:'gondola',h:'Venecijanski camac',cat:'Prevoz'},
  {w:'zicara',h:'Ide po kablu',cat:'Prevoz'},
  {w:'tenk',h:'Vojno vozilo',cat:'Prevoz'},
  {w:'dzip',h:'Terensko vozilo',cat:'Prevoz'},
  {w:'karavan',h:'Dom na tockovima',cat:'Prevoz'},
  {w:'tanker',h:'Brod za naftu',cat:'Prevoz'},
  {w:'podmornica',h:'Plovi pod vodom',cat:'Prevoz'},
  {w:'fijaker',h:'Kola sa konjem',cat:'Prevoz'},
  {w:'elektricni auto',h:'Bez benzina',cat:'Prevoz'},
  {w:'balon',h:'Leti sa gasom',cat:'Prevoz'},
  {w:'parna lokomotiva',h:'Stara lokomotiva sa parom',cat:'Prevoz'},
  {w:'ATV',h:'Cetvorotockas',cat:'Prevoz'},
  {w:'hidrogliser',h:'Brzi camac koji klizi',cat:'Prevoz'},
  {w:'snezni skuter',h:'Prevoz po snegu',cat:'Prevoz'},
  {w:'vatrogasni kamion',h:'Crveni kamion',cat:'Prevoz'},
  {w:'hitna pomoc',h:'Bela sa sirenom',cat:'Prevoz'},
  {w:'policijski auto',h:'Sa sirenom i svetlima',cat:'Prevoz'},
  {w:'kombajn',h:'Bere zito',cat:'Prevoz'},
  // PREDMETI
  {w:'stolica',h:'Sedimo',cat:'Predmeti'},
  {w:'sto',h:'Stavljamo stvari',cat:'Predmeti'},
  {w:'krevet',h:'Spavamo',cat:'Predmeti'},
  {w:'orman',h:'Cuvamo odecu',cat:'Predmeti'},
  {w:'lampa',h:'Daje svetlost',cat:'Predmeti'},
  {w:'televizor',h:'Gledamo filmove',cat:'Predmeti'},
  {w:'telefon',h:'Zovemo ljude',cat:'Predmeti'},
  {w:'kompjuter',h:'Za rad i igru',cat:'Predmeti'},
  {w:'kamera',h:'Snima slike',cat:'Predmeti'},
  {w:'slusalice',h:'Za muziku',cat:'Predmeti'},
  {w:'mikrofon',h:'Snima glas',cat:'Predmeti'},
  {w:'gitara',h:'6 zica',cat:'Predmeti'},
  {w:'klavir',h:'Belo-crne dirke',cat:'Predmeti'},
  {w:'violina',h:'Gudalo i zice',cat:'Predmeti'},
  {w:'bubnjevi',h:'Udaraljke',cat:'Predmeti'},
  {w:'knjiga',h:'Citamo',cat:'Predmeti'},
  {w:'olovka',h:'Pisemo i crtamo',cat:'Predmeti'},
  {w:'makaze',h:'Secemo',cat:'Predmeti'},
  {w:'lenjir',h:'Merimo duzinu',cat:'Predmeti'},
  {w:'sat',h:'Meri vreme',cat:'Predmeti'},
  {w:'naocare',h:'Za oci',cat:'Predmeti'},
  {w:'sesir',h:'Na glavi',cat:'Predmeti'},
  {w:'kapa',h:'Zimska za glavu',cat:'Predmeti'},
  {w:'sal',h:'Oko vrata',cat:'Predmeti'},
  {w:'cipele',h:'Na nogama',cat:'Predmeti'},
  {w:'torba',h:'Nosimo stvari',cat:'Predmeti'},
  {w:'ruksak',h:'Na ledima',cat:'Predmeti'},
  {w:'novcanik',h:'Za novac',cat:'Predmeti'},
  {w:'kljucevi',h:'Otvaraju brave',cat:'Predmeti'},
  {w:'ogledalo',h:'Vidimo sebe',cat:'Predmeti'},
  {w:'cetkica za zube',h:'Cetkamo zube',cat:'Predmeti'},
  {w:'sapun',h:'Za pranje',cat:'Predmeti'},
  {w:'peskir',h:'Brisemo se',cat:'Predmeti'},
  {w:'lonac',h:'Kuvamo',cat:'Predmeti'},
  {w:'tiganj',h:'Przimo',cat:'Predmeti'},
  {w:'noz',h:'Secemo hranu',cat:'Predmeti'},
  {w:'viljuska',h:'Jedemo',cat:'Predmeti'},
  {w:'kasika',h:'Za supu',cat:'Predmeti'},
  {w:'casa',h:'Za pice',cat:'Predmeti'},
  {w:'tanjir',h:'Za hranu',cat:'Predmeti'},
  {w:'frizider',h:'Hladi hranu',cat:'Predmeti'},
  {w:'sporet',h:'Kuvamo na njemu',cat:'Predmeti'},
  {w:'ves masina',h:'Pere ves',cat:'Predmeti'},
  {w:'usisivac',h:'Usisava prasinu',cat:'Predmeti'},
  {w:'lopta',h:'Okrugla za igru',cat:'Predmeti'},
  {w:'kockice',h:'Igramo se',cat:'Predmeti'},
  {w:'karte za igru',h:'Za igru',cat:'Predmeti'},
  {w:'sveska',h:'Pisemo u nju',cat:'Predmeti'},
  {w:'kupa',h:'Za trofej',cat:'Predmeti'},
  {w:'medalja',h:'Za pobednike',cat:'Predmeti'},
  {w:'prsten',h:'Na prstu',cat:'Predmeti'},
  {w:'ogrlica',h:'Oko vrata',cat:'Predmeti'},
  {w:'kisobran',h:'Za kisu',cat:'Predmeti'},
  {w:'termos',h:'Drzi toplotu',cat:'Predmeti'},
  {w:'boca',h:'Plasticna za pice',cat:'Predmeti'},
  {w:'kovceg',h:'Za putovanje',cat:'Predmeti'},
  {w:'papuce',h:'Kucne cipele',cat:'Predmeti'},
  {w:'cizme',h:'Visoke cipele',cat:'Predmeti'},
  {w:'tenisice',h:'Sportske cipele',cat:'Predmeti'},
  {w:'jakna',h:'Kaput',cat:'Predmeti'},
  {w:'majica',h:'Osnovna gornja odeca',cat:'Predmeti'},
  {w:'farmerke',h:'Traper pantalone',cat:'Predmeti'},
  {w:'baterija',h:'Daje struju',cat:'Predmeti'},
  {w:'punjac',h:'Za telefon',cat:'Predmeti'},
  {w:'tablet',h:'Veliki ekran bez tastature',cat:'Predmeti'},
  {w:'dron',h:'Leti daljinskom upravom',cat:'Predmeti'},
  {w:'teleskop',h:'Gleda daleke zvezde',cat:'Predmeti'},
  {w:'mikroskop',h:'Uvecava sitne stvari',cat:'Predmeti'},
  {w:'kompas',h:'Pokazuje sever',cat:'Predmeti'},
  {w:'termometar',h:'Meri temperaturu',cat:'Predmeti'},
  {w:'metla',h:'Metemo pod',cat:'Predmeti'},
  {w:'lopata',h:'Kopamo',cat:'Predmeti'},
  {w:'cekic',h:'Cuca ekser',cat:'Predmeti'},
  {w:'testera',h:'Sece drvo',cat:'Predmeti'},
  {w:'sef',h:'Cuvamo novac',cat:'Predmeti'},
  {w:'pasos',h:'Za putovanje',cat:'Predmeti'},
  {w:'karta sveta',h:'Prikazuje drzave',cat:'Predmeti'},
  {w:'globus',h:'Okrugla karta sveta',cat:'Predmeti'},
  {w:'kljuc',h:'Otvara bravu',cat:'Predmeti'},
  {w:'brava',h:'Zakljucava vrata',cat:'Predmeti'},
  {w:'sveća',h:'Gori i svetli',cat:'Predmeti'},
];

function pickWords() {
  const byCat = {};
  WORDS.forEach(w => { if (!byCat[w.cat]) byCat[w.cat] = []; byCat[w.cat].push(w); });
  const cats = Object.keys(byCat);
  const shuffled = shuffle(cats);
  const result = [];
  for (const c of shuffled) {
    if (result.length >= 3) break;
    const arr = byCat[c];
    result.push(arr[Math.floor(Math.random() * arr.length)]);
  }
  return result;
}

server.listen(PORT, () => {
  console.log('\n T19 DRAW — Zabava za Trepcu');
  console.log(' http://localhost:' + PORT + '\n');
});
