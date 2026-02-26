/**
 * T19 DRAW — Game Server
 * Node.js + WebSocket multiplayer server
 */
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;

const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  let filePath = path.join(__dirname, 'public', url === '/' ? 'index.html' : url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(e ? 404 : 200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(e ? 'Not found' : d);
      });
      return;
    }
    res.writeHead(200, {'Content-Type': MIME[ext] || 'text/plain'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false, // Railway proxy kompatibilnost
  clientTracking: true
});
const rooms = new Map();
const clients = new Map();

function makeId() { return crypto.randomBytes(8).toString('hex'); }
function makeRoomId() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let id='';
  for(let i=0;i<6;i++) id+=c[Math.floor(Math.random()*c.length)];
  return id;
}
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
function maskWord(w){return w.split('').map(c=>c===' '?' ':'_').join('');}
function levenshtein(a,b){const dp=Array.from({length:a.length+1},(_,i)=>[i]);for(let j=0;j<=b.length;j++)dp[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);return dp[a.length][b.length];}

class Room {
  constructor(id, hostId){
    this.id=id; this.hostId=hostId; this.players=new Map();
    this.phase='lobby'; this.round=0; this.totalRounds=8; this.roundTime=90;
    this.currentDrawerId=null; this.currentWord=null; this.currentHint=null; this.currentCat=null;
    this.timer=null; this.timeLeft=0; this.guessedPlayers=new Set();
    this.drawQueue=[]; this.wordChoices=[]; this.choiceTimer=null;
    this.drawData=[]; this.chat=[]; this.maxPlayers=10; this._mask=null;
  }
  broadcast(data,excl=null){const m=JSON.stringify(data);this.players.forEach((p,pid)=>{if(pid===excl)return;if(p.ws&&p.ws.readyState===1)p.ws.send(m);});}
  send(pid,data){const p=this.players.get(pid);if(p&&p.ws&&p.ws.readyState===1)p.ws.send(JSON.stringify(data));}
  getPublicPlayers(){return [...this.players.values()].map(p=>({id:p.id,name:p.name,avatar:p.avatar,score:p.score||0,isHost:p.id===this.hostId,isDrawing:p.id===this.currentDrawerId,guessed:this.guessedPlayers.has(p.id),connected:p.connected!==false}));}
  startGame(){
    if(this.players.size<2)return false;
    this.phase='drawing'; this.round=0;
    this.drawQueue=shuffle([...this.players.keys()]);
    this.players.forEach(p=>{p.score=0;});
    this.broadcast({type:'gameStart',totalRounds:this.totalRounds,roundTime:this.roundTime});
    this.nextRound(); return true;
  }
  nextRound(){
    this.round++;
    if(this.round>this.totalRounds||this.drawQueue.length===0){this.endGame();return;}
    this.currentDrawerId=this.drawQueue.shift();
    this.guessedPlayers.clear(); this.drawData=[]; this._mask=null;
    this.wordChoices=getWordChoices(); this.phase='choosing';
    this.broadcast({type:'roundStart',round:this.round,totalRounds:this.totalRounds,drawerId:this.currentDrawerId,drawerName:this.players.get(this.currentDrawerId)?.name||'?',players:this.getPublicPlayers()});
    this.send(this.currentDrawerId,{type:'chooseWord',choices:this.wordChoices});
    let t=12;
    this.choiceTimer=setInterval(()=>{t--;this.send(this.currentDrawerId,{type:'choiceCountdown',t});
      if(t<=0){clearInterval(this.choiceTimer);const p=this.wordChoices[Math.floor(Math.random()*this.wordChoices.length)];this.wordChosen(this.currentDrawerId,p.w,p.h,p.cat);}},1000);
  }
  wordChosen(pid,word,hint,cat){
    if(pid!==this.currentDrawerId)return;
    clearInterval(this.choiceTimer);
    this.currentWord=word; this.currentHint=hint; this.currentCat=cat;
    this.phase='drawing'; this.timeLeft=this.roundTime;
    this._mask=maskWord(word).split('');
    const masked=this._mask.join('');
    this.broadcast({type:'drawingStart',drawerId:this.currentDrawerId,maskedWord:masked,wordLength:word.length,category:cat,timeLeft:this.timeLeft},this.currentDrawerId);
    this.send(this.currentDrawerId,{type:'drawingStart',drawerId:this.currentDrawerId,word:word,maskedWord:word,wordLength:word.length,category:cat,timeLeft:this.timeLeft,isDrawer:true});
    clearInterval(this.timer);
    this.timer=setInterval(()=>{
      this.timeLeft--;
      this.broadcast({type:'tick',t:this.timeLeft});
      if(this.timeLeft===Math.floor(this.roundTime*0.5))this.revealLetter();
      if(this.timeLeft===Math.floor(this.roundTime*0.25))this.revealLetter();
      if(this.timeLeft<=0){clearInterval(this.timer);this.endRound(false);}
    },1000);
  }
  revealLetter(){
    const word=this.currentWord; if(!this._mask)return;
    const hidden=[];
    this._mask.forEach((c,i)=>{if(c==='_')hidden.push(i);});
    if(!hidden.length)return;
    const idx=hidden[Math.floor(Math.random()*hidden.length)];
    this._mask[idx]=word[idx];
    this.broadcast({type:'letterReveal',mask:this._mask.join(''),idx,letter:word[idx]});
  }
  guess(pid,text){
    if(pid===this.currentDrawerId||this.guessedPlayers.has(pid)||this.phase!=='drawing')return;
    const word=this.currentWord.toLowerCase(); const guess=text.toLowerCase().trim();
    const isCorrect=guess===word;
    const isClose=!isCorrect&&(word.includes(guess)&&guess.length>=3||levenshtein(guess,word)<=1);
    const player=this.players.get(pid);
    if(isCorrect){
      this.guessedPlayers.add(pid);
      const bonus=Math.max(50,Math.round((this.timeLeft/this.roundTime)*500));
      player.score=(player.score||0)+bonus;
      const drawer=this.players.get(this.currentDrawerId);
      if(drawer)drawer.score=(drawer.score||0)+Math.round(bonus*0.3);
      this.broadcast({type:'correctGuess',playerId:pid,name:player?.name,bonus,players:this.getPublicPlayers()});
      this.send(pid,{type:'youGuessed',bonus});
      const nonDrawers=[...this.players.keys()].filter(id=>id!==this.currentDrawerId&&this.players.get(id)?.connected!==false);
      if(this.guessedPlayers.size>=nonDrawers.length){clearInterval(this.timer);setTimeout(()=>this.endRound(true),1500);}
    } else {
      const chatMsg={type:'chat',playerId:pid,name:player?.name||'?',avatar:player?.avatar||'😊',text,isClose,ts:Date.now()};
      this.broadcast(chatMsg);
      if(isClose)this.send(pid,{type:'closeGuess'});
      this.chat.push(chatMsg);
    }
  }
  endRound(allGuessed){
    clearInterval(this.timer); this.phase='roundEnd';
    this.broadcast({type:'roundEnd',word:this.currentWord,allGuessed,players:this.getPublicPlayers(),nextIn:4000});
    setTimeout(()=>this.nextRound(),4000);
  }
  endGame(){
    clearInterval(this.timer); this.phase='gameEnd';
    const sorted=[...this.players.values()].sort((a,b)=>(b.score||0)-(a.score||0));
    this.broadcast({type:'gameEnd',winner:sorted[0]?{name:sorted[0].name,score:sorted[0].score,avatar:sorted[0].avatar}:null,players:this.getPublicPlayers().sort((a,b)=>b.score-a.score)});
    this.phase='lobby'; this.round=0;
  }
  addDraw(data){this.drawData.push(data);if(this.drawData.length>8000)this.drawData.shift();}
}

