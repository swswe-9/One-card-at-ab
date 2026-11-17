'use strict';
// 원카드 온라인 서버 — 외부 패키지 없이 Node 기본 모듈만 사용
// 실행: node server.js  (기본 포트 3000, PORT 환경변수로 변경)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const START_HAND = 7;
const ELIMINATE_AT = 20;      // 손패가 이 장수 이상이면 탈락
const TURN_MS = 45000;        // 턴 제한시간
const OFFLINE_TURN_MS = 6000; // 접속이 끊긴 플레이어의 턴 대기시간
const TOTAL_CARDS = 54;       // 52장 + 조커 2장 (덱은 1벌로 고정 → 카운팅 가능)
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const PLAIN_RANKS = ['3', '4', '5', '6', '8', '9', '10']; // 시작 카드로 허용되는 숫자 카드

const rooms = new Map();

// ───────── 카드 유틸 ─────────
// 카드 id: 무늬(S/H/D/C)+숫자  예) "SA", "H10", 조커는 "BJ"(흑백), "CJ"(컬러)
const isJoker = c => c === 'BJ' || c === 'CJ';
const suitOf = c => (isJoker(c) ? null : c[0]);
const rankOf = c => (isJoker(c) ? 'JK' : c.slice(1));

function fullDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(s + r);
  d.push('BJ', 'CJ');
  return d;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 공격 카드의 위력 (0이면 공격 카드 아님)
function attackPower(c) {
  if (c === 'CJ') return 7;
  if (c === 'BJ') return 5;
  if (c === 'SA') return 5;
  const r = rankOf(c);
  if (r === 'A') return 3;
  if (r === '2') return 2;
  return 0;
}

// ───────── 방/게임 로직 ─────────
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
}

function newPlayer(name) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name, hand: [], out: false, left: false, connected: false, conns: new Set(),
  };
}

function createRoom(name, hostNick) {
  const host = newPlayer(hostNick);
  const room = {
    code: makeCode(), name, phase: 'lobby', hostId: host.id, players: [host],
    deck: [], discard: [], dir: 1, turn: 0, topSuit: null, topRank: null,
    attack: 0, oneCard: null, winner: null, log: [],
    reshuffleSeq: 0, lastReshuffleN: 0, reshuffles: 0,
    timer: null, deadline: 0, lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return { room, host };
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
}

const activePlayers = room => room.players.filter(p => !p.out);

function setTop(room) {
  const top = room.discard[room.discard.length - 1];
  room.topSuit = suitOf(top);
  room.topRank = rankOf(top);
}

function canPlay(room, card) {
  const top = room.discard[room.discard.length - 1];
  if (room.attack > 0) {
    if (isJoker(card)) return true;            // 조커는 어떤 공격도 막을 수 있음
    if (isJoker(top)) return false;            // 조커 공격은 조커로만 막기
    if (attackPower(card) === 0) return false; // 공격 중에는 공격 카드만
    return suitOf(card) === room.topSuit || rankOf(card) === room.topRank;
  }
  if (isJoker(card)) return true;
  if (room.topSuit === null) return true;      // 조커 위에는 무엇이든
  return suitOf(card) === room.topSuit || rankOf(card) === room.topRank;
}

// 덱이 바닥나면: 맨 위 카드만 남기고 깔린 카드를 섞어 새 덱으로
function reshuffle(room) {
  if (room.discard.length <= 1) return false;
  const top = room.discard.pop();
  const under = room.discard;
  room.discard = [top];
  room.deck = shuffle(under);
  room.reshuffles++;
  room.reshuffleSeq++;
  room.lastReshuffleN = under.length;
  addLog(room, `🔄 덱 소진! 깔린 카드 ${under.length}장을 섞어 덱에 넣었습니다`);
  return true;
}

function drawFor(room, p, n) {
  let got = 0;
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) reshuffle(room);
    if (!room.deck.length) break;            // 모든 카드가 손패에 있는 극단적 경우
    p.hand.push(room.deck.pop());
    got++;
  }
  if (!room.deck.length) reshuffle(room);    // 마지막 카드를 뽑은 즉시 표시+재셔플
  return got;
}

