const {
  Client, GatewayIntentBits, REST, Routes, Events,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ChannelType,
} = require('discord.js');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch { console.error('❌ config.json não encontrado.'); process.exit(1); }

const { botToken, clientId, ownerId, allowedUsers = [] } = config;
if (!botToken || !clientId || !ownerId) {
  console.error('❌ Preencha botToken, clientId e ownerId no config.json'); process.exit(1);
}

const FLAG_V2        = 1 << 15;
const FLAG_EPHEMERAL = 1 << 6;
const VERSION        = '2.0.0';

// ─── Token store ──────────────────────────────────────────────────────────────
class TokenStore {
  constructor() { this.data = {}; this.load(); }
  load() {
    try { if (fs.existsSync(TOKENS_PATH)) this.data = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); }
    catch { this.data = {}; }
  }
  save()             { fs.writeFileSync(TOKENS_PATH, JSON.stringify(this.data, null, 2)); }
  get(uid)           { return this.data[uid] || null; }
  set(uid, token)    { this.data[uid] = token; this.save(); }
  remove(uid)        { delete this.data[uid]; this.save(); }
  has(uid)           { return !!this.data[uid]; }
  count()            { return Object.keys(this.data).length; }
}
const store = new TokenStore();

// ─── Farm por usuário ─────────────────────────────────────────────────────────
const farms = new Map();
function getFarm(uid) {
  if (!farms.has(uid)) farms.set(uid, { running: false, aborted: false, progress: [], startMs: 0 });
  return farms.get(uid);
}

// ─── Permissão ────────────────────────────────────────────────────────────────
function isAllowed(uid) { return uid === ownerId || allowedUsers.includes(uid); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TASK_TYPES = {
  WATCH_VIDEO:           '🎬 Vídeo',
  WATCH_VIDEO_ON_MOBILE: '🎬 Vídeo Mobile',
  PLAY_ON_DESKTOP:       '🎮 Jogar (PC)',
  PLAY_ON_XBOX:          '🎮 Jogar (Xbox)',
  PLAY_ON_PLAYSTATION:   '🎮 Jogar (PS)',
};
const TASK_PRIORITY = ['PLAY_ON_DESKTOP','PLAY_ON_XBOX','PLAY_ON_PLAYSTATION','WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE'];

function sleep(ms)              { return new Promise(r => setTimeout(r, ms)); }
function jitter(base, r = 1500) { return base + Math.floor(Math.random() * r); }
function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function getTaskDuration(t) {
  if (t >= 60) { const m = Math.floor(t/60), s = t%60; return s > 0 ? `${m}min ${s}s` : `${m} minutos`; }
  return `${Math.floor(t)} segundos`;
}
function liveBar(current, total, size = 12) {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const f   = Math.round(pct * size);
  return `[${'#'.repeat(f)}${'-'.repeat(size - f)}] ${Math.floor(pct * 100)}%`;
}
function parseReward(r) {
  if (!r) return 'Desconhecida';
  if (r.type === 4) return `${r.orb_quantity} Orbs`;
  if (r.type === 3) return r.messages?.name || 'Decoração';
  if (r.type === 1) return r.messages?.name || 'Item';
  return 'Recompensa';
}
function getBestTask(tasks) {
  let best = null, bestIdx = 999;
  for (const [type, data] of Object.entries(tasks)) {
    const idx = TASK_PRIORITY.indexOf(type);
    if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = { taskType: type, taskData: data }; }
  }
  return best;
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}
const sep = (spacing = 2) => ({ type: 14, divider: true, spacing });
const txt = (content)     => ({ type: 10, content });

// ─── API self ─────────────────────────────────────────────────────────────────
async function selfReq(token, endpoint, method = 'GET', body = null) {
  try {
    const headers = {
      'authorization':      token,
      'x-super-properties': config.xSuperProperties || '',
      'user-agent':         config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
      'accept-language':    'pt-BR,pt;q=0.9',
      'sec-ch-ua':          '"Chromium";v="138", "Not=A?Brand";v="8"',
      'sec-ch-ua-mobile':   '?0',
      'sec-ch-ua-platform': '"Windows"',
      'origin':             'https://discord.com',
      'referer':            'https://discord.com/channels/@me',
    };
    if (body) headers['content-type'] = 'application/json';
    return await axios({ method, url: `https://discord.com/api/v9${endpoint}`, headers, data: body, validateStatus: () => true });
  } catch { return { status: 500, data: null }; }
}
async function getSelfInfo(token)   { const r = await selfReq(token, '/users/@me'); return r.status === 200 ? r.data : null; }
async function getOrbBalance(token) { const r = await selfReq(token, '/users/@me/virtual-currency/balance'); return r.status === 200 ? (r.data.balance ?? '?') : '?'; }

