const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 6;

const PACT_COLORS = [
  '#00f2fe', // Кибер-бирюзовый
  '#ff0844', // Неоновый алый
  '#b224ef', // Пурпурный
  '#facc15', // Электрический золотой
  '#10b981', // Изумрудный
  '#f97316'  // Огненный оранжевый
];

const MISSIONS = [
  {
    id: 'arms_dealer',
    title: '💰 Оружейный барон',
    desc: 'За всю партию суммарно должно быть запущено минимум 3 ракеты (кем угодно), а твоя страна должна выжить.'
  },
  {
    id: 'pacifist',
    title: '🕊 Пацифист',
    desc: 'Игра должна закончиться Гегемонией (любого игрока), и ты ни разу за всю игру не должен строить ракеты.'
  },
  {
    id: 'martyr',
    title: '💀 Мученик',
    desc: 'Твоя страна должна стать ПЕРВОЙ уничтоженной державой в этой партии.'
  },
  {
    id: 'nihilist',
    title: '☢️ Нигилист',
    desc: 'Доведи мир до Ядерной зимы (запуск 4 или более ракет одновременно за ОДИН раунд).'
  },
  {
    id: 'puppeteer',
    title: '🎭 Теневой кукловод',
    desc: 'Игра должна закончиться Коллапсом (в живых ≤ 2 стран), и твоя страна должна быть среди выживших.'
  },
  {
    id: 'iron_dome',
    title: '🛡 Железный купол',
    desc: 'Успешно отрази хотя бы 1 ракетный удар своим Щитом в течение партии.'
  },
  {
    id: 'diplomat',
    title: '🤝 Великий дипломат',
    desc: 'Успешно заключи минимум 2 обоюдных Пакта за партию и останься в живых к концу игры.'
  },
  {
    id: 'inquisitor',
    title: '🚫 Инквизитор',
    desc: 'Успешно наложи Санкции на других игроков минимум 2 раза за партию.'
  },
  {
    id: 'executioner',
    title: '🎯 Палач',
    desc: 'Лично уничтожь ракетой хотя бы одну чужую страну.'
  },
  {
    id: 'bunker',
    title: '🏰 Бункер',
    desc: 'Выживи до конца игры, ни разу не заключив ни одного Пакта.'
  },
  {
    id: 'nuclear_baron',
    title: '🚀 Ядерный магнат',
    desc: 'Тайно накопи максимальный арсенал (3 ракеты одновременно) в любой момент игры и выживи до финала.'
  },
  {
    id: 'agent_of_influence',
    title: '📈 Агент влияния',
    desc: 'Набери минимум 6 очков Влияния к концу партии (даже если победит кто-то другой) и останься в живых.'
  }
];

let players = {};
let missionDeck = [];
let totalLaunches = 0;
let lastTurnLaunches = 0;
let pactColorIndex = 0;
let turnNumber = 1;
let firstDeadId = null;
let gameOverData = null;
let roomLocked = false;
let turnMessages = [];
let logs = ['🌍 Сервер запущен. Ожидание минимум 6 держав для старта саммита...'];

function drawMission() {
  if (missionDeck.length === 0) {
    missionDeck = [...MISSIONS].sort(() => Math.random() - 0.5);
  }
  return missionDeck.pop();
}

function getPlayerBySocket(socketId) {
  return Object.values(players).find(p => p.socketId === socketId);
}

function ensureAdminExists() {
  const pList = Object.values(players);
  if (pList.length === 0) return;
  if (!pList.some(p => p.isAdmin)) {
    const firstOnline = pList.find(p => p.online) || pList[0];
    firstOnline.isAdmin = true;
  }
}