wss.on('connection',(ws)=>{
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    handleMessage(ws,msg);
  });
  ws.on('close',()=>handleDisconnect(ws));
  ws.on('error',()=>handleDisconnect(ws));
});

setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive){ws.terminate();return;}ws.isAlive=false;ws.ping();});},20000);

function handleMessage(ws,msg){
  const {type}=msg;
  if(type==='createRoom'){
    const roomId=makeRoomId(); const playerId=makeId();
    const room=new Room(roomId,playerId); rooms.set(roomId,room);
    const pd={id:playerId,ws,name:msg.name||'Igrač',avatar:msg.avatar||'😊',score:0,connected:true};
    room.players.set(playerId,pd); clients.set(ws,{playerId,roomId});
    ws.send(JSON.stringify({type:'roomCreated',roomId,playerId,players:room.getPublicPlayers(),totalRounds:room.totalRounds,roundTime:room.roundTime}));
    return;
  }
  if(type==='joinRoom'){
    const room=rooms.get(msg.roomId?.toUpperCase());
    if(!room){ws.send(JSON.stringify({type:'error',msg:'Soba ne postoji. Proveri kod.'}));return;}
    if(room.phase!=='lobby'&&room.phase!=='gameEnd'){ws.send(JSON.stringify({type:'error',msg:'Igra je već u toku.'}));return;}
    const playerId=makeId(); clients.set(ws,{playerId,roomId:room.id});
    const pd={id:playerId,ws,name:msg.name||'Igrač',avatar:msg.avatar||'😊',score:0,connected:true};
    room.players.set(playerId,pd);
    room.broadcast({type:'playerJoined',player:{id:playerId,name:msg.name,avatar:msg.avatar,score:0},players:room.getPublicPlayers()});
    ws.send(JSON.stringify({type:'joinedRoom',roomId:room.id,playerId,players:room.getPublicPlayers(),phase:room.phase,round:room.round,totalRounds:room.totalRounds,roundTime:room.roundTime,drawData:room.drawData}));
    return;
  }
  const client=clients.get(ws); if(!client)return;
  const {playerId,roomId}=client; const room=rooms.get(roomId); if(!room)return;
  switch(type){
    case 'startGame':
      if(playerId!==room.hostId)return;
      if(!room.startGame())ws.send(JSON.stringify({type:'error',msg:'Potrebna su najmanje 2 igrača.'}));
      break;
    case 'updateSettings':
      if(playerId!==room.hostId)return;
      if(msg.totalRounds)room.totalRounds=Math.min(20,Math.max(3,+msg.totalRounds));
      if(msg.roundTime)room.roundTime=Math.min(180,Math.max(30,+msg.roundTime));
      room.broadcast({type:'settingsUpdated',totalRounds:room.totalRounds,roundTime:room.roundTime});
      break;
    case 'chooseWord': room.wordChosen(playerId,msg.word,msg.hint,msg.cat); break;
    case 'draw':
      if(playerId!==room.currentDrawerId)return;
      room.addDraw(msg); room.broadcast({...msg,type:'draw'},playerId); break;
    case 'clearCanvas':
      if(playerId!==room.currentDrawerId)return;
      room.drawData=[]; room.broadcast({type:'clearCanvas'},playerId); break;
    case 'undoCanvas':
      if(playerId!==room.currentDrawerId)return;
      if(room.drawData.length>0)room.drawData.pop();
      room.broadcast({type:'undoCanvas'},playerId); break;
    case 'guess': room.guess(playerId,msg.text); break;
    case 'chat':
      if(room.phase==='drawing'&&playerId!==room.currentDrawerId){room.guess(playerId,msg.text);}
      else{const p=room.players.get(playerId);const cm={type:'chat',playerId,name:p?.name||'?',avatar:p?.avatar||'😊',text:msg.text,ts:Date.now()};room.broadcast(cm);room.chat.push(cm);}
      break;
    case 'ping': ws.send(JSON.stringify({type:'pong'})); break;
    case 'playAgain': if(playerId===room.hostId&&(room.phase==='lobby'||room.phase==='gameEnd'))room.startGame(); break;
  }
}

function handleDisconnect(ws){
  const client=clients.get(ws); if(!client)return;
  const {playerId,roomId}=client; const room=rooms.get(roomId);
  if(room){const p=room.players.get(playerId);if(p)p.connected=false;room.broadcast({type:'playerDisconnected',playerId,players:room.getPublicPlayers()});}
  clients.delete(ws);
  setTimeout(()=>{const r=rooms.get(roomId);if(r&&[...r.players.values()].filter(p=>p.connected!==false).length===0)rooms.delete(roomId);},300000);
}