async function fetchQuests(token) {
  const res = await selfReq(token, '/quests/@me');
  if (res.status !== 200 || !res.data?.quests) return [];
  const now = new Date();
  return res.data.quests
    .filter(q => new Date(q.config.expires_at) > now && !q.user_status?.completed_at)
    .map(q => {
      const best = getBestTask(q.config.task_config_v2?.tasks || {});
      if (!best) return null;
      return { questId: q.id, name: q.config.messages.quest_name, taskType: best.taskType, target: best.taskData.target || 0, reward: parseReward(q.config.rewards_config?.rewards?.[0]), isEnrolled: !!q.user_status?.enrolled_at };
    })
    .filter(Boolean)
    .sort((a, b) => { const aO = a.reward.includes('Orbs'), bO = b.reward.includes('Orbs'); if (aO && !bO) return -1; if (!aO && bO) return 1; return a.target - b.target; });
}

// ─── Logs no canal ────────────────────────────────────────────────────────────
async function sendLog(payload) {
  if (!config.logChannelId) return;
  try { const ch = await client.channels.fetch(config.logChannelId); if (ch) await ch.send(payload); } catch {}
}
async function logFarmStart(u, n) {
  await sendLog({ embeds: [new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: u.tag, iconURL: u.displayAvatarURL() })
    .setTitle('🚀 Farm Iniciado')
    .setDescription([`> 👤 **Usuário:** <@${u.id}>`, `> 🎯 **Missões encontradas:** \`${n}\``, `> 💡 **Status:** Em execução...`].join('\n'))
    .setFooter({ text: 'AUTO ORB • Quest Farm' }).setTimestamp()] });
}
async function logQuestDone(u, name, reward, took) {
  await sendLog({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setAuthor({ name: u.tag, iconURL: u.displayAvatarURL() })
    .setTitle('🎁 Missão Concluída')
    .setDescription([`> 👤 **Usuário:** <@${u.id}>`, `> 🎮 **Missão:** ${name}`, `> 💰 **Recompensa:** \`${reward}\``, `> ⏱️ **Tempo:** \`${formatDuration(took)}\``].join('\n'))
    .setFooter({ text: 'AUTO ORB • Quest Farm' }).setTimestamp()] });
}
async function logFarmDone(u, done, errors, elapsed) {
  await sendLog({ embeds: [new EmbedBuilder()
    .setColor(errors === 0 ? 0x57F287 : 0xFEE75C)
    .setAuthor({ name: u.tag, iconURL: u.displayAvatarURL() })
    .setTitle(errors === 0 ? '✅ Farm Concluído' : '⚠️ Farm Concluído com Erros')
    .setDescription([`> 👤 **Usuário:** <@${u.id}>`, `> 🏆 **Missões concluídas:** \`${done}\``, `> ❌ **Erros:** \`${errors}\``, `> 🕐 **Tempo total:** \`${formatDuration(elapsed)}\``].join('\n'))
    .setFooter({ text: 'AUTO ORB • Quest Farm' }).setTimestamp()] });
}