// Формируем состояние: чужие ракеты скрыты! Каждый видит точное число ракет только у себя.
function emitStateToAll() {
  ensureAdminExists();
  const rawList = Object.values(players);

  const buildPublicPlayers = (viewerId) => rawList.map(p => {
    const activePacts = Object.entries(p.pacts)
      .map(([partnerId, data]) => ({
        partnerName: players[partnerId]?.name,
        color: data.color,
        turnsLeft: data.turns
      }))
      .filter(item => item.partnerName);

    return {
      id: p.id,
      name: p.name,
      isAdmin: p.isAdmin,
      online: p.online,
      alive: p.alive,
      influence: p.influence,
      // Передаем количество ракет ТОЛЬКО самому владельцу! Для остальных — null (Секретно)
      rockets: p.id === viewerId ? p.rockets : null,
      sanctioned: p.sanctioned,
      immune: p.immune,
      ready: p.action !== null,
      activePacts,
      primaryPactColor: activePacts.length > 0 ? activePacts[0].color : null
    };
  });

  // Отправляем персонализированный стейт каждому подключенному сокету
  io.sockets.sockets.forEach((sock) => {
    const viewer = getPlayerBySocket(sock.id);
    sock.emit('state_update', {
      players: buildPublicPlayers(viewer ? viewer.id : null),
      minPlayers: MIN_PLAYERS,
      totalLaunches,
      lastTurnLaunches,
      turnNumber,
      roomLocked,
      gameOverData,
      logs: logs.slice(0, 35)
    });
  });
}

function addLog(entries) {
  logs = [...entries, ...logs].slice(0, 60);
}

function buildPlayerSessionPayload(p) {
  const myMessages = turnMessages.filter(m => m.fromId === p.id || m.toId === p.id);
  return {
    id: p.id,
    name: p.name,
    isAdmin: p.isAdmin,
    mission: p.mission,
    currentAction: p.action ? {
      type: p.action.type,
      targetName: players[p.action.targetId]?.name || null
    } : null,
    chatHistory: myMessages
  };
}

function checkEndGame(launchesThisTurn) {
  const pList = Object.values(players);
  const alivePlayers = pList.filter(p => p.alive);
  const hegemon = alivePlayers.find(p => p.influence >= 10);

  let endReason = null;
  let headline = '';

  if (launchesThisTurn >= 4) {
    endReason = 'nuclear';
    headline = `☢️ ЯДЕРНАЯ ЗИМА! За один раунд выпущено сразу ${launchesThisTurn} ракет! Планета погрузилась во тьму!`;
  } else if (hegemon) {
    endReason = 'hegemony';
    headline = `👑 ГЕГЕМОНИЯ! Держава ${hegemon.name} набрала ${hegemon.influence} влияния и установила мировой порядок!`;
  } else if (pList.length >= 3 && alivePlayers.length <= 2) {
    endReason = 'collapse';
    headline = `🏚 МИРОВОЙ КОЛЛАПС! В живых осталось слишком мало держав (${alivePlayers.length}). Система рухнула!`;
  }

  if (!endReason) return null;

  const results = pList.map(p => {
    let mWon = false;
    const mId = p.mission.id;

    if (mId === 'arms_dealer' && totalLaunches >= 3 && p.alive) mWon = true;
    if (mId === 'pacifist' && endReason === 'hegemony' && !p.stats.everBuiltRocket) mWon = true;
    if (mId === 'martyr' && firstDeadId === p.id) mWon = true;
    if (mId === 'nihilist' && endReason === 'nuclear') mWon = true;
    if (mId === 'puppeteer' && endReason === 'collapse' && p.alive) mWon = true;
    if (mId === 'iron_dome' && p.stats.blockedHits >= 1) mWon = true;
    if (mId === 'diplomat' && p.stats.pactsCount >= 2 && p.alive) mWon = true;
    if (mId === 'inquisitor' && p.stats.sanctionsCount >= 2) mWon = true;
    if (mId === 'executioner' && p.stats.killsCount >= 1) mWon = true;
    if (mId === 'bunker' && p.stats.pactsCount === 0 && p.alive) mWon = true;
    if (mId === 'nuclear_baron' && p.stats.reachedMaxRockets && p.alive) mWon = true;
    if (mId === 'agent_of_influence' && p.influence >= 6 && p.alive) mWon = true;

    const isHegemon = (endReason === 'hegemony' && hegemon && hegemon.id === p.id);

    return {
      name: p.name,
      alive: p.alive,
      isHegemon,
      missionTitle: p.mission.title,
      missionDesc: p.mission.desc,
      missionWon: mWon
    };
  });

  return { endReason, headline, results };
}