// ─── WORD DB ─────────────────────────────────────────────────────────────────
const WORDS={životinje:[{w:'mačka',h:'Kaže mjau',cat:'Životinje'},{w:'pas',h:'Čovekov prijatelj',cat:'Životinje'},{w:'konj',h:'Jede seno',cat:'Životinje'},{w:'krava',h:'Daje mleko',cat:'Životinje'},{w:'ovca',h:'Daje vunu',cat:'Životinje'},{w:'svinja',h:'Voli blato',cat:'Životinje'},{w:'kokoška',h:'Nosi jaja',cat:'Životinje'},{w:'patka',h:'Pliva i kvača',cat:'Životinje'},{w:'guska',h:'Bela ptica',cat:'Životinje'},{w:'zec',h:'Duge uši brz',cat:'Životinje'},{w:'vuk',h:'Vije u šumi',cat:'Životinje'},{w:'medved',h:'Voli med',cat:'Životinje'},{w:'lisica',h:'Lukava zver',cat:'Životinje'},{w:'srna',h:'Šumska lepotica',cat:'Životinje'},{w:'jelen',h:'Ima rogove',cat:'Životinje'},{w:'vepar',h:'Divlja svinja',cat:'Životinje'},{w:'jazavac',h:'Kopa rupe',cat:'Životinje'},{w:'vidra',h:'Voli vodu',cat:'Životinje'},{w:'dabar',h:'Gradi brane',cat:'Životinje'},{w:'veverica',h:'Skuplja lešnike',cat:'Životinje'},{w:'jež',h:'Bodljikav',cat:'Životinje'},{w:'miš',h:'Mali glodavac',cat:'Životinje'},{w:'lav',h:'Kralj džungle',cat:'Životinje'},{w:'tigar',h:'Prugasto mace',cat:'Životinje'},{w:'slon',h:'Dugačak nos',cat:'Životinje'},{w:'žirafa',h:'Dug vrat',cat:'Životinje'},{w:'zebra',h:'Crno-bele pruge',cat:'Životinje'},{w:'gorila',h:'Veliki majmun',cat:'Životinje'},{w:'šimpanza',h:'Pametan majmun',cat:'Životinje'},{w:'kengur',h:'Ima džepove',cat:'Životinje'},{w:'koala',h:'Voli eukaliptus',cat:'Životinje'},{w:'pingvin',h:'Ne leti',cat:'Životinje'},{w:'polarni medved',h:'Beli medved',cat:'Životinje'},{w:'delfin',h:'Pametna morska životinja',cat:'Životinje'},{w:'kit',h:'Najveći sisavac',cat:'Životinje'},{w:'morž',h:'Dugačke okljove',cat:'Životinje'},{w:'ajkula',h:'Opasna morska riba',cat:'Životinje'},{w:'hobotnica',h:'8 krakova',cat:'Životinje'},{w:'krokodil',h:'Zeleni gušter',cat:'Životinje'},{w:'kamileon',h:'Menja boju',cat:'Životinje'},{w:'zmija',h:'Nema nogu',cat:'Životinje'},{w:'žaba',h:'Skakuće i kvakuće',cat:'Životinje'},{w:'kornjača',h:'Sporo ali stalno',cat:'Životinje'},{w:'sova',h:'Noćna ptica',cat:'Životinje'},{w:'orao',h:'Leti visoko',cat:'Životinje'},{w:'papagaj',h:'Govori',cat:'Životinje'},{w:'leptir',h:'Šarena krila',cat:'Životinje'},{w:'pčela',h:'Pravi med',cat:'Životinje'},{w:'mrav',h:'Vredan insekt',cat:'Životinje'},{w:'pauk',h:'8 nogu',cat:'Životinje'},{w:'puž',h:'Nosi kućicu',cat:'Životinje'},{w:'riba',h:'Pliva u vodi',cat:'Životinje'},{w:'labud',h:'Bela ptica na jezeru',cat:'Životinje'},{w:'flamingo',h:'Roze ptica',cat:'Životinje'},{w:'pelikan',h:'Kljun-torba',cat:'Životinje'},{w:'panda',h:'Crno-beli medved',cat:'Životinje'},{w:'rakun',h:'Maska na licu',cat:'Životinje'},{w:'kamila',h:'Grba na leđima',cat:'Životinje'},{w:'lama',h:'Pljuje',cat:'Životinje'},{w:'alpaka',h:'Slatka vunena lama',cat:'Životinje'},{w:'gepard',h:'Najbrža životinja',cat:'Životinje'},{w:'leopard',h:'Tačkasta mačka',cat:'Životinje'},{w:'nosorog',h:'Rog na nosu',cat:'Životinje'},{w:'nilski konj',h:'Debeo u vodi',cat:'Životinje'},{w:'noj',h:'Velika ptica ne leti',cat:'Životinje'},{w:'tukan',h:'Dugačak šareni kljun',cat:'Životinje'},{w:'los',h:'Ogromni rogovi',cat:'Životinje'},{w:'bizon',h:'Severno-američki bivo',cat:'Životinje'},{w:'orka',h:'Kit ubica',cat:'Životinje'},{w:'skunk',h:'Loše miriše',cat:'Životinje'},{w:'aligator',h:'Američki krokodil',cat:'Životinje'},{w:'iguana',h:'Tropski gušter',cat:'Životinje'},{w:'morska zvezda',h:'Živi u moru',cat:'Životinje'},{w:'jastog',h:'Crvena morska školjka',cat:'Životinje'},{w:'čaplja',h:'Dugačak vrat u vodi',cat:'Životinje'},{w:'fazан',h:'Šarena divljač',cat:'Životinje'},{w:'šakal',h:'Srodan s vukom',cat:'Životinje'},{w:'hijana',h:'Smeje se',cat:'Životinje'},{w:'bik',h:'Muška krava',cat:'Životinje'},{w:'ovnоv',h:'Muška ovca',cat:'Životinje'},{w:'jarac',h:'Muška koza',cat:'Životinje'},{w:'koza',h:'Daje mleko blje',cat:'Životinje'},{w:'magarac',h:'Nosi teret',cat:'Životinje'},{w:'mula',h:'Konj i magarac',cat:'Životinje'},{w:'noj',h:'Trči brzo',cat:'Životinje'},{w:'kaзuar',h:'Opasna ptica',cat:'Životinje'},{w:'kivi ptica',h:'Bez krila',cat:'Životinje'}],hrana:[{w:'pica',h:'Talijanska hrana',cat:'Hrana'},{w:'hamburger',h:'Američki fast food',cat:'Hrana'},{w:'supa',h:'Toplo jelo',cat:'Hrana'},{w:'čorba',h:'Naše toplo jelo',cat:'Hrana'},{w:'ćevapi',h:'Balkanski specijalitet',cat:'Hrana'},{w:'burek',h:'Sa sirom ili mesom',cat:'Hrana'},{w:'gibanica',h:'Naša pita',cat:'Hrana'},{w:'sarma',h:'Kiseli kupus',cat:'Hrana'},{w:'musaka',h:'Sa krompirima',cat:'Hrana'},{w:'pasulj',h:'Bob u čorbi',cat:'Hrana'},{w:'prebranac',h:'Pečeni pasulj',cat:'Hrana'},{w:'hleb',h:'Osnovna hrana',cat:'Hrana'},{w:'kifla',h:'Pecivo',cat:'Hrana'},{w:'kroasan',h:'Francuski pecivo',cat:'Hrana'},{w:'torta',h:'Za rodendane',cat:'Hrana'},{w:'sladoled',h:'Hladno i slatko',cat:'Hrana'},{w:'čokolada',h:'Kakaova slatkica',cat:'Hrana'},{w:'jabuka',h:'Crveno voće',cat:'Hrana'},{w:'banana',h:'Žuto voće',cat:'Hrana'},{w:'grožđe',h:'Za vino',cat:'Hrana'},{w:'lubenica',h:'Letnje voće',cat:'Hrana'},{w:'jagoda',h:'Crvena sitna',cat:'Hrana'},{w:'malina',h:'Šumska jagoda',cat:'Hrana'},{w:'paradajz',h:'Crveno povrće',cat:'Hrana'},{w:'krastavac',h:'Zeleno povrće',cat:'Hrana'},{w:'paprika',h:'Crvena ili zelena',cat:'Hrana'},{w:'luk',h:'Čini te plakati',cat:'Hrana'},{w:'beli luk',h:'Vampiri ga mrze',cat:'Hrana'},{w:'krompir',h:'Pečen ili kuvan',cat:'Hrana'},{w:'šargarepa',h:'Narančasto povrće',cat:'Hrana'},{w:'brokoli',h:'Zeleno drvo na tanjiru',cat:'Hrana'},{w:'palačinka',h:'Sa džemom',cat:'Hrana'},{w:'jaje',h:'Koke ga nose',cat:'Hrana'},{w:'sir',h:'Od mleka',cat:'Hrana'},{w:'jogurt',h:'Kiselo mleko',cat:'Hrana'},{w:'mleko',h:'Bela tečnost',cat:'Hrana'},{w:'med',h:'Pčele ga prave',cat:'Hrana'},{w:'kafa',h:'Jutarnji napitak',cat:'Hrana'},{w:'čaj',h:'Sa limunom',cat:'Hrana'},{w:'limun',h:'Kiselo žuto voće',cat:'Hrana'},{w:'narandža',h:'Narančasto voće',cat:'Hrana'},{w:'avokado',h:'Zeleni kremasti plod',cat:'Hrana'},{w:'mango',h:'Tropski slatki plod',cat:'Hrana'},{w:'ananas',h:'Tropski bodljikavi plod',cat:'Hrana'},{w:'sushi',h:'Japanski sa pirinčem',cat:'Hrana'},{w:'takos',h:'Meksičko jelo',cat:'Hrana'},{w:'čips',h:'Iz kese slano',cat:'Hrana'},{w:'kokice',h:'Iz bioskopa',cat:'Hrana'},{w:'krofna',h:'Okrugla masna',cat:'Hrana'},{w:'vafli',h:'Sa četvorinama',cat:'Hrana'},{w:'kobasica',h:'U crevu',cat:'Hrana'},{w:'pečenica',h:'Pečeno meso',cat:'Hrana'},{w:'roštilj',h:'Na vatri',cat:'Hrana'},{w:'ražnjić',h:'Meso na štapiću',cat:'Hrana'},{w:'pljeskavica',h:'Srpski hamburger',cat:'Hrana'},{w:'punjene paprike',h:'Sa mlevenim mesom',cat:'Hrana'},{w:'knedle',h:'Sa šljivom',cat:'Hrana'},{w:'štrudla',h:'Sa jabukama',cat:'Hrana'},{w:'baklava',h:'Sa orasima i medom',cat:'Hrana'},{w:'tulumba',h:'Pržena slatka',cat:'Hrana'},{w:'halva',h:'Slatka od susama',cat:'Hrana'},{w:'lokum',h:'Turski med',cat:'Hrana'},{w:'džem',h:'Voćni namaz',cat:'Hrana'},{w:'pekmez',h:'Šljiva kuvana',cat:'Hrana'},{w:'ramen',h:'Japanska supa',cat:'Hrana'},{w:'nar',h:'Crveni plod sa semenima',cat:'Hrana'},{w:'smokva',h:'Slatka i mekana',cat:'Hrana'},{w:'kivi',h:'Zelen iznutra',cat:'Hrana'},{w:'kokos',h:'Tropski orah',cat:'Hrana'},{w:'šipak',h:'Divlji plod',cat:'Hrana'},{w:'kaša',h:'Meka topla hrana',cat:'Hrana'},{w:'palenta',h:'Od kukuruznog brašna',cat:'Hrana'},{w:'karađorđeva',h:'Punjeni pohovanac',cat:'Hrana'},{w:'lepinja',h:'Hleb za ćevape',cat:'Hrana'},{w:'ajvar',h:'Srpski namaz od paprike',cat:'Hrana'},{w:'kiseli kupus',h:'Fermentovani kupus',cat:'Hrana'},{w:'sudzuk',h:'Tvrda začinjena kobasica',cat:'Hrana'},{w:'kajmak',h:'Srpska kremasta pavlaka',cat:'Hrana'},{w:'šopska salata',h:'Sa sirom i povrćem',cat:'Hrana'},{w:'proja',h:'Kukuruzni hleb',cat:'Hrana'},{w:'zeljanica',h:'Pita sa zeljem',cat:'Hrana'},{w:'krempita',h:'Sa kremom i korama',cat:'Hrana'},{w:'rozen sladoled',h:'Na štapiću',cat:'Hrana'}],sport:[{w:'fudbal',h:'11 igrača gol',cat:'Sport'},{w:'košarka',h:'Koš i lopta',cat:'Sport'},{w:'tenis',h:'Reket i loptica',cat:'Sport'},{w:'odbojka',h:'Mreža i šest igrača',cat:'Sport'},{w:'rukomet',h:'Baca se rukom',cat:'Sport'},{w:'vaterpolo',h:'U vodi',cat:'Sport'},{w:'plivanje',h:'U bazenu',cat:'Sport'},{w:'atletika',h:'Trčanje i skakanje',cat:'Sport'},{w:'gimnastika',h:'Okretnost',cat:'Sport'},{w:'boks',h:'Sa rukavicama',cat:'Sport'},{w:'rvanje',h:'Na strunjači',cat:'Sport'},{w:'džudo',h:'Japanska borba',cat:'Sport'},{w:'karate',h:'Hija!',cat:'Sport'},{w:'taekwondo',h:'Korejska borba',cat:'Sport'},{w:'mačevanje',h:'Sa mačem',cat:'Sport'},{w:'streljaštvo',h:'Gađanje metom',cat:'Sport'},{w:'biciklizam',h:'Na dva točka',cat:'Sport'},{w:'alpsko skijanje',h:'Spuštanje sa planine',cat:'Sport'},{w:'klizanje',h:'Na ledu',cat:'Sport'},{w:'hokej',h:'Na ledu sa palicom',cat:'Sport'},{w:'golf',h:'Mala lopta rupa',cat:'Sport'},{w:'ragbi',h:'Ovalna lopta',cat:'Sport'},{w:'američki fudbal',h:'Kacige i lopta',cat:'Sport'},{w:'bejzbol',h:'Palica i lopta',cat:'Sport'},{w:'snoubording',h:'Na dasci po snegu',cat:'Sport'},{w:'surfovanje',h:'Na talasima',cat:'Sport'},{w:'jedrenje',h:'Sa jedrom',cat:'Sport'},{w:'kajak',h:'Čun sa veslom',cat:'Sport'},{w:'penjanje',h:'Na stenu',cat:'Sport'},{w:'padobranstvo',h:'Sa aviona',cat:'Sport'},{w:'paraglajding',h:'Sa krilima',cat:'Sport'},{w:'darts',h:'Gađanje strelicama',cat:'Sport'},{w:'bilijar',h:'Zeleni sto',cat:'Sport'},{w:'stoni tenis',h:'Mali reket',cat:'Sport'},{w:'badminton',h:'Sa perušaricom',cat:'Sport'},{w:'kriket',h:'Engleski sport',cat:'Sport'},{w:'polo',h:'Na konjima sa maljem',cat:'Sport'},{w:'sumo',h:'Japonsko rvanje',cat:'Sport'},{w:'aikido',h:'Japanska veština',cat:'Sport'},{w:'kickboxing',h:'Boks sa nogama',cat:'Sport'},{w:'triatlon',h:'Tri sporta u jednom',cat:'Sport'},{w:'maraton',h:'42 km trčanje',cat:'Sport'},{w:'sprint',h:'Brzo kratko trčanje',cat:'Sport'},{w:'skok uvis',h:'Prelaz letve',cat:'Sport'},{w:'skok u dalj',h:'Što dalje',cat:'Sport'},{w:'bacanje koplja',h:'Dugački štap',cat:'Sport'},{w:'bacanje diska',h:'Okrugla ploča',cat:'Sport'},{w:'bacanje kugle',h:'Teška lopta',cat:'Sport'},{w:'formula 1',h:'Brzi automobili',cat:'Sport'},{w:'motociklizam',h:'Trke motora',cat:'Sport'},{w:'reli',h:'Auto trke na putu',cat:'Sport'},{w:'ronjenje',h:'Pod vodom',cat:'Sport'},{w:'veslanje',h:'U čunu',cat:'Sport'},{w:'streličarstvo',h:'Luk i strelica',cat:'Sport'},{w:'šah',h:'Figura i tabla',cat:'Sport'},{w:'boćanje',h:'Bacanje lopti',cat:'Sport'},{w:'pikado',h:'Gađanje table',cat:'Sport'},{w:'kuglanje',h:'Ruši čunjeve',cat:'Sport'},{w:'skateboarding',h:'Daska sa točkovima trikovi',cat:'Sport'},{w:'bmx',h:'Akrobatski biciklizam',cat:'Sport'},{w:'trčanje prepreka',h:'Preskakanje prepreka',cat:'Sport'},{w:'krosfIt',h:'Intenzivni trening',cat:'Sport'},{w:'yoga',h:'Stretching i meditacija',cat:'Sport'},{w:'pilates',h:'Vežbe jezgra',cat:'Sport'},{w:'aerobik',h:'Ples i vežbe',cat:'Sport'},{w:'squash',h:'Reket u zatvorenoj prostoriji',cat:'Sport'},{w:'padel',h:'Tenis sa zidovima',cat:'Sport'}],priroda:[{w:'planina',h:'Visoka i visoka',cat:'Priroda'},{w:'reka',h:'Teče prema moru',cat:'Priroda'},{w:'jezero',h:'Mirna voda',cat:'Priroda'},{w:'more',h:'Slana voda',cat:'Priroda'},{w:'okean',h:'Ogromna slana voda',cat:'Priroda'},{w:'šuma',h:'Mnogo drveća',cat:'Priroda'},{w:'livada',h:'Zelena trava',cat:'Priroda'},{w:'polje',h:'Ravnica',cat:'Priroda'},{w:'pustinja',h:'Suva i vruća',cat:'Priroda'},{w:'džungla',h:'Tropska šuma',cat:'Priroda'},{w:'vulkan',h:'Izbacuje lavu',cat:'Priroda'},{w:'klisura',h:'Duboka dolina',cat:'Priroda'},{w:'pećina',h:'Rupa u planini',cat:'Priroda'},{w:'slapovi',h:'Voda pada',cat:'Priroda'},{w:'duga',h:'Posle kiše šarena',cat:'Priroda'},{w:'aurora borealis',h:'Severna svetlost',cat:'Priroda'},{w:'sneg',h:'Beli i hladan',cat:'Priroda'},{w:'led',h:'Zamrznuta voda',cat:'Priroda'},{w:'grmljavina',h:'Munja i grom',cat:'Priroda'},{w:'tornado',h:'Vrteći vihor',cat:'Priroda'},{w:'cunami',h:'Džinovski talas',cat:'Priroda'},{w:'potres',h:'Tresa se zemlja',cat:'Priroda'},{w:'drvo',h:'Sa granama i listovima',cat:'Priroda'},{w:'cvet',h:'Lepo miriše',cat:'Priroda'},{w:'trava',h:'Zelena podloga',cat:'Priroda'},{w:'sunce',h:'Zvezda dnevne svetlosti',cat:'Priroda'},{w:'mesec',h:'Noćno svetlo',cat:'Priroda'},{w:'zvezda',h:'Svetli na nebu',cat:'Priroda'},{w:'oblaci',h:'Beli na nebu',cat:'Priroda'},{w:'kiša',h:'Pada s neba',cat:'Priroda'},{w:'breg',h:'Mala planina',cat:'Priroda'},{w:'dolina',h:'Između planina',cat:'Priroda'},{w:'ostrvo',h:'Kopno usred mora',cat:'Priroda'},{w:'zaliv',h:'More ulazi u kopno',cat:'Priroda'},{w:'delta',h:'Ušće reke',cat:'Priroda'},{w:'močvara',h:'Blatna nizija',cat:'Priroda'},{w:'ledenjak',h:'Velika masa leda',cat:'Priroda'},{w:'suša',h:'Nema kiše dugo',cat:'Priroda'},{w:'poplava',h:'Previše vode',cat:'Priroda'},{w:'oluja',h:'Jak vetar i kiša',cat:'Priroda'},{w:'vetar',h:'Vazduh koji se kreće',cat:'Priroda'},{w:'magla',h:'Ne vidi se daleko',cat:'Priroda'},{w:'rosa',h:'Jutarnje kapi na travi',cat:'Priroda'},{w:'mraz',h:'Bela tanka korica',cat:'Priroda'},{w:'tuča',h:'Kamen pada s neba',cat:'Priroda'},{w:'kaktus',h:'Bodljikava biljka',cat:'Priroda'},{w:'palma',h:'Tropsko drvo',cat:'Priroda'},{w:'bambus',h:'Kineska biljka',cat:'Priroda'},{w:'gljiva',h:'Raste na drveću',cat:'Priroda'},{w:'pečurka',h:'Jesenja gljiva',cat:'Priroda'},{w:'mahovina',h:'Zelena na kamenu',cat:'Priroda'},{w:'paprat',h:'Šumska zelena biljka',cat:'Priroda'},{w:'trska',h:'Raste uz vodu',cat:'Priroda'},{w:'ruža',h:'Crveni cvet sa trnjem',cat:'Priroda'},{w:'lala',h:'Prolećni cvet',cat:'Priroda'},{w:'suncokret',h:'Raste visoko žuti',cat:'Priroda'},{w:'lavanda',h:'Ljubičasta biljka',cat:'Priroda'},{w:'bagrem',h:'Beli mirisni cvet',cat:'Priroda'},{w:'hrast',h:'Stari jaki drvo',cat:'Priroda'},{w:'bor',h:'Zimzeleno drvo',cat:'Priroda'},{w:'jela',h:'Jelka',cat:'Priroda'},{w:'topola',h:'Visoko vitko drvo',cat:'Priroda'},{w:'vrba',h:'Plačna vrba kraj vode',cat:'Priroda'},{w:'kesten',h:'Jesen bode',cat:'Priroda'},{w:'orah',h:'Tvrdi omotač',cat:'Priroda'},{w:'lešnik',h:'Mali okrugli orah',cat:'Priroda'},{w:'zemljorad',h:'Obrađivanje zemlje',cat:'Priroda'}],profesije:[{w:'lekar',h:'Leči bolesne',cat:'Profesije'},{w:'hirurg',h:'Operacije',cat:'Profesije'},{w:'zubar',h:'Brine o zubima',cat:'Profesije'},{w:'vatrogasac',h:'Gasi požare',cat:'Profesije'},{w:'policajac',h:'Čuva red',cat:'Profesije'},{w:'vojnik',h:'Brani zemlju',cat:'Profesije'},{w:'pilot',h:'Vodi avion',cat:'Profesije'},{w:'mornar',h:'Na brodu',cat:'Profesije'},{w:'kapetan',h:'Vodi brod ili avion',cat:'Profesije'},{w:'profesor',h:'Predaje u školi',cat:'Profesije'},{w:'učitelj',h:'Osnovna škola',cat:'Profesije'},{w:'advokat',h:'Brani na sudu',cat:'Profesije'},{w:'sudija',h:'Sudi',cat:'Profesije'},{w:'arhitekta',h:'Projektuje zgrade',cat:'Profesije'},{w:'inženjer',h:'Gradi i projektuje',cat:'Profesije'},{w:'programer',h:'Piše kod',cat:'Profesije'},{w:'naučnik',h:'Istražuje',cat:'Profesije'},{w:'astronaut',h:'Ide u svemir',cat:'Profesije'},{w:'kuvar',h:'Sprema hranu',cat:'Profesije'},{w:'konobar',h:'Poslužuje hranu',cat:'Profesije'},{w:'frizer',h:'Šiša kosu',cat:'Profesije'},{w:'tesar',h:'Radi s drvetom',cat:'Profesije'},{w:'zidar',h:'Gradi zidove',cat:'Profesije'},{w:'mehaničar',h:'Popravlja auta',cat:'Profesije'},{w:'taksista',h:'Vozi ljude',cat:'Profesije'},{w:'farmer',h:'Uzgaja hranu',cat:'Profesije'},{w:'ribar',h:'Peca ribu',cat:'Profesije'},{w:'lovac',h:'Ide u lov',cat:'Profesije'},{w:'slikar',h:'Slika slike',cat:'Profesije'},{w:'vajar',h:'Pravi skulpture',cat:'Profesije'},{w:'muzičar',h:'Svira',cat:'Profesije'},{w:'pevač',h:'Peva pesme',cat:'Profesije'},{w:'glumac',h:'Igra u filmovima',cat:'Profesije'},{w:'novinar',h:'Piše vesti',cat:'Profesije'},{w:'fotograf',h:'Pravi fotografije',cat:'Profesije'},{w:'bibliotekar',h:'Čuva knjige',cat:'Profesije'},{w:'farmaceut',h:'Daje lekove',cat:'Profesije'},{w:'veterinar',h:'Lekar za životinje',cat:'Profesije'},{w:'psiholog',h:'Leči um',cat:'Profesije'},{w:'fizioterapeut',h:'Leči pokretom',cat:'Profesije'},{w:'ekonomista',h:'Bavi se finansijama',cat:'Profesije'},{w:'računovođa',h:'Broji novac',cat:'Profesije'},{w:'dizajner',h:'Stvara vizuelno',cat:'Profesije'},{w:'grafičar',h:'Dizajn na računaru',cat:'Profesije'},{w:'pisac',h:'Piše knjige',cat:'Profesije'},{w:'pesnik',h:'Piše stihove',cat:'Profesije'},{w:'prevodilac',h:'Prevodi jezike',cat:'Profesije'},{w:'diplomat',h:'Pregovara za državu',cat:'Profesije'},{w:'politicar',h:'Bavi se politikom',cat:'Profesije'},{w:'gradonačelnik',h:'Vodi grad',cat:'Profesije'},{w:'predsednik',h:'Vodi državu',cat:'Profesije'},{w:'ministar',h:'Vodi ministarstvo',cat:'Profesije'},{w:'direktor',h:'Vodi firmu',cat:'Profesije'},{w:'menadžer',h:'Organizuje tim',cat:'Profesije'},{w:'sekretar',h:'Organizuje kancelariju',cat:'Profesije'},{w:'recepcioner',h:'Dočekuje goste',cat:'Profesije'},{w:'taksidermist',h:'Preparira životinje',cat:'Profesije'},{w:'geolog',h:'Proučava stene',cat:'Profesije'},{w:'meteorolog',h:'Predviđa vreme',cat:'Profesije'},{w:'arheolog',h:'Iskopava starine',cat:'Profesije'},{w:'biolog',h:'Proučava živi svet',cat:'Profesije'},{w:'hemičar',h:'Radi sa hemijom',cat:'Profesije'},{w:'fizičar',h:'Proučava fiziku',cat:'Profesije'},{w:'matematičar',h:'Rešava jednadžbe',cat:'Profesije'},{w:'astronomer',h:'Posmatra zvezde',cat:'Profesije'},{w:'ronilac',h:'Roni pod vodom',cat:'Profesije'},{w:'spasilac',h:'Spašava ljude',cat:'Profesije'}],prevoz:[{w:'auto',h:'Četiri točka motor',cat:'Prevoz'},{w:'motocikl',h:'Dva točka brz',cat:'Prevoz'},{w:'bicikl',h:'Pedalira',cat:'Prevoz'},{w:'autobus',h:'Mnogo putnika',cat:'Prevoz'},{w:'trolejbus',h:'El autobus bez šina',cat:'Prevoz'},{w:'tramvaj',h:'Na šinama u gradu',cat:'Prevoz'},{w:'metro',h:'Podzemna vožnja',cat:'Prevoz'},{w:'voz',h:'Na šinama',cat:'Prevoz'},{w:'brod',h:'Na vodi',cat:'Prevoz'},{w:'jahta',h:'Luksuzni brod',cat:'Prevoz'},{w:'kajak',h:'Sportski čun',cat:'Prevoz'},{w:'avion',h:'Leti na nebu',cat:'Prevoz'},{w:'helikopter',h:'Vertikalno uzlijeće',cat:'Prevoz'},{w:'jedrilica',h:'Avion bez motora',cat:'Prevoz'},{w:'raketa',h:'Ide u svemir',cat:'Prevoz'},{w:'svemirski brod',h:'U kosmosu',cat:'Prevoz'},{w:'kamion',h:'Prevozi teret',cat:'Prevoz'},{w:'traktor',h:'Na farmi',cat:'Prevoz'},{w:'buldožer',h:'Gura zemlju',cat:'Prevoz'},{w:'kran',h:'Podiže terete',cat:'Prevoz'},{w:'vatrogasno vozilo',h:'Crveni kamion',cat:'Prevoz'},{w:'hitna pomoć',h:'Bela sa sirenom',cat:'Prevoz'},{w:'policijski auto',h:'Plavi sa sirenom',cat:'Prevoz'},{w:'taksi',h:'Žuti auto za prevoz',cat:'Prevoz'},{w:'limuzina',h:'Dugačak auto',cat:'Prevoz'},{w:'scooter',h:'Mali motocikl',cat:'Prevoz'},{w:'skejtbord',h:'Daska sa točkovima',cat:'Prevoz'},{w:'trotinet',h:'Stoji i vozi',cat:'Prevoz'},{w:'gondola',h:'Venecijanski čamac',cat:'Prevoz'},{w:'žičara',h:'Ide po kablu',cat:'Prevoz'},{w:'kombajn',h:'Bere žito',cat:'Prevoz'},{w:'tenk',h:'Vojno vozilo',cat:'Prevoz'},{w:'džip',h:'Terenska vozilo',cat:'Prevoz'},{w:'pickup',h:'Kamionet',cat:'Prevoz'},{w:'karavan',h:'Dom na točkovima',cat:'Prevoz'},{w:'tanker',h:'Brod za naftu',cat:'Prevoz'},{w:'podmornica',h:'Plovi pod vodom',cat:'Prevoz'},{w:'nosač aviona',h:'Ogromni ratni brod',cat:'Prevoz'},{w:'parobrod',h:'Na paru',cat:'Prevoz'},{w:'fijaker',h:'Kola sa konjem',cat:'Prevoz'},{w:'električni auto',h:'Bez benzina',cat:'Prevoz'},{w:'ATV',h:'Četvorotočkaš',cat:'Prevoz'},{w:'kanue',h:'Mali sportski čamac',cat:'Prevoz'},{w:'catamaran',h:'Dvotruplni brod',cat:'Prevoz'},{w:'motorna jedrilica',h:'Jedri i ima motor',cat:'Prevoz'},{w:'balon',h:'Leti sa gasom',cat:'Prevoz'},{w:'zepelin',h:'Ogromni cigar u vazduhu',cat:'Prevoz'},{w:'monorail',h:'Voz na jednoj šini',cat:'Prevoz'},{w:'magnetni voz',h:'Lebdi na magnetu',cat:'Prevoz'},{w:'hovercraft',h:'Lebdi nad vodom',cat:'Prevoz'},{w:'snowmobile',h:'Prevoz po snegu',cat:'Prevoz'},{w:'quad',h:'4-točkaš bez kabine',cat:'Prevoz'},{w:'parna lokomotiva',h:'Stara lokomotiva',cat:'Prevoz'}],predmeti:[{w:'stolica',h:'Sedimo',cat:'Predmeti'},{w:'sto',h:'Stavljamo stvari',cat:'Predmeti'},{w:'krevet',h:'Spavamo',cat:'Predmeti'},{w:'orman',h:'Čuvamo odeću',cat:'Predmeti'},{w:'lampa',h:'Daje svetlost',cat:'Predmeti'},{w:'televizor',h:'Gledamo filmove',cat:'Predmeti'},{w:'telefon',h:'Zovemo ljude',cat:'Predmeti'},{w:'kompjuter',h:'Za rad i igru',cat:'Predmeti'},{w:'tastatura',h:'Tipkamo',cat:'Predmeti'},{w:'kamera',h:'Snima slike',cat:'Predmeti'},{w:'slušalice',h:'Za muziku',cat:'Predmeti'},{w:'zvučnik',h:'Reprodukuje zvuk',cat:'Predmeti'},{w:'mikrofon',h:'Snima glas',cat:'Predmeti'},{w:'gitara',h:'6 žica',cat:'Predmeti'},{w:'klavir',h:'Belo-crne dirke',cat:'Predmeti'},{w:'violina',h:'Gudalo i žice',cat:'Predmeti'},{w:'bubnjevi',h:'Udaraljke',cat:'Predmeti'},{w:'knjiga',h:'Čitamo',cat:'Predmeti'},{w:'olovka',h:'Pišemo i crtamo',cat:'Predmeti'},{w:'makaze',h:'Sečemo',cat:'Predmeti'},{w:'lenjir',h:'Merimo dužinu',cat:'Predmeti'},{w:'sat',h:'Meri vreme',cat:'Predmeti'},{w:'naočare',h:'Za oči',cat:'Predmeti'},{w:'šešir',h:'Na glavi',cat:'Predmeti'},{w:'kapa',h:'Zimska za glavu',cat:'Predmeti'},{w:'šal',h:'Oko vrata',cat:'Predmeti'},{w:'cipele',h:'Na nogama',cat:'Predmeti'},{w:'torba',h:'Nosimo stvari',cat:'Predmeti'},{w:'ruksak',h:'Na leđima',cat:'Predmeti'},{w:'novčanik',h:'Za novac',cat:'Predmeti'},{w:'ključevi',h:'Otvaraju brave',cat:'Predmeti'},{w:'ogledalo',h:'Vidimo sebe',cat:'Predmeti'},{w:'četkica za zube',h:'Četkamo zube',cat:'Predmeti'},{w:'sapun',h:'Za pranje',cat:'Predmeti'},{w:'peškir',h:'Brišemo se',cat:'Predmeti'},{w:'lonac',h:'Kuvamo',cat:'Predmeti'},{w:'tiganj',h:'Pržimo',cat:'Predmeti'},{w:'nož',h:'Sečemo hranu',cat:'Predmeti'},{w:'viljuška',h:'Jedemo',cat:'Predmeti'},{w:'kašika',h:'Za supu',cat:'Predmeti'},{w:'čaša',h:'Za piće',cat:'Predmeti'},{w:'tanjir',h:'Za hranu',cat:'Predmeti'},{w:'frižider',h:'Hladi hranu',cat:'Predmeti'},{w:'šporet',h:'Kuvamo na njemu',cat:'Predmeti'},{w:'veš mašina',h:'Pere veš',cat:'Predmeti'},{w:'usisivač',h:'Usisava prašinu',cat:'Predmeti'},{w:'metla',h:'Metemo pod',cat:'Predmeti'},{w:'lopta',h:'Okrugla za igru',cat:'Predmeti'},{w:'kockice',h:'Igramo se',cat:'Predmeti'},{w:'karte',h:'Za igru',cat:'Predmeti'},{w:'sveska',h:'Pišemo u nju',cat:'Predmeti'},{w:'flomaster',h:'Boja piše',cat:'Predmeti'},{w:'kupa',h:'Za trofej',cat:'Predmeti'},{w:'medalja',h:'Za pobednike',cat:'Predmeti'},{w:'prsten',h:'Na prstu',cat:'Predmeti'},{w:'ogrlica',h:'Oko vrata',cat:'Predmeti'},{w:'narukvica',h:'Na ruci',cat:'Predmeti'},{w:'kišobran',h:'Za kišu',cat:'Predmeti'},{w:'termos',h:'Drži toplotu',cat:'Predmeti'},{w:'boca',h:'Plastična',cat:'Predmeti'},{w:'kovčeg',h:'Za putovanje',cat:'Predmeti'},{w:'papuče',h:'Kućne cipele',cat:'Predmeti'},{w:'čizme',h:'Visoke cipele',cat:'Predmeti'},{w:'tenisice',h:'Sportske cipele',cat:'Predmeti'},{w:'jakna',h:'Kaput',cat:'Predmeti'},{w:'majica',h:'Osnovna gornja',cat:'Predmeti'},{w:'farmerke',h:'Traper pantalone',cat:'Predmeti'},{w:'džemper',h:'Topla gornja odeca',cat:'Predmeti'},{w:'šorts',h:'Kratke hlače',cat:'Predmeti'},{w:'suknja',h:'Za žene',cat:'Predmeti'},{w:'kravata',h:'Oko vrata za svečanost',cat:'Predmeti'},{w:'leptir mašna',h:'Sveč mala mašna',cat:'Predmeti'},{w:'remen',h:'Drži pantalone',cat:'Predmeti'},{w:'baterija',h:'Daje struju',cat:'Predmeti'},{w:'punjač',h:'Za telefon',cat:'Predmeti'},{w:'tablet',h:'Veliki ekran bez tastature',cat:'Predmeti'},{w:'smart sat',h:'Sat sa aplikacijama',cat:'Predmeti'},{w:'dron',h:'Leti daljinskom upravom',cat:'Predmeti'},{w:'teleskop',h:'Gleda daleke zvezde',cat:'Predmeti'},{w:'mikroskop',h:'Uveličava sitne stvari',cat:'Predmeti'},{w:'kompas',h:'Pokazuje sever',cat:'Predmeti'},{w:'barometar',h:'Meri pritisak vazduha',cat:'Predmeti'},{w:'termometar',h:'Meri temperaturu',cat:'Predmeti'},{w:'šivaća mašina',h:'Šije tkaninu',cat:'Predmeti'}]};

function getWordChoices(){const all=Object.values(WORDS).flat();const shuf=shuffle([...all]);const seen=new Set();const res=[];for(const w of shuf){if(!seen.has(w.cat)&&res.length<3){seen.add(w.cat);res.push(w);}if(res.length===3)break;}return res.length===3?res:shuf.slice(0,3);}

server.listen(PORT,()=>{console.log(`\n🎨 T19 DRAW Server on port ${PORT}\n   http://localhost:${PORT}\n`);});