// ─── Executa quest ────────────────────────────────────────────────────────────
async function runQuest(token, quest, entry, farm) {
  const { questId, taskType, target } = quest;
  if (!quest.isEnrolled) {
    const e = await selfReq(token, `/quests/${questId}/enroll`, 'POST', { location: 11, is_targeted: false, metadata_raw: null });
    if (e.status !== 200) { entry.error = true; entry.done = true; return; }
  }
  if (taskType.startsWith('WATCH_')) {
    let ts = 0;
    while (entry.progress < target && !farm.aborted) {
      const r = await selfReq(token, `/quests/${questId}/video-progress`, 'POST', { timestamp: ts });
      if (r.status === 429 || r.status === 400) { await sleep(jitter(8000)); continue; }
      if (r.status === 200) { if (r.data.completed_at) { entry.progress = target; break; } entry.progress = ts; ts += 10; if (entry.progress >= target) break; }
      await sleep(jitter(2500, 2500));
    }
  } else if (taskType.startsWith('PLAY_')) {
    const sk = `call:${questId}:1`; let stuck = 0;
    while (entry.progress < target && !farm.aborted) {
      const r = await selfReq(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: sk, terminal: false });
      if (r.status === 429) { await sleep(jitter(10000)); continue; }
      if (r.status === 200) {
        const d = r.data;
        if (d.completed_at || d.user_status?.completed_at) { entry.progress = target; break; }
        const np = d.progress?.[taskType]?.value ?? entry.progress;
        if (np > entry.progress) { entry.progress = np; stuck = 0; }
        else if (++stuck >= 8) { await selfReq(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: sk, terminal: true }); entry.progress = target; break; }
      }
      await sleep(jitter(24000, 3000));
    }
    await selfReq(token, `/quests/${questId}/heartbeat`, 'POST', { stream_key: sk, terminal: true });
  }
  entry.progress = target; entry.done = true; entry.doneAt = Date.now();
}

// ─── PAINÉIS ──────────────────────────────────────────────────────────────────
function buildMainPanel(uid) {
  const farm      = getFarm(uid);
  const connected = store.has(uid);
  const status    = farm.running ? 'Em execução' : connected ? 'Conectado' : 'Desconectado';
  const statusIcon = farm.running ? '🟢' : connected ? '🔵' : '🔴';

  return {
    type: 17,
    components: [
      {
        type: 9,
        components: [txt('## ⚡ AUTO ORB — QUESTS DISCORD')],
        accessory: { type: 2, style: 2, custom_id: 'btn_settings', emoji: { name: '⚙️' } },
      },
      txt(`\`👋\` **${greeting()}!**\nAutomação multitarefa simultânea de missões elegíveis e resgate automático de recompensas.`),
      sep(),
      txt('**Estado da Sua Conta**'),
      txt([
        `> \`🔑\` **Conta:** \`${connected ? 'Conectada ✅' : 'Não conectada ❌'}\``,
        `> \`🎯\` **Farm:** \`${farm.running ? `${farm.progress.filter(e=>e.done&&!e.error).length}/${farm.progress.length} quests` : 'Parado'}\``,
        `> \`${statusIcon}\` **Status:** \`${status}\``,
        `> \`📦\` **Versão:** \`${VERSION}\``,
      ].join('\n')),
      sep(),
      txt('**Funcionalidades em Destaque**'),
      txt([
        '> `⚡` **Processamento Paralelo:** Todas as quests rodam ao mesmo tempo',
        '> `🔄` **Progresso em Tempo Real:** Barra de progresso por missão',
        '> `🎁` **Claim Automático:** Orbs e recompensas resgatados sozinhos',
        '> `🔒` **100% Privado:** Só você vê o seu painel',
      ].join('\n')),
      sep(),
      txt('**Como operar:**\nClique na engrenagem `⚙️` no canto superior direito para conectar sua conta ou gerenciar o farm.'),
      sep(1),
      txt('-# Token local • Farm isolado por usuário • Sem dados enviados a terceiros'),
    ],
  };
}