function executeResolveTurn(forceByAdmin = false) {
  if (gameOverData) return;
  const pList = Object.values(players);
  if (pList.length === 0) return;
  if (pList.length < MIN_PLAYERS && !forceByAdmin) return;

  const resolvedTurnNum = turnNumber;
  let turnLogs = [`=== ⚡️ ИТОГИ ХОДА ${resolvedTurnNum} ===`];
  let launchesThisTurn = 0;

  // Данные для пошаговой рулетки вскрытия на экранах игроков
  let step1Diplomacy = [];
  let step2EconomySecret = [];
  let step3War = [];

  pList.forEach(p => {
    p.shield = false;
    for (let partnerId in p.pacts) {
      p.pacts[partnerId].turns--;
      if (p.pacts[partnerId].turns <= 0) delete p.pacts[partnerId];
    }
  });

  // 1. Скрытая установка Щитов и Постройка Ракет (Туман войны!)
  pList.forEach(p => {
    if (!p.action) return;

    if (p.alive && p.action.type === 'shield') {
      p.shield = true;
      step2EconomySecret.push(`🕵️ <strong>${p.name}</strong>: Секретная разработка <em>(Щит или Ракета?)</em>`);
      turnLogs.push(`🕵️ ${p.name} проводит секретную разработку (Щит или Ракета?).`);
    } else if (p.alive && p.action.type === 'rocket') {
      p.stats.everBuiltRocket = true;
      if (p.rockets < 3) {
        p.rockets += 1;
        if (p.rockets === 3) p.stats.reachedMaxRockets = true;
      }
      step2EconomySecret.push(`🕵️ <strong>${p.name}</strong>: Секретная разработка <em>(Щит или Ракета?)</em>`);
      turnLogs.push(`🕵️ ${p.name} проводит секретную разработку (Щит или Ракета?).`);
    } else if (!p.alive && p.action.type === 'shadow_shield') {
      const target = players[p.action.targetId];
      if (target && target.alive) {
        target.shield = true;
        step2EconomySecret.push(`🕶 <strong>${p.name}</strong>: Тайная операция подполья`);
        turnLogs.push(`🕶 Теневое правительство (${p.name}) тайно усилило чью-то ПРО.`);
      }
    }
  });

  // 2. Дипломатия (Пакты и Санкции)
  let nextSanctioned = new Set();
  const handledPacts = new Set();

  pList.forEach(p => {
    if (!p.alive || !p.action) return;

    if (p.action.type === 'pact') {
      const target = players[p.action.targetId];
      const pairKey = [p.id, target?.id].sort().join('-');
      if (target && target.alive && !handledPacts.has(pairKey)) {
        if (target.action && target.action.type === 'pact' && target.action.targetId === p.id) {
          const allianceColor = PACT_COLORS[pactColorIndex % PACT_COLORS.length];
          pactColorIndex++;

          p.influence += 1;
          target.influence += 1;
          p.pacts[target.id] = { turns: 2, color: allianceColor };
          target.pacts[p.id] = { turns: 2, color: allianceColor };
          p.stats.pactsCount += 1;
          target.stats.pactsCount += 1;
          handledPacts.add(pairKey);

          const msg = `🤝 <strong>${p.name} + ${target.name}</strong>: Неоновый Пакт (+1 ⚡️ каждому)`;
          step1Diplomacy.push(msg);
          turnLogs.push(`🤝 АЛЬЯНС! ${p.name} и ${target.name} заключили Пакт (+1 влияния каждому).`);
        } else {
          const msg = `💔 <strong>${p.name}</strong> ➔ ${target.name}: Пакт отвергнут!`;
          step1Diplomacy.push(msg);
          turnLogs.push(`💔 ${p.name} предлагал Пакт державе ${target.name}, но остался без ответа!`);
        }
      }
    }

    if (p.action.type === 'sanctions') {
      const target = players[p.action.targetId];
      if (target && target.alive) {
        if (target.immune) {
          step1Diplomacy.push(`🛡 Санкции <strong>${p.name}</strong> против ${target.name} отражены Иммунитетом!`);
          turnLogs.push(`🛡 Санкции от ${p.name} против ${target.name} отклонены (Иммунитет).`);
        } else {
          nextSanctioned.add(target.id);
          p.stats.sanctionsCount += 1;
          step1Diplomacy.push(`🚫 <strong>${p.name}</strong> блокирует санкциями <strong>${target.name}</strong>!`);
          turnLogs.push(`🚫 ${p.name} вводит санкции против ${target.name}!`);
        }
      }
    }
  });

  // 3. Открытая экономика (Реформы)
  pList.forEach(p => {
    if (!p.alive || !p.action) return;
    if (p.action.type === 'reform') {
      p.influence += 2;
      step2EconomySecret.unshift(`⚡️ <strong>${p.name}</strong> проводит Реформу (+2 Влияния)`);
      turnLogs.push(`⚡️ ${p.name} проводит Реформу (+2 влияния).`);
    }
  });

  // 4. Война (Запуски ракет)
  pList.forEach(p => {
    if (!p.alive || !p.action) return;
    if (p.action.type === 'launch') {
      const target = players[p.action.targetId];
      if (!target || !target.alive) return;
      if (p.pacts[target.id]) {
        step3War.push(`❌ <strong>${p.name}</strong> пытался атаковать союзника ${target.name} (Блок Пактом)`);
        turnLogs.push(`❌ ${p.name} пытался атаковать союзника ${target.name}, но связан Пактом!`);
        return;
      }
      if (p.rockets <= 0) {
        step3War.push(`❌ <strong>${p.name}</strong> нажал кнопку пуска по ${target.name}, но это блеф (0 🚀)!`);
        turnLogs.push(`❌ ${p.name} нажал кнопку пуска по ${target.name}, но шахты пусты!`);
        return;
      }

      p.rockets -= 1;
      totalLaunches += 1;
      launchesThisTurn += 1;

      if (target.shield) {
        target.shield = false;
        target.stats.blockedHits += 1;
        step3War.push(`💥 <strong>${p.name}</strong> выпустил ракету в <strong>${target.name}</strong> ➔ 🛡 СРАБОТАЛ ЩИТ!`);
        turnLogs.push(`💥 ${p.name} нанес ядерный удар по ${target.name}, но сработал ЩИТ ПРО!`);
      } else {
        target.alive = false;
        target.influence = 0;
        target.rockets = 0;
        target.pacts = {};
        p.stats.killsCount += 1;
        if (!firstDeadId) firstDeadId = target.id;
        step3War.push(`☢️ <strong>${p.name}</strong> ИСПЕПЕЛЯЕТ ракетой державу <strong>${target.name}</strong>!`);
        turnLogs.push(`☢️ ПРЯМОЕ ПОПАДАНИЕ! ${p.name} уничтожает ${target.name}. Держава уходит в подполье.`);
      }
    }
  });

  if (step1Diplomacy.length === 0) step1Diplomacy.push('Тишина в дипломатическом корпусе...');
  if (step2EconomySecret.length === 0) step2EconomySecret.push('Экономических и секретных приказов не зафиксировано...');
  if (step3War.length === 0) step3War.push('🕊 В этом раунде ни одна ракета не покинула шахту.');

  lastTurnLaunches = launchesThisTurn;

  pList.forEach(p => {
    if (p.sanctioned) {
      p.sanctioned = false;
      p.immune = true;
    } else if (nextSanctioned.has(p.id)) {
      p.sanctioned = true;
      p.immune = false;
    } else {
      p.immune = false;
    }
    p.action = null;
  });

  turnMessages = [];
  gameOverData = checkEndGame(launchesThisTurn);
  if (gameOverData) {
    turnLogs.unshift(gameOverData.headline);
  } else {
    turnNumber++;
  }

  addLog(turnLogs);

  io.emit('turn_resolved', {
    turnNumber: resolvedTurnNum,
    rocketLaunchedThisTurn: launchesThisTurn > 0,
    launchesThisTurn,
    gameOver: !!gameOverData,
    rouletteSteps: [
      { title: '1. Дипломатия и Санкции', items: step1Diplomacy },
      { title: '2. Экономика и Секретные проекты', items: step2EconomySecret },
      { title: '3. Военная сводка и Пуски', items: step3War }
    ]
  });

  emitStateToAll();
}

