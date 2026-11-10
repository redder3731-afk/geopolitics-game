const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MISSIONS = [
  "Оружейный барон: Победи, если за игру запущено минимум 3 ракеты, а твоя страна жива.",
  "Пацифист: Победи вместе с Гегемоном, ни разу за игру не накопив ракету.",
  "Мученик: Победи, если твоя страна станет первой уничтоженной в игре.",
  "Нигилист: Победи, если игра закончится Ядерной катастрофой (4 запуска ракет).",
  "Теневой кукловод: Доведи игру до Коллапса (в живых не более 2 стран), оставшись в живых."
];

let players = {};
let totalLaunches = 0;
let turnNumber = 1;

function getPublicState() {
  const list = Object.values(players).map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    influence: p.influence,
    rockets: p.rockets,
    sanctioned: p.sanctioned,
    immune: p.immune,
    ready: p.action !== null,
    pactsWith: Object.keys(p.pacts).map(id => players[id]?.name).filter(Boolean)
  }));
  return { players: list, totalLaunches, turnNumber };
}

io.on('connection', (socket) => {
  // Подключение экрана Хоста
  socket.on('register_host', () => {
    socket.join('hosts');
    socket.emit('state_update', getPublicState());
  });

  // Подключение Игрока со смартфона
  socket.on('join_game', (name) => {
    const mission = MISSIONS[Math.floor(Math.random() * MISSIONS.length)];
    players[socket.id] = {
      id: socket.id,
      name: name.trim() || `Страна-${socket.id.slice(0, 3)}`,
      alive: true,
      influence: 0,
      rockets: 0,
      shield: false,
      sanctioned: false,
      immune: false,
      pacts: {}, // { partnerId: turnsLeft }
      mission: mission,
      action: null
    };

    socket.emit('joined', {
      id: socket.id,
      name: players[socket.id].name,
      mission: mission
    });

    io.emit('state_update', getPublicState());
    io.to('hosts').emit('host_log', [`🟢 ${players[socket.id].name} вступает в геополитическую гонку.`]);
  });

  // Приватный чат (Дипломатия)
  socket.on('private_message', ({ toId, text }) => {
    const sender = players[socket.id];
    const receiver = players[toId];
    if (!sender || !receiver || !text.trim()) return;

    const msgData = {
      fromName: sender.name,
      toName: receiver.name,
      text: text.trim()
    };

    io.to(toId).emit('chat_message', msgData);
    socket.emit('chat_message', msgData);

    // На общем экране показываем сам факт переговоров без текста
    io.to('hosts').emit('host_log', [`🕵️ Перехвачена зашифрованная сводка между двумя державами...`]);
  });

  // Запись тайного действия игрока
  socket.on('submit_action', ({ type, targetId }) => {
    const p = players[socket.id];
    if (!p) return;
    if (p.sanctioned) {
      socket.emit('error_msg', 'Вы под санкциями и пропускаете этот ход!');
      return;
    }
    p.action = { type, targetId };
    io.emit('state_update', getPublicState());
  });

  // Хост нажимает "Вскрыть действия" (Резолв стека)
  socket.on('resolve_turn', () => {
    let logs = [`=== ИТОГИ ХОДА ${turnNumber} ===`];
    const pList = Object.values(players);

    // Сброс щитов с прошлого хода и уменьшение таймера пактов
    pList.forEach(p => {
      p.shield = false;
      for (let partnerId in p.pacts) {
        p.pacts[partnerId]--;
        if (p.pacts[partnerId] <= 0) delete p.pacts[partnerId];
      }
    });

    // ФАЗА 1: Щиты (и Теневые щиты от уничтоженных стран)
    pList.forEach(p => {
      if (!p.action) return;
      if (p.alive && p.action.type === 'shield') {
        p.shield = true;
      } else if (!p.alive && p.action.type === 'shadow_shield') {
        const target = players[p.action.targetId];
        if (target && target.alive) {
          target.shield = true;
          logs.push(`🕶 Теневое правительство (${p.name}) тайно профинансировало чью-то ПРО.`);
        }
      }
    });

    // ФАЗА 2: Дипломатия (Пакты и Санкции)
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
            handledPacts.add(pairKey);
            logs.push(`🤝 ${p.name} и ${target.name} заключили Пакт (+1 влияния каждому, 2 хода мира).`);
          } else {
            logs.push(`💔 ${p.name} протянул руку для Пакта с ${target.name}, но остался без ответа!`);
          }
        }
      }

      if (p.action.type === 'sanctions') {
        const target = players[p.action.targetId];
        if (target && target.alive) {
          if (target.immune) {
            logs.push(`🛡 Попытка санкций от ${p.name} против ${target.name} провалилась (Иммунитет).`);
          } else {
            nextSanctioned.add(target.id);
            logs.push(`🚫 ${p.name} вводит жесткие санкции против ${target.name}!`);
          }
        }
      }
    });

    // ФАЗА 3: Экономика (Реформы и накопление Ракет)
    pList.forEach(p => {
      if (!p.alive || !p.action) return;
      if (p.action.type === 'reform') {
        p.influence += 2;
        logs.push(`⚡️ ${p.name} проводит Реформу (+2 влияния).`);
      } else if (p.action.type === 'rocket') {
        if (p.rockets < 3) {
          p.rockets += 1;
          logs.push(`🚀 ${p.name} строит ракету (всего: ${p.rockets}).`);
        } else {
          logs.push(`⚠️ ${p.name} пытался построить ракету, но склады переполнены (макс. 3).`);
        }
      }
    });

    // ФАЗА 4: Война (Запуски)
    pList.forEach(p => {
      if (!p.alive || !p.action) return;
      if (p.action.type === 'launch') {
        const target = players[p.action.targetId];
        if (!target || !target.alive) return;
        if (p.pacts[target.id]) {
          logs.push(`❌ ${p.name} пытался запустить ракету в ${target.name}, но связан Пактом!`);
          return;
        }
        if (p.rockets <= 0) {
          logs.push(`❌ ${p.name} нажал красную кнопку против ${target.name}, но шахты пусты!`);
          return;
        }

        p.rockets -= 1;
        totalLaunches += 1;

        if (target.shield) {
          target.shield = false;
          logs.push(`💥 ${p.name} запустил ракету в ${target.name}, но сработал ЩИТ! Удар отражен.`);
        } else {
          target.alive = false;
          target.influence = 0;
          target.rockets = 0;
          logs.push(`☢️ ПРЯМОЕ ПОПАДАНИЕ! ${p.name} уничтожает ${target.name}. Страна уходит в подполье.`);
        }
      }
    });

    // Обновление статусов санкций и иммунитета на следующий ход
    pList.forEach(p => {
      if (p.sanctioned) {
        p.sanctioned = false;
        p.immune = true; // Иммунитет после пропуска хода
      } else if (nextSanctioned.has(p.id)) {
        p.sanctioned = true;
        p.immune = false;
      } else {
        p.immune = false;
      }
      p.action = null;
    });

    // Проверка условий окончания игры
    const alivePlayers = pList.filter(p => p.alive);
    const hegemon = alivePlayers.find(p => p.influence >= 10);

    if (totalLaunches >= 4) {
      logs.push(`💀 ЯДЕРНАЯ КАТАСТРОФА! Запущено ракет: ${totalLaunches}. Мир в труху! Проверьте секретные миссии.`);
    } else if (hegemon) {
      logs.push(`👑 ГЕГЕМОНИЯ! ${hegemon.name} набирает ${hegemon.influence} влияния и побеждает!`);
    } else if (pList.length >= 3 && alivePlayers.length <= 2) {
      logs.push(`🏚 КОЛЛАПС! Осталось слишком мало держав (${alivePlayers.length}). Мировая система рухнула!`);
    }

    turnNumber++;
    io.emit('turn_resolved');
    io.emit('state_update', getPublicState());
    io.to('hosts').emit('host_log', logs);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('state_update', getPublicState());
  });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер Геополитики запущен на порту ${PORT}`);
});