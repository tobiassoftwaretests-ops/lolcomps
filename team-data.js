'use strict';
// ── UIC team champion pools ───────────────────────────────────────────────────
// One entry per PLAYER (the app groups them by role and lets you pick which
// player is active per role). Built from the team-internal tierlists
// (S → A → B → TBD) plus op.gg season stats (Season 2026, EUW, 2026-07-09).
// op.gg-backed champions are assigned to the player who actually plays them;
// tierlist champs that could not be attributed appear for both players.

const TEAM_DATA = [
  // ── TOP ─────────────────────────────────────────────────────────────────
  {
    name: 'Kaetaya',
    role: 'top',
    rawChamps: [
      'TahmKench', 'Shen', 'Sion', 'Mordekaiser', 'Urgot', 'DrMundo',
      'Pantheon', 'Swain', 'Renekton', 'Skarner',
      // tierlist, not attributable
      'KSante', 'Gwen',
    ],
  },
  {
    name: 'Muh',
    role: 'top',
    rawChamps: [
      'Ambessa', 'Rumble', 'Ornn', 'Lissandra', 'Zaahen', 'Sion',
      'Trundle', 'Jax',
      // tierlist, not attributable
      'KSante', 'Gwen',
    ],
  },

  // ── JUNGLE ──────────────────────────────────────────────────────────────
  {
    name: 'Namorii',
    role: 'jungle',
    rawChamps: [
      'Shyvana', 'LeeSin', 'Viego', 'JarvanIV', 'Diana', 'Karthus',
      'Gragas', 'Nocturne',
    ],
  },
  {
    // op.gg profile not found – pool guessed from the jungle tierlist
    // (everything that isn't Namorii's op.gg pool)
    name: 'GreatATuin',
    role: 'jungle',
    rawChamps: [
      'Khazix', 'MasterYi', 'Vi', 'Sejuani', 'Nidalee', 'Evelynn', 'Zed',
      'Amumu', 'Poppy', 'DrMundo', 'Maokai', 'Udyr', 'Briar', 'Lillia',
      'XinZhao',
    ],
  },

  // ── MID ─────────────────────────────────────────────────────────────────
  {
    name: 'adedier',
    role: 'mid',
    rawChamps: [
      // S
      'Akali', 'Syndra', 'Ryze', 'Kassadin', 'Hwei',
      // A
      'Anivia', 'Ahri', 'Taliyah', 'Ekko', 'Corki', 'Brand', 'Qiyana',
      'Seraphine',
      // B
      'Lissandra', 'Lux', 'Cassiopeia', 'AurelionSol', 'Yone',
      // C
      'Azir', 'Viktor', 'Leblanc', 'TwistedFate', 'Velkoz', 'Aurora',
      // op.gg
      'Orianna',
    ],
  },

  // ── BOT ─────────────────────────────────────────────────────────────────
  {
    name: 'Deavan',
    role: 'bot',
    rawChamps: [
      'Aphelios', 'Ashe', 'Jinx', 'Smolder', 'Samira', 'Lucian',
      // tierlist, not attributable
      'Kaisa', 'Xayah', 'Senna', 'Draven', 'KogMaw', 'Ezreal',
    ],
  },
  {
    name: 'Boohunter',
    role: 'bot',
    rawChamps: [
      'Twitch', 'Jinx', 'Caitlyn', 'Varus', 'Aphelios', 'Mel', 'Vayne',
      'Ashe', 'MissFortune', 'Jhin',
      // tierlist, not attributable
      'Kaisa', 'Xayah', 'Senna', 'Draven', 'KogMaw', 'Ezreal',
    ],
  },

  // ── SUPPORT ─────────────────────────────────────────────────────────────
  {
    name: 'Kaanto',
    role: 'support',
    rawChamps: [
      'Sona', 'Renata', 'Mel', 'Lulu', 'Neeko', 'Nami', 'Seraphine',
      'Galio', 'Yuumi', 'Rell', 'Maokai',
      // tierlist, not attributable
      'Alistar', 'Lux', 'Zyra', 'Thresh',
    ],
  },
  {
    name: 'Excellent C',
    role: 'support',
    rawChamps: [
      'Nami', 'Karma', 'Lulu', 'Morgana', 'Seraphine', 'Leona', 'Nautilus',
      'Milio', 'Braum', 'Janna', 'Sona', 'Rakan',
      // tierlist, not attributable
      'Alistar', 'Lux', 'Zyra', 'Thresh',
    ],
  },
];