io.on('connection', (socket) => {
  socket.emit('init_missions', MISSIONS);

  socket.on('reconnect_session', (playerId) => {
    if (playerId && players[playerId]) {
      const p = players[playerId];
      p.socketId = socket.id;
      p.online = true;
      socket.emit('joined', buildPlayerSessionPayload(p));
      emitStateToAll();
    } else {
      socket.emit('session_not_found');
    }
  });

  socket.on('join_game', ({ playerId, name }) => {
    const cleanId = playerId || `p_${Math.random().toString(36).slice(2, 10)}`;

    if (players[cleanId]) {
      const existing = players[cleanId];
      existing.socketId = socket.id;
      existing.online = true;
      if (name && name.trim()) existing.name = name.trim();
      socket.emit('joined', buildPlayerSessionPayload(existing));
      emitStateToAll();
      return;
    }

    if (roomLocked) {
      socket.emit('error_msg', '🔒 Комната закрыта ведущим! Идет активная партия.');
      return;
    }

    const mission = drawMission();
    const isFirstPlayer = Object.keys(players).length === 0;

    players[cleanId] = {
      id: cleanId,
      socketId: socket.id,
      online: true,
      name: (name || '').trim() || `Держава-${cleanId.slice(-3)}`,
      isAdmin: isFirstPlayer,
      alive: true,
      influence: 0,
      rockets: 0,
      shield: false,
      sanctioned: false,
      immune: false,
      pacts: {},
      mission: mission,
      action: null,
      stats: {
        everBuiltRocket: false,
        blockedHits: 0,
        pactsCount: 0,
        sanctionsCount: 0,
        killsCount: 0,
        reachedMaxRockets: false
      }
    };

    const currentCount = Object.keys(players).length;
    socket.emit('joined', buildPlayerSessionPayload(players[cleanId]));
    addLog([`🟢 ${players[cleanId].name} вступает в игру (Игроков: ${currentCount}/${MIN_PLAYERS}).`]);
    emitStateToAll();
  });

  // Живые реакции-эмодзи поверх экрана
  socket.on('send_reaction', (emoji) => {
    const p = getPlayerBySocket(socket.id);
    if (!p) return;
    io.emit('reaction_broadcast', {
      senderName: p.name,
      emoji: String(emoji).slice(0, 4)
    });
  });

  socket.on('leave_game', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p) return;
    addLog([`🏳️ ${p.name} покинул совет держав.`]);
    delete players[p.id];
    ensureAdminExists();
    socket.emit('left_game');
    emitStateToAll();
  });

  socket.on('claim_admin', () => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller) return;
    const currentAdmin = Object.values(players).find(p => p.isAdmin);
    if (!currentAdmin || !currentAdmin.online) {
      Object.values(players).forEach(p => { p.isAdmin = false; });
      caller.isAdmin = true;
      addLog([`👑 ${caller.name} принял полномочия ведущего.`]);
      emitStateToAll();
    }
  });

  socket.on('toggle_lock', () => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller || !caller.isAdmin) return;
    roomLocked = !roomLocked;
    addLog([roomLocked ? '🔒 Ведущий закрыл вход для новых игроков.' : '🔓 Ведущий открыл вход в комнату.']);
    emitStateToAll();
  });

  socket.on('kick_player', (targetId) => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller || !caller.isAdmin) return;
    const target = players[targetId];
    if (!target || target.id === caller.id) return;

    addLog([`👢 Держава ${target.name} исключена ведущим.`]);
    if (target.socketId) io.to(target.socketId).emit('kicked');
    delete players[targetId];
    emitStateToAll();
  });

  socket.on('private_message', ({ toId, text }) => {
    const sender = getPlayerBySocket(socket.id);
    const receiver = players[toId];
    if (!sender || !receiver || !text.trim()) return;

    const msgData = {
      fromId: sender.id,
      fromName: sender.name,
      toId: receiver.id,
      toName: receiver.name,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    turnMessages.push(msgData);
    if (receiver.socketId) io.to(receiver.socketId).emit('chat_message', msgData);
    socket.emit('chat_message', msgData);
  });

  socket.on('submit_action', ({ type, targetId }) => {
    const p = getPlayerBySocket(socket.id);
    if (!p || gameOverData) return;

    const totalPlayersCount = Object.keys(players).length;
    if (totalPlayersCount < MIN_PLAYERS) {
      socket.emit('error_msg', `⏳ Ожидание игроков! Для начала партии нужно минимум ${MIN_PLAYERS} человек (сейчас: ${totalPlayersCount}).`);
      return;
    }

    if (p.sanctioned) {
      socket.emit('error_msg', 'Вы под санкциями и пропускаете этот ход!');
      return;
    }
    p.action = { type, targetId };
    socket.emit('action_confirmed', { type, targetName: players[targetId]?.name || null });
    emitStateToAll();

    const activePlayers = Object.values(players).filter(pl => !pl.sanctioned && pl.online);
    if (totalPlayersCount >= MIN_PLAYERS && activePlayers.every(pl => pl.action !== null)) {
      setTimeout(() => executeResolveTurn(false), 600);
    }
  });

  socket.on('start_timer', ({ seconds, label }) => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller || !caller.isAdmin) return;
    io.emit('timer_started', { seconds, label });
  });

  socket.on('resolve_turn', (force = false) => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller || !caller.isAdmin) return;
    const totalPlayersCount = Object.keys(players).length;
    if (totalPlayersCount < MIN_PLAYERS && !force) {
      socket.emit('error_msg', `Нужно минимум ${MIN_PLAYERS} игроков! (Либо нажмите «Форсировать (<6)» в панели ведущего).`);
      return;
    }
    executeResolveTurn(true);
  });

  socket.on('reset_game', () => {
    const caller = getPlayerBySocket(socket.id);
    if (!caller || !caller.isAdmin) return;

    totalLaunches = 0;
    lastTurnLaunches = 0;
    turnNumber = 1;
    firstDeadId = null;
    gameOverData = null;
    missionDeck = [];
    turnMessages = [];
    logs = [`🔄 === НОВАЯ ПАРТИЯ НАЧАЛАСЬ! Всем выданы новые секретные миссии ===`];

    Object.values(players).forEach(p => {
      const newMission = drawMission();
      p.alive = true;
      p.influence = 0;
      p.rockets = 0;
      p.shield = false;
      p.sanctioned = false;
      p.immune = false;
      p.pacts = {};
      p.action = null;
      p.mission = newMission;
      p.stats = {
        everBuiltRocket: false,
        blockedHits: 0,
        pactsCount: 0,
        sanctionsCount: 0,
        killsCount: 0,
        reachedMaxRockets: false
      };

      if (p.socketId) {
        io.to(p.socketId).emit('joined', buildPlayerSessionPayload(p));
      }
    });

    io.emit('turn_resolved', { rocketLaunchedThisTurn: false, launchesThisTurn: 0, gameOver: false, rouletteSteps: null });
    emitStateToAll();
  });

  socket.on('disconnect', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p) return;
    p.online = false;
    emitStateToAll();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер Геополитики запущен на порту ${PORT}`);
});