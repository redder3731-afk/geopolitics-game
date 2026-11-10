const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MISSIONS = [
  {
    id: 'arms_dealer',
    title: '💰 Оружейный барон',
    desc: 'За игру должно быть запущено минимум 3 ракеты (кем угодно), а твоя страна должна остаться в живых.'
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
    desc: 'Доведи мир до Ядерной катастрофы (суммарно запущено 4 или более ракет за игру).'
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
    desc: 'Накопи максимальный арсенал (3 ракеты одновременно) в любой момент игры и выживи до финала.'
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
let turnNumber = 1;
let firstDeadId = null;
let gameOverData = null;
let logs = ['🌍 Сервер запущен. Ожидание глав государств...'];

function drawMission() {
  if (missionDeck.length === 0) {
    missionDeck = [...MISSIONS].sort(() => Math.random() - 0.5);
  }
  return missionDeck.pop();
}

function getPublicState() {
  const list = Object.values(players).map(p => ({
    id: p.id,
    name: p.name,
    isAdmin: p.isAdmin,
    alive: p.alive,
    influence: p.influence,
    rockets: p.rockets,
    sanctioned: p.sanctioned,
    immune: p.immune,
    ready: p.action !== null,
    pactsWith: Object.keys(p.pacts).map(id => players[id]?.name).filter(Boolean)
  }));
  return { players: list, totalLaunches, turnNumber, gameOverData, logs: logs.slice(0, 35) };
}

function addLog(entries) {
  logs = [...entries, ...logs].slice(0, 60);
}

function checkEndGame() {
  const pList = Object.values(players);
  const alivePlayers = pList.filter(p => p.alive);
  const hegemon = alivePlayers.find(p => p.influence >= 10);

  let endReason = null;
  let headline = '';

  if (totalLaunches >= 4) {
    endReason = 'nuclear';
    headline = `☢️ ЯДЕРНАЯ КАТАСТРОФА! Запущено ракет: ${totalLaunches}. Мир обращен в пепел!`;
  } else if (hegemon) {
    endReason = 'hegemony';
    headline = `👑 ГЕГЕМОНИЯ! Держава ${hegemon.name} набрала ${hegemon.influence} влияния и правит миром!`;
  } else if (pList.length >= 3 && alivePlayers.length <= 2) {
    endReason = 'collapse';
    headline = `🏚 КОЛЛАПС! В живых осталось слишком мало держав (${alivePlayers.length}). Система рухнула!`;
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

function executeResolveTurn() {
  if (gameOverData) return;
  const pList = Object.values(players);
  if (pList.length === 0) return;

  let turnLogs = [`=== ⚡️ ИТОГИ ХОДА ${turnNumber} ===`];
  let rocketLaunchedThisTurn = false;

  pList.forEach(p => {
    p.shield = false;
    for (let partnerId in p.pacts) {
      p.pacts[partnerId]--;
      if (p.pacts[partnerId] <= 0) delete p.pacts[partnerId];
    }
  });

  // ФАЗА 1: Щиты
  pList.forEach(p => {
    if (!p.action) return;
    if (p.alive && p.action.type === 'shield') {
      p.shield = true;
    } else if (!p.alive && p.action.type === 'shadow_shield') {
      const target = players[p.action.targetId];
      if (target && target.alive) {
        target.shield = true;
        turnLogs.push(`🕶 Теневое правительство (${p.name}) тайно усилило чью-то ПРО.`);
      }
    }
  });

  // ФАЗА 2: Дипломатия
  let nextSanctioned = new Set();
  const handledPacts = new Set();

  pList.forEach(p => {
    if (!p.alive || !p.action) return;

    if (p.action.type === 'pact') {
      const target = players[p.action.targetId];
      const pairKey = [p.id, target?.id].sort().join('-');
      if (target && target.alive && !handledPacts.has(pairKey)) {
        if (target.action && target.action.type === 'pact' && target.action.targetId === p.id) {
          p.influence += 1;
          target.influence += 1;
          p.pacts[target.id] = 2;
          target.pacts[p.id] = 2;
          p.stats.pactsCount += 1;
          target.stats.pactsCount += 1;
          handledPacts.add(pairKey);
          turnLogs.push(`🤝 ${p.name} и ${target.name} заключили Пакт (+1 влияния каждому, 2 хода защиты).`);
        } else {
          turnLogs.push(`💔 ${p.name} предлагал Пакт державе ${target.name}, но остался без ответа!`);
        }
      }
    }

    if (p.action.type === 'sanctions') {
      const target = players[p.action.targetId];
      if (target && target.alive) {
        if (target.immune) {
          turnLogs.push(`🛡 Санкции от ${p.name} против ${target.name} отклонены (Иммунитет).`);
        } else {
          nextSanctioned.add(target.id);
          p.stats.sanctionsCount += 1;
          turnLogs.push(`🚫 ${p.name} накладывает санкции на ${target.name}!`);
        }
      }
    }
  });

  // ФАЗА 3: Экономика
  pList.forEach(p => {
    if (!p.alive || !p.action) return;
    if (p.action.type === 'reform') {
      p.influence += 2;
      turnLogs.push(`⚡️ ${p.name} проводит Реформу (+2 влияния).`);
    } else if (p.action.type === 'rocket') {
      p.stats.everBuiltRocket = true;
      if (p.rockets < 3) {
        p.rockets += 1;
        if (p.rockets === 3) p.stats.reachedMaxRockets = true;
        turnLogs.push(`🚀 ${p.name} строит ракету (в арсенале: ${p.rockets}/3).`);
      } else {
        turnLogs.push(`⚠️ ${p.name} пытался построить ракету, но шахты переполнены (макс. 3).`);
      }
    }
  });

  // ФАЗА 4: Война
  pList.forEach(p => {
    if (!p.alive || !p.action) return;
    if (p.action.type === 'launch') {
      const target = players[p.action.targetId];
      if (!target || !target.alive) return;
      if (p.pacts[target.id]) {
        turnLogs.push(`❌ ${p.name} пытался атаковать ${target.name}, но связан Пактом!`);
        return;
      }
      if (p.rockets <= 0) {
        turnLogs.push(`❌ ${p.name} нажал кнопку пуска по ${target.name}, но ракет нет!`);
        return;
      }

      p.rockets -= 1;
      totalLaunches += 1;
      rocketLaunchedThisTurn = true;

      if (target.shield) {
        target.shield = false;
        target.stats.blockedHits += 1;
        turnLogs.push(`💥 ${p.name} запустил ракету в ${target.name}, но сработал ЩИТ! Удар отражен.`);
      } else {
        target.alive = false;
        target.influence = 0;
        target.rockets = 0;
        p.stats.killsCount += 1;
        if (!firstDeadId) firstDeadId = target.id;
        turnLogs.push(`☢️ ПРЯМОЕ ПОПАДАНИЕ! ${p.name} уничтожает ${target.name}. Страна уходит в подполье.`);
      }
    }
  });

  // Обновление статусов санкций
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

  gameOverData = checkEndGame();
  if (gameOverData) {
    turnLogs.unshift(gameOverData.headline);
  } else {
    turnNumber++;
  }

  addLog(turnLogs);
  io.emit('turn_resolved', { rocketLaunchedThisTurn, gameOver: !!gameOverData });
  io.emit('state_update', getPublicState());
}

io.on('connection', (socket) => {
  socket.emit('init_missions', MISSIONS);

  socket.on('join_game', (name) => {
    const mission = drawMission();
    const isFirstPlayer = Object.keys(players).length === 0;

    players[socket.id] = {
      id: socket.id,
      name: name.trim() || `Держава-${socket.id.slice(0, 3)}`,
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

    socket.emit('joined', {
      id: socket.id,
      name: players[socket.id].name,
      isAdmin: isFirstPlayer,
      mission: mission
    });

    addLog([`🟢 ${players[socket.id].name} вступает в геополитическую игру.`]);
    io.emit('state_update', getPublicState());
  });

  socket.on('private_message', ({ toId, text }) => {
    const sender = players[socket.id];
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

    io.to(toId).emit('chat_message', msgData);
    socket.emit('chat_message', msgData);
  });

  socket.on('submit_action', ({ type, targetId }) => {
    const p = players[socket.id];
    if (!p || gameOverData) return;
    if (p.sanctioned) {
      socket.emit('error_msg', 'Вы под санкциями и пропускаете этот ход!');
      return;
    }
    p.action = { type, targetId };
    socket.emit('action_confirmed', { type, targetName: players[targetId]?.name || null });
    io.emit('state_update', getPublicState());

    const activePlayers = Object.values(players).filter(pl => !pl.sanctioned);
    if (activePlayers.length >= 2 && activePlayers.every(pl => pl.action !== null)) {
      setTimeout(() => executeResolveTurn(), 600);
    }
  });

  socket.on('start_timer', ({ seconds, label }) => {
    io.emit('timer_started', { seconds, label });
  });

  socket.on('resolve_turn', () => {
    executeResolveTurn();
  });

  socket.on('reset_game', () => {
    totalLaunches = 0;
    turnNumber = 1;
    firstDeadId = null;
    gameOverData = null;
    missionDeck = [];
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

      io.to(p.id).emit('joined', {
        id: p.id,
        name: p.name,
        isAdmin: p.isAdmin,
        mission: newMission
      });
    });

    io.emit('turn_resolved', { rocketLaunchedThisTurn: false, gameOver: false });
    io.emit('state_update', getPublicState());
  });

  socket.on('disconnect', () => {
    const wasAdmin = players[socket.id]?.isAdmin;
    const leaverName = players[socket.id]?.name;
    delete players[socket.id];

    if (leaverName) addLog([`🔴 ${leaverName} покинул совет.`]);

    const remaining = Object.values(players);
    if (wasAdmin && remaining.length > 0) {
      remaining[0].isAdmin = true;
      io.to(remaining[0].id).emit('admin_granted');
    }
    io.emit('state_update', getPublicState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер Геополитики запущен на порту ${PORT}`);
});