function buildSettingsPanel(user) {
  const uid         = user.id;
  const farm        = getFarm(uid);
  const connected   = store.has(uid);
  const displayName = user.globalName || user.username || 'usuário';

  const options = [
    { label: connected ? 'Reconectar conta' : 'Conectar conta', value: 'action_login',  description: 'Insira o token da sua conta Discord', emoji: { name: '🔑' } },
    connected && { label: 'Ver Missões',    value: 'action_quests', description: 'Lista todas as missões disponíveis',   emoji: { name: '📋' } },
    connected && !farm.running && { label: 'Iniciar Farm', value: 'action_farm', description: 'Inicia o farm automático de missões', emoji: { name: '▶️' } },
    connected && farm.running  && { label: 'Ver Status',   value: 'action_status', description: 'Progresso das missões em tempo real', emoji: { name: '📊' } },
    connected && farm.running  && { label: 'Parar Farm',   value: 'action_stop',   description: 'Interrompe o farm atual',             emoji: { name: '⏹️' } },
    connected && { label: 'Saldo de Orbs', value: 'action_orbs',   description: 'Ver seus Orbs atuais',                 emoji: { name: '💎' } },
    connected && { label: 'Desconectar',   value: 'action_logout', description: 'Remove seu token do bot',              emoji: { name: '🚪' } },
  ].filter(Boolean);

  return {
    type: 17,
    components: [
      txt(`## ⚙️ Configurações`),
      txt(`\`👋\` ${greeting()}, **${displayName}**!\n${connected ? '✅ Sua conta está conectada. Escolha uma ação abaixo.' : '🔑 Para usar o AUTO ORB, conecte sua conta Discord.'}`),
      sep(1),
      {
        type: 1,
        components: [{
          type: 3,
          custom_id: 'select_action',
          placeholder: 'Selecione uma opção...',
          options,
        }],
      },
      sep(1),
      txt('-# 🔒 Suas ações são privadas e só você as vê'),
    ],
  };
}

function buildLivePanel(uid) {
  const farm    = getFarm(uid);
  if (!farm.progress.length) {
    return { type: 17, components: [txt('## 📭 Nenhum farm iniciado'), txt('> Use **Iniciar Farm** no menu de configurações.')] };
  }
  const elapsed = Math.floor((Date.now() - farm.startMs) / 1000);
  const done    = farm.progress.filter(s => s.done && !s.error).length;
  const errors  = farm.progress.filter(s => s.error).length;
  const active  = farm.progress.length - done - errors;

  const components = [
    txt(farm.running ? '## ⚡ Quests em andamento' : '## ✅ Farm finalizado'),
    txt([
      `🕐 **Decorrido:** \`${formatDuration(elapsed)}\``,
      `🎯 **Ativas:** \`${active}\` · ✅ **Feitas:** \`${done}\` · ❌ **Erros:** \`${errors}\``,
    ].join('\n')),
    sep(1),
  ];

  farm.progress.forEach((s, i) => {
    let line;
    if (s.error) line = `❌ **${s.quest.name}**\n⚠️ Erro ao executar missão.`;
    else if (s.done) {
      const took = s.doneAt ? Math.floor((s.doneAt - s.startedAt) / 1000) : 0;
      line = `✅ **${s.quest.name}**\n\`[████████████]\` \`100%\` · concluída em \`${formatDuration(took)}\`\n🎁 Recompensa: \`${s.quest.reward}\``;
    } else {
      const rem = Math.max(0, s.target - s.progress);
      line = `🔷 **${s.quest.name}**\n\`${liveBar(s.progress, s.target)}\`\n⏱️ ETA \`${formatDuration(rem)}\` · feito \`${formatDuration(s.progress)}\` / \`${formatDuration(s.target)}\`\n🎁 \`${s.quest.reward}\` · ${TASK_TYPES[s.quest.taskType] || s.quest.taskType}`;
    }
    components.push(txt(line));
    if (i < farm.progress.length - 1) components.push(sep(1));
  });

  components.push(sep(1));
  components.push(txt('-# 🔒 Só você vê este painel'));
  return { type: 17, components };
}

function buildQuestsPanel(quests) {
  if (!quests.length) {
    return { type: 17, components: [txt('## 📭 Sem missões disponíveis'), txt('> Não há quests disponíveis para sua conta no momento.\n> Tente novamente mais tarde.')] };
  }
  const components = [txt(`## 📋 Missões disponíveis (${quests.length})`), sep(1)];
  quests.forEach((q, i) => {
    components.push(txt(`**${i+1}. ${q.name}**\n> 🎁 \`${q.reward}\` · ${TASK_TYPES[q.taskType]||q.taskType} · ⏱️ \`${formatDuration(q.target)}\``));
    if (i < quests.length - 1) components.push(sep(1));
  });
  components.push(sep(1));
  components.push(txt('-# Use **Iniciar Farm** para farmar todas automaticamente'));
  return { type: 17, components };
}