function startGame(room) {
  for (;;) {
    room.deck = shuffle(fullDeck());
    for (const p of room.players) {
      p.out = false;
      p.hand = room.deck.splice(room.deck.length - START_HAND, START_HAND);
    }
    const idx = room.deck.findIndex(c => !isJoker(c) && PLAIN_RANKS.includes(rankOf(c)));
    if (idx < 0) continue;                   // 시작 카드가 될 숫자 카드가 없으면 다시 분배
    room.discard = [room.deck.splice(idx, 1)[0]];
    break;
  }
  room.phase = 'playing';
  room.dir = 1;
  room.attack = 0;
  room.oneCard = null;
  room.winner = null;
  room.log = [];
  room.turn = crypto.randomInt(room.players.length);
  setTop(room);
  addLog(room, '게임 시작!');
  schedule(room);
}

function advance(room, steps) {
  const n = room.players.length;
  let i = room.turn;
  let left = steps;
  while (left > 0) {
    i = (i + room.dir + n) % n;
    if (!room.players[i].out) left--;
  }
  room.turn = i;
}

function endGame(room, winner) {
  room.phase = 'ended';
  room.winner = winner ? winner.id : null;
  room.oneCard = null;
  clearTimeout(room.timer);
  addLog(room, winner ? `🏆 ${winner.name}님 승리!` : '게임 종료');
}

function checkLastStanding(room) {
  const act = activePlayers(room);
  if (act.length <= 1) { endGame(room, act[0] || null); return true; }
  return false;
}

function checkEliminate(room, p) {
  if (p.hand.length >= ELIMINATE_AT) {
    addLog(room, `💀 ${p.name}님이 카드 ${p.hand.length}장으로 탈락했습니다`);
    room.discard.unshift(...p.hand);         // 탈락자의 카드는 맨 아래로
    p.hand = [];
    p.out = true;
    if (room.oneCard && room.oneCard.id === p.id) room.oneCard = null;
  }
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.phase !== 'playing') return;
  const cur = room.players[room.turn];
  const ms = cur && cur.connected ? TURN_MS : OFFLINE_TURN_MS;
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    const p = room.players[room.turn];
    if (room.phase !== 'playing' || !p) return;
    addLog(room, `⏰ ${p.name}님 시간 초과 — 자동으로 카드를 뽑습니다`);
    doDraw(room, p);
    broadcast(room);
  }, ms);
}

function doPlay(room, p, card, chosenSuit) {
  room.oneCard = null;
  p.hand.splice(p.hand.indexOf(card), 1);
  room.discard.push(card);
  setTop(room);
  const rank = rankOf(card);
  if (rank === '7') room.topSuit = chosenSuit;

  const atk = attackPower(card);
  if (atk > 0) room.attack += atk;

  const label = isJoker(card) ? (card === 'CJ' ? '컬러 조커' : '흑백 조커') : `${cardSym(card)}`;
  let msg = `${p.name}: ${label}`;
  if (rank === '7') msg += ` (무늬 변경 → ${SUIT_SYM[chosenSuit]})`;
  if (atk > 0) msg += ` ⚔ 공격 누적 +${room.attack}`;

  if (p.hand.length === 0) {
    addLog(room, msg);
    endGame(room, p);
    return;
  }
  if (p.hand.length === 1) room.oneCard = { id: p.id, called: false };

  const active = activePlayers(room).length;
  let steps = 1;
  if (rank === 'J') { steps = 1 + Math.min(1, active - 1); msg += ' — 다음 사람 건너뛰기'; }
  else if (rank === 'K') { steps = 1 + Math.min(2, active - 1); msg += ' — 두 명 건너뛰기'; }
  else if (rank === 'Q') {
    if (active === 2) steps = 2; else room.dir *= -1;
    msg += ' — 방향 전환';
  }
  addLog(room, msg);
  advance(room, steps);
  schedule(room);
}

function doDraw(room, p) {
  room.oneCard = null;
  const n = room.attack > 0 ? room.attack : 1;
  const penalty = room.attack > 0;
  room.attack = 0;
  const got = drawFor(room, p, n);
  addLog(room, penalty ? `${p.name}: 공격 받아 ${got}장 획득` : `${p.name}: 카드 뽑기`);
  checkEliminate(room, p);
  if (checkLastStanding(room)) return;
  advance(room, 1);
  schedule(room);
}

