// © Author: aliyie
// https://discord.gg/aerox

// Minimal discord.js bot example that uses the Dlp Wrapper.
//
// Setup:
//   1. cd examples/discord-bot
//   2. npm install discord.js
//   3. Set DISCORD_TOKEN and (optional) DLP_WRAPPER_KEY
//   4. Set DLP_WRAPPER_BASE to your hosted API URL (default: http://localhost:8080/api)
//   5. node bot.mjs
//
// In Discord, send a message containing any yt-dlp-supported URL. The bot
// replies with a direct stream link and embeds the metadata. Use the
// /download slash command to fetch the actual file as an attachment.

import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';

const DLP_WRAPPER_BASE = process.env.DLP_WRAPPER_BASE ?? 'http://localhost:8080/api';
const DLP_WRAPPER_KEY = process.env.DLP_WRAPPER_KEY ?? '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN env var required');
  process.exit(1);
}

const URL_REGEX = /https?:\/\/\S+/;
const SIZE_LIMIT = 25 * 1024 * 1024; // Discord's free-tier upload limit (Nitro: 50MB)

function dlpHeaders() {
  const h = {};
  if (DLP_WRAPPER_KEY) h['x-api-key'] = DLP_WRAPPER_KEY;
  return h;
}

// Errors carry { error, code, hint } — the hint is usually the actionable
// half ("add cookies for this site", "retry with allowLive=true").
async function dlpError(r, label) {
  const { error, code, hint } = await r.json().catch(() => ({}));
  const parts = [error || `${label}: HTTP ${r.status}`];
  if (hint) parts.push(`(${hint})`);
  const err = new Error(parts.join(' '));
  err.code = code;
  return err;
}

async function dlpInfo(url) {
  const r = await fetch(`${DLP_WRAPPER_BASE}/media/info?url=${encodeURIComponent(url)}`, { headers: dlpHeaders() });
  if (!r.ok) throw await dlpError(r, 'info');
  return r.json();
}

// Omitting `format` lets the API pick a selector that resolves on any kind
// of source (muxed file, split streams, audio-only, HLS).
async function dlpDirect(url, format = '') {
  const qs = new URLSearchParams({ url, ...(format ? { format } : {}) });
  const r = await fetch(`${DLP_WRAPPER_BASE}/media/direct-url?${qs}`, { headers: dlpHeaders() });
  if (!r.ok) throw await dlpError(r, 'direct');
  return r.json();
}

async function dlpDownload(url, ext) {
  const r = await fetch(`${DLP_WRAPPER_BASE}/media/download?url=${encodeURIComponent(url)}&ext=${ext}`, { headers: dlpHeaders() });
  if (!r.ok) throw await dlpError(r, 'download');
  // Prefer the RFC 6266 form so non-ASCII titles survive.
  const disposition = r.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const filename = encoded
    ? decodeURIComponent(encoded)
    : (disposition.match(/filename="(.+?)"/)?.[1] ?? `media.${ext}`);
  return {
    filename,
    contentType: r.headers.get('content-type'),
    buffer: Buffer.from(await r.arrayBuffer()),
  };
}

function buildEmbed(info) {
  return new EmbedBuilder()
    .setTitle(info.title ?? 'Untitled')
    .setURL(info.webpageUrl ?? undefined)
    .setDescription(info.description?.slice(0, 300) ?? null)
    .setThumbnail(info.thumbnail ?? null)
    .addFields(
      { name: 'Uploader', value: info.uploader ?? '—', inline: true },
      {
        name: 'Duration',
        value:
          info.durationSeconds != null
            ? `${Math.round(info.durationSeconds)}s`
            : '—',
        inline: true,
      },
      {
        name: 'Formats',
        value: String(info.formats?.length ?? 0),
        inline: true,
      },
    );
}

// ---------------- bot ------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Register slash commands globally. For faster updates during dev, swap
  // Routes.applicationGuildCommands with your guild id and Routes.applicationCommands.
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName('download')
      .setDescription('Download media via Dlp Wrapper and attach it to the message')
      .addStringOption((o) =>
        o.setName('url').setDescription('Source URL').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('ext')
          .setDescription('Output format')
          .setRequired(true)
          .addChoices(
            { name: 'mp4 (video)', value: 'mp4' },
            { name: 'mp3 (audio only)', value: 'mp3' },
          ),
      )
      .toJSON(),
  ];
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log('Slash commands registered');
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;
  const match = message.content.match(URL_REGEX);
  if (!match) return;

  const url = match[0];
  await message.channel.sendTyping();
  try {
    const [info, direct] = await Promise.all([dlpInfo(url), dlpDirect(url)]);
    await message.reply({
      embeds: [buildEmbed(info)],
      // HLS/DASH manifests and split video+audio can't be embedded as a
      // plain link — fall back to telling the user to use /download.
      content: direct.streams?.[0]?.isManifest || direct.requiresMerge
        ? `**Direct stream**: ${direct.urls[0]}\n_(this is a ${direct.requiresMerge ? 'split video+audio' : 'live/HLS'} source — use the download command for a single playable file)_`
        : `**Direct stream** (no proxy): ${direct.urls[0]}`,
    });
  } catch (err) {
    await message.reply({ content: `Couldn't fetch that: ${err.message}`, flags: MessageFlags.SuppressEmbeds });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'download') return;
  const url = interaction.options.getString('url', true);
  const ext = interaction.options.getString('ext', true);

  await interaction.deferReply();
  try {
    const { filename, contentType, buffer } = await dlpDownload(url, ext);
    if (buffer.length > SIZE_LIMIT) {
      await interaction.editReply(
        `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — over Discord's upload limit. Use \`/link\` for the direct URL instead.`,
      );
      return;
    }
    const attachment = new AttachmentBuilder(buffer, { name: filename });
    await interaction.editReply({ content: `${filename} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`, files: [attachment] });
  } catch (err) {
    await interaction.editReply(`Download failed: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