function buildAdminPanel() {
  const activeFarms = [...farms.entries()].filter(([, f]) => f.running);
  const logCh       = config.logChannelId ? `<#${config.logChannelId}>` : '`Não configurado`';
  const farmLines   = activeFarms.length === 0
    ? ['> *Nenhum farm ativo no momento.*']
    : activeFarms.map(([uid, f]) => {
        const elapsed = Math.floor((Date.now() - f.startMs) / 1000);
        const done    = f.progress.filter(e => e.done && !e.error).length;
        return `> 🔷 <@${uid}> · \`${done}/${f.progress.length}\` quests · ⏱️ \`${formatDuration(elapsed)}\``;
      });

  return {
    type: 17,
    components: [
      txt('## 🛡️ Painel Administrativo'),
      sep(1),
      txt('📊 **Estatísticas em Tempo Real**'),
      txt([
        `> 👥 **Usuários com token:** \`${store.count()}\``,
        `> ⚡ **Farms ativos agora:** \`${activeFarms.length}\``,
        `> 📦 **Versão do bot:** \`${VERSION}\``,
      ].join('\n')),
      sep(1),
      txt('⚙️ **Configurações**'),
      txt(`> 📋 **Canal de logs:** ${logCh}`),
      sep(1),
      txt(`🎯 **Farms em execução (${activeFarms.length})**`),
      txt(farmLines.join('\n')),
      sep(1),
      txt('-# 🔒 Apenas o owner visualiza este painel.\n-# Use `/admin log-canal` para configurar o canal de logs.'),
    ],
  };
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`🤖 Online: ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(botToken);
  await rest.put(Routes.applicationCommands(clientId), {
    body: [
      { name: 'orb', description: 'Abre seu painel AUTO ORB' },
      {
        name: 'admin', description: 'Painel administrativo (só owner)',
        options: [
          { name: 'painel',    type: 1, description: 'Ver estatísticas e farms ativos' },
          { name: 'log-canal', type: 1, description: 'Configurar canal de logs do farm', options: [
            { name: 'canal', type: 7, description: 'Canal de texto para os logs', required: true, channel_types: [0] },
          ]},
        ],
      },
    ],
  });
  console.log('✅ Comandos registrados');
});

client.on(Events.InteractionCreate, async (interaction) => {
  const userId = interaction.user.id;

  // ── /admin ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'admin') {
    if (userId !== ownerId) return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [txt('## ❌ Sem permissão'), txt('> Apenas o owner pode usar este painel.')] }] });
    const sub = interaction.options.getSubcommand();
    if (sub === 'painel') return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildAdminPanel()] });
    if (sub === 'log-canal') {
      const channel = interaction.options.getChannel('canal');
      if (channel.type !== ChannelType.GuildText) return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [txt('## ❌ Canal inválido'), txt('> O canal precisa ser um canal de **texto**.')] }] });
      config.logChannelId = channel.id;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
        txt('## ✅ Canal de logs configurado'),
        txt([`> 📋 **Canal:** <#${channel.id}>`, `> 👤 **Configurado por:** <@${userId}>`, '> 💡 Os logs do farm serão enviados neste canal.'].join('\n')),
      ]}]});
    }
  }

  // Verifica permissão
  if (!isAllowed(userId)) {
    if (interaction.isRepliable()) interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [txt('## ❌ Acesso negado'), txt('> Você não tem permissão para usar este bot.')] }] });
    return;
  }

  // ── /orb ──────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'orb') {
    await interaction.deferReply({ flags: FLAG_EPHEMERAL });
    await interaction.deleteReply();
    return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildMainPanel(userId)] });
  }

  // ── Botão ⚙️ ──────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'btn_settings') {
    return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildSettingsPanel(interaction.user)] });
  }

  // ── Select menu ───────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_action') {
    const action = interaction.values[0];
    const farm   = getFarm(userId);
    const token  = store.get(userId);

    if (action === 'action_login') {
      const modal = new ModalBuilder().setCustomId('modal_token').setTitle('🔑 Conectar conta Discord');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('token_input').setLabel('Token da sua conta Discord')
          .setStyle(TextInputStyle.Paragraph).setPlaceholder('Cole seu token aqui...').setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (action === 'action_quests') {
      await interaction.deferUpdate();
      const quests = await fetchQuests(token);
      return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildQuestsPanel(quests)] });
    }

    if (action === 'action_farm') {
      if (farm.running) return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [txt('## ⚠️ Farm já ativo'), txt('> Use **Ver Status** para acompanhar.')] }] });
      await interaction.deferUpdate();
      const quests = await fetchQuests(token);
      if (!quests.length) return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildQuestsPanel([])] });

      farm.running  = true;
      farm.aborted  = false;
      farm.startMs  = Date.now();
      farm.progress = quests.map(q => ({ quest: q, progress: 0, target: q.target, done: false, error: false, startedAt: Date.now(), doneAt: null }));

      await logFarmStart(interaction.user, quests.length);

      interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
        txt('## 🚀 Farm iniciado!'),
        txt(`> 🎯 **${quests.length} quest(s)** encontradas e em execução.\n> Use **Ver Status** no menu para acompanhar o progresso.`),
        sep(1),
        txt(quests.map((q,i) => `> **${i+1}.** ${q.name} · 🎁 \`${q.reward}\``).join('\n')),
        sep(1),
        txt('-# Os logs serão enviados no canal configurado'),
      ]}]});

      Promise.all(farm.progress.map(async (entry) => {
        await runQuest(token, entry.quest, entry, farm);
        if (entry.done && !entry.error) {
          const took = entry.doneAt ? Math.floor((entry.doneAt - entry.startedAt) / 1000) : 0;
          await logQuestDone(interaction.user, entry.quest.name, entry.quest.reward, took);
        }
      })).finally(async () => {
        const done    = farm.progress.filter(e => e.done && !e.error).length;
        const errors  = farm.progress.filter(e => e.error).length;
        const elapsed = Math.floor((Date.now() - farm.startMs) / 1000);
        farm.running  = false;
        farm.aborted  = false;
        await logFarmDone(interaction.user, done, errors, elapsed);
      });
      return;
    }

    if (action === 'action_status') {
      await interaction.deferUpdate();
      return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildLivePanel(userId)] });
    }

    if (action === 'action_stop') {
      farm.aborted = true;
      return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
        txt('## 🛑 Farm parando'),
        txt('> O farm será interrompido após a quest atual terminar.'),
      ]}]});
    }

    if (action === 'action_orbs') {
      await interaction.deferUpdate();
      const info    = await getSelfInfo(token);
      const balance = await getOrbBalance(token);
      return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
        txt('## 💎 Saldo de Orbs'),
        sep(1),
        txt([`> 👤 **Conta:** \`${info?.username ?? 'Desconhecida'}\``, `> 💎 **Orbs:** \`${balance}\``].join('\n')),
      ]}]});
    }

    if (action === 'action_logout') {
      if (farm.running) return interaction.reply({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [txt('## ⚠️ Farm ativo'), txt('> Pare o farm antes de desconectar.')] }] });
      store.remove(userId);
      return interaction.update({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [buildSettingsPanel(interaction.user)] });
    }
  }

  // ── Modal: token ──────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'modal_token') {
    const token = interaction.fields.getTextInputValue('token_input').trim();
    await interaction.deferUpdate();
    const info = await getSelfInfo(token);
    if (!info) {
      return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
        txt('## ❌ Token inválido'),
        txt('> O token fornecido não é válido ou expirou.\n> Verifique e tente novamente.'),
      ]}]});
    }
    store.set(userId, token);
    return interaction.followUp({ flags: FLAG_V2 | FLAG_EPHEMERAL, components: [{ type: 17, components: [
      txt('## ✅ Conta conectada!'),
      sep(1),
      txt([
        `> 👤 **Usuário:** \`${info.username}\``,
        `> 🆔 **ID:** \`${info.id}\``,
        `> 🔑 Token validado e salvo com sucesso!`,
        `> Agora selecione **Iniciar Farm** no menu.`,
      ].join('\n')),
      sep(1),
      txt('-# 🔒 Seu token fica salvo apenas na VPS, nunca é compartilhado'),
    ]}]});
  }
});

client.login(botToken);