const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const cardSym = c => (isJoker(c) ? 'JOKER' : SUIT_SYM[suitOf(c)] + rankOf(c));

// 액션 처리: 오류 메시지를 반환(성공이면 null)
function handleAction(room, p, body) {
  room.lastActive = Date.now();
  const type = body.type;

  if (type === 'leave') { leave(room, p); return null; }

  if (room.phase === 'lobby') {
    if (type === 'start') {
      if (p.id !== room.hostId) return '방장만 시작할 수 있어요';
      if (room.players.length < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요해요`;
      startGame(room);
      return null;
    }
    return '대기실에서는 할 수 없는 동작이에요';
  }

  if (room.phase === 'ended') {
    if (type === 'rematch') {
      if (p.id !== room.hostId) return '방장만 다시 시작할 수 있어요';
      room.players = room.players.filter(x => !x.left);
      for (const x of room.players) { x.hand = []; x.out = false; }
      room.phase = 'lobby';
      room.deck = []; room.discard = []; room.attack = 0; room.winner = null; room.oneCard = null;
      room.deadline = 0;
      room.log = [];
      return null;
    }
    return '게임이 끝났어요';
  }

  // playing
  if (p.out) return '탈락한 상태예요';

  if (type === 'call') {
    if (room.oneCard && room.oneCard.id === p.id && !room.oneCard.called) {
      room.oneCard.called = true;
      addLog(room, `📣 ${p.name}: 원카드!`);
    }
    return null;
  }
  if (type === 'challenge') {
    const oc = room.oneCard;
    if (!oc || oc.called || oc.id === p.id) return '신고할 대상이 없어요';
    const target = room.players.find(x => x.id === oc.id);
    room.oneCard = null;
    const got = drawFor(room, target, 2);
    addLog(room, `🚨 ${p.name}님이 ${target.name}님의 원카드 미선언을 신고! ${got}장 추가`);
    checkEliminate(room, target);
    checkLastStanding(room);
    return null;
  }

  if (room.players[room.turn] !== p) return '내 차례가 아니에요';

  if (type === 'draw') { doDraw(room, p); return null; }
  if (type === 'play') {
    const card = body.card;
    if (!p.hand.includes(card)) return '가지고 있지 않은 카드예요';
    if (!canPlay(room, card)) return '지금은 낼 수 없는 카드예요';
    let suit = body.suit;
    if (rankOf(card) === '7' && !SUITS.includes(suit)) suit = suitOf(card);
    doPlay(room, p, card, suit);
    return null;
  }
  return '알 수 없는 동작이에요';
}

function leave(room, p) {
  for (const c of p.conns) { try { c.write('event: closed\ndata: {}\n\n'); c.end(); } catch (_) {} }
  p.conns.clear();
  p.connected = false;

  if (room.phase === 'playing') {
    p.out = true; p.left = true;
    room.discard.unshift(...p.hand);
    p.hand = [];
    if (room.oneCard && room.oneCard.id === p.id) room.oneCard = null;
    addLog(room, `🚪 ${p.name}님이 나갔습니다`);
    const wasTurn = room.players[room.turn] === p;
    if (room.players.every(x => x.left)) { destroyRoom(room); return; }
    if (!checkLastStanding(room) && wasTurn) { advance(room, 1); schedule(room); }
  } else {
    room.players = room.players.filter(x => x !== p);
    if (!room.players.length) { destroyRoom(room); return; }
    addLog(room, `🚪 ${p.name}님이 나갔습니다`);
  }
  if (room.hostId === p.id) {
    const nh = room.players.find(x => !x.left);
    if (nh) room.hostId = nh.id;
  }
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

// ───────── 상태 전송 ─────────
function viewFor(room, p) {
  const cur = room.players[room.turn];
  const v = {
    code: room.code, name: room.name, phase: room.phase, hostId: room.hostId,
    you: p.id, hand: p.hand.slice(),
    players: room.players.map(q => ({
      id: q.id, name: q.name, count: q.hand.length, connected: q.connected, out: q.out,
    })),
    turnId: room.phase === 'playing' && cur ? cur.id : null,
    dir: room.dir, attack: room.attack, topSuit: room.topSuit, topRank: room.topRank,
    deckCount: room.deck.length, discard: room.discard.slice(),
    oneCard: room.oneCard, winnerId: room.winner, log: room.log.slice(-25),
    reshuffle: { seq: room.reshuffleSeq, n: room.lastReshuffleN, total: room.reshuffles },
    ttl: room.phase === 'playing' ? Math.max(0, room.deadline - Date.now()) : 0,
    eliminateAt: ELIMINATE_AT, total: TOTAL_CARDS, max: MAX_PLAYERS, min: MIN_PLAYERS,
  };
  if (v.turnId === p.id) v.playable = p.hand.filter(c => canPlay(room, c));
  return v;
}

function sendTo(p, room) {
  if (!p.conns.size) return;
  const data = `data: ${JSON.stringify(viewFor(room, p))}\n\n`;
  for (const c of p.conns) { try { c.write(data); } catch (_) {} }
}

function broadcast(room) {
  for (const p of room.players) sendTo(p, room);
}

// ───────── HTTP ─────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);

function auth(code, token) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return {};
  const p = room.players.find(x => x.token === token);
  return p ? { room, p } : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && u.pathname === '/api/rooms') {
      const list = [...rooms.values()]
        .filter(r => r.phase === 'lobby' && r.players.length < MAX_PLAYERS)
        .map(r => ({ code: r.code, name: r.name, count: r.players.length, max: MAX_PLAYERS }));
      return json(res, 200, list);
    }

    if (req.method === 'GET' && u.pathname === '/api/state') {
      const { room, p } = auth(u.searchParams.get('code'), u.searchParams.get('token'));
      if (!p) return json(res, 404, { error: '방을 찾을 수 없어요' });
      return json(res, 200, viewFor(room, p));
    }

    if (req.method === 'GET' && u.pathname === '/api/events') {
      const { room, p } = auth(u.searchParams.get('code'), u.searchParams.get('token'));
      if (!p) return json(res, 404, { error: '방을 찾을 수 없어요' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(viewFor(room, p))}\n\n`);
      p.conns.add(res);
      p.connected = true;
      broadcast(room);
      req.on('close', () => {
        p.conns.delete(res);
        if (!p.conns.size) { p.connected = false; if (rooms.has(room.code)) broadcast(room); }
      });
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (u.pathname === '/api/create') {
        const nick = cleanName(body.nick);
        if (!nick) return json(res, 400, { error: '닉네임을 입력하세요' });
        const name = cleanName(body.roomName) || `${nick}의 방`;
        const { room, host } = createRoom(name, nick);
        return json(res, 200, { code: room.code, token: host.token });
      }

      if (u.pathname === '/api/join') {
        const nick = cleanName(body.nick);
        if (!nick) return json(res, 400, { error: '닉네임을 입력하세요' });
        const room = rooms.get(String(body.code || '').toUpperCase());
        if (!room) return json(res, 400, { error: '해당 코드의 방이 없어요' });
        if (room.phase !== 'lobby') return json(res, 400, { error: '이미 게임이 진행 중이에요' });
        if (room.players.length >= MAX_PLAYERS) return json(res, 400, { error: '방이 가득 찼어요' });
        const p = newPlayer(nick);
        room.players.push(p);
        room.lastActive = Date.now();
        addLog(room, `${nick}님이 입장했습니다`);
        broadcast(room);
        return json(res, 200, { code: room.code, token: p.token });
      }

      if (u.pathname === '/api/action') {
        const { room, p } = auth(body.code, body.token);
        if (!p) return json(res, 404, { error: '방을 찾을 수 없어요' });
        const err = handleAction(room, p, body);
        if (err) return json(res, 400, { error: err });
        if (rooms.has(room.code)) broadcast(room);
        return json(res, 200, { ok: true });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    try { json(res, 400, { error: '잘못된 요청이에요' }); } catch (_) {}
  }
});

// SSE 연결 유지용 ping, 오래 방치된 방 정리
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players) for (const c of p.conns) { try { c.write(': ping\n\n'); } catch (_) {} }
  }
}, 20000);
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const online = room.players.some(p => p.connected);
    if (!online && now - room.lastActive > 30 * 60 * 1000) destroyRoom(room);
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`원카드 서버 실행 중: http://localhost:${PORT}`));